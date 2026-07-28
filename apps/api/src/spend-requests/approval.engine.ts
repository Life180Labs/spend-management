import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetEngine } from '../budgets/budget.engine';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ApprovalEngine {
  constructor(
    private prisma: PrismaService,
    private budget: BudgetEngine,
    private notifications: NotificationsService,
  ) { }

  async submit(requestId: string, actorId: string) {
    const req = await this.getRequest(requestId);
    if (req.requesterId !== actorId) throw new ForbiddenException();
    if (!['DRAFT'].includes(req.status)) {
      throw new BadRequestException(`Cannot submit from status ${req.status}`);
    }

    // Find matching workflow
    const workflow = await this.resolveWorkflow(req);

    // Reserve budget if a workflow exists
    if (workflow) {
      const budget = await this.budget.findBestBudget(
        req.orgId, req.departmentId, req.toolId, new Date(),
      );
      if (budget) {
        const reserved = await this.budget.reserve(budget.id, req.estimatedAmount);
        if (!reserved) {
          throw new BadRequestException('Insufficient budget available for this request');
        }
      }
    }

    const updated = await this.prisma.spendRequest.update({
      where: { id: requestId },
      data: {
        status: workflow ? 'PENDING_APPROVAL' : 'APPROVED',
        workflowId: workflow?.id,
        currentStepIndex: 0,
      },
    });

    if (workflow) {
      await this.notifyNextApprover(updated, workflow, 0);
    } else {
      // Auto-approve (no workflow configured)
      await this.finalizeApproval(requestId, req.orgId, req.departmentId, req.toolId, req.estimatedAmount);
    }

    return updated;
  }

  async approve(requestId: string, approverId: string, comment: string, approvedAmount?: number) {
    const req = await this.getRequest(requestId);
    if (req.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Request is not pending approval');
    }

    const workflow = await this.prisma.approvalWorkflow.findUnique({
      where: { id: req.workflowId! },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!workflow) throw new BadRequestException('No workflow found');

    const step = workflow.steps[req.currentStepIndex];
    if (!step) throw new BadRequestException('No active step found');

    // Verify approver is authorized for this step
    await this.assertApproverAuthorized(step, approverId, req);

    await this.prisma.approvalAction.create({
      data: {
        spendRequestId: requestId,
        stepId: step.id,
        approverId,
        action: 'APPROVED',
        comment,
        approvedAmount: approvedAmount ?? req.estimatedAmount,
      },
    });

    const isLastStep = req.currentStepIndex >= workflow.steps.length - 1;

    if (isLastStep) {
      await this.prisma.spendRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', closedAt: new Date() },
      });
      await this.finalizeApproval(requestId, req.orgId, req.departmentId, req.toolId, req.estimatedAmount);
      await this.notifications.notifyRequester(req, 'APPROVED');
    } else {
      await this.prisma.spendRequest.update({
        where: { id: requestId },
        data: { currentStepIndex: { increment: 1 } },
      });
      await this.notifyNextApprover(req, workflow, req.currentStepIndex + 1);
    }

    return this.getRequest(requestId);
  }

  async reject(requestId: string, approverId: string, comment: string) {
    const req = await this.getRequest(requestId);
    if (req.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Request is not pending approval');
    }

    const workflow = await this.prisma.approvalWorkflow.findUnique({
      where: { id: req.workflowId! },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    const step = workflow?.steps[req.currentStepIndex];
    if (!step) throw new BadRequestException('No active step found');

    await this.prisma.approvalAction.create({
      data: {
        spendRequestId: requestId,
        stepId: step.id,
        approverId,
        action: 'REJECTED',
        comment,
      },
    });

    await this.prisma.spendRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', closedAt: new Date() },
    });

    // Release budget reservation
    const budget = await this.budget.findBestBudget(
      req.orgId, req.departmentId, req.toolId, new Date(),
    );
    if (budget) await this.budget.release(budget.id, req.estimatedAmount);

    await this.notifications.notifyRequester(req, 'REJECTED');
    return this.getRequest(requestId);
  }

  async requestMoreInfo(requestId: string, approverId: string, comment: string) {
    const req = await this.getRequest(requestId);
    const workflow = await this.prisma.approvalWorkflow.findUnique({
      where: { id: req.workflowId! },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    const step = workflow?.steps[req.currentStepIndex];
    if (!step) throw new BadRequestException('No active step');

    await this.prisma.approvalAction.create({
      data: {
        spendRequestId: requestId,
        stepId: step.id,
        approverId,
        action: 'MORE_INFO',
        comment,
      },
    });

    await this.prisma.spendRequest.update({
      where: { id: requestId },
      data: { status: 'MORE_INFO_NEEDED' },
    });

    await this.notifications.notifyRequester(req, 'MORE_INFO_NEEDED');
    return this.getRequest(requestId);
  }

  private async getRequest(requestId: string) {
    const req = await this.prisma.spendRequest.findUnique({
      where: { id: requestId },
      include: { requester: { select: { id: true, email: true, name: true, orgId: true } } },
    });
    if (!req) throw new BadRequestException('Spend request not found');
    return req;
  }

  private async resolveWorkflow(req: any) {
    // Find the best-matching active workflow for this request
    return this.prisma.approvalWorkflow.findFirst({
      where: {
        orgId: req.orgId,
        isActive: true,
        OR: [
          { triggerType: 'amount_threshold', triggerValue: { lte: String(req.estimatedAmount) } },
          { triggerType: 'category', triggerValue: req.category },
          { triggerType: 'department', triggerValue: req.departmentId },
        ],
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async notifyNextApprover(req: any, workflow: any, stepIndex: number) {
    const step = workflow.steps[stepIndex];
    if (!step) return;

    let approverIds: string[] = [];

    if (step.approverType === 'USER' && step.approverId) {
      approverIds = [step.approverId];
    } else if (step.approverType === 'ROLE' && step.approverRole) {
      const members = await this.prisma.departmentMembership.findMany({
        where: { departmentId: req.departmentId, role: step.approverRole },
        select: { userId: true },
      });
      approverIds = members.map((m) => m.userId);
    } else if (step.approverType === 'MANAGER_OF_REQUESTER') {
      const dept = await this.prisma.department.findFirst({
        where: { id: req.departmentId },
        select: { ownerUserId: true },
      });
      if (dept?.ownerUserId) approverIds = [dept.ownerUserId];
    }

    for (const userId of approverIds) {
      await this.notifications.create({
        orgId: req.orgId,
        userId,
        type: 'THRESHOLD_BREACH',
        title: `Approval needed: ${req.title}`,
        body: `${req.requester?.name} has submitted a spend request for $${req.estimatedAmount.toLocaleString('en-US')}`,
        metadataJson: { requestId: req.id },
      });
    }
  }

  private async finalizeApproval(
    requestId: string, orgId: string,
    departmentId: string, toolId: string | null, amount: number,
  ) {
    const budget = await this.budget.findBestBudget(orgId, departmentId, toolId, new Date());
    if (budget) await this.budget.commit(budget.id, amount);
  }

  private async assertApproverAuthorized(step: any, approverId: string, req: any) {
    // For now: trust the approverId from JWT - RBAC enforcement on the controller layer
    // In production: verify approverId matches step.approverId or has step.approverRole
  }
}
