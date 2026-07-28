import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface CreateSpendRequestDto {
  title: string;
  description?: string;
  category?: string;
  vendorName?: string;
  estimatedAmount: number;
  currency?: string;
  businessJustification?: string;
  departmentId: string;
  toolId?: string;
}

@Injectable()
export class SpendRequestsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(orgId: string, requesterId: string, dto: CreateSpendRequestDto) {
    const req = await this.prisma.spendRequest.create({
      data: {
        orgId,
        requesterId,
        departmentId: dto.departmentId,
        toolId: dto.toolId,
        title: dto.title,
        description: dto.description || '',
        category: (dto.category as any) || 'OTHER',
        vendorName: dto.vendorName || '',
        estimatedAmount: dto.estimatedAmount,
        currency: (dto.currency as any) || 'USD',
        businessJustification: dto.businessJustification || '',
        status: 'DRAFT',
      },
    });
    await this.audit.log(orgId, requesterId, 'spend_request.created', 'SpendRequest', req.id, null, req);
    return req;
  }

  async list(orgId: string, filters: { status?: string; departmentId?: string; requesterId?: string }) {
    const where: any = { orgId };
    if (filters.status) where.status = filters.status;
    if (filters.departmentId) where.departmentId = filters.departmentId;
    if (filters.requesterId) where.requesterId = filters.requesterId;

    return this.prisma.spendRequest.findMany({
      where,
      include: {
        requester: { select: { id: true, name: true, email: true, initials: true } },
        department: { select: { id: true, name: true } },
        _count: { select: { attachments: true, comments: true, actions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, orgId: string) {
    const req = await this.prisma.spendRequest.findFirst({
      where: { id, orgId },
      include: {
        requester: { select: { id: true, name: true, email: true, initials: true } },
        department: { select: { id: true, name: true } },
        tool: { select: { id: true, name: true } },
        attachments: true,
        comments: {
          where: { deletedAt: null },
          include: { author: { select: { id: true, name: true, initials: true } } },
          orderBy: { createdAt: 'asc' },
        },
        actions: {
          include: { approver: { select: { id: true, name: true, initials: true } } },
          orderBy: { createdAt: 'asc' },
        },
        workflow: { include: { steps: { orderBy: { stepOrder: 'asc' } } } },
      },
    });
    if (!req) throw new NotFoundException('Spend request not found');
    return req;
  }

  async update(id: string, orgId: string, actorId: string, dto: Partial<CreateSpendRequestDto>) {
    const req = await this.findById(id, orgId);
    if (req.requesterId !== actorId) throw new ForbiddenException();
    if (!['DRAFT', 'MORE_INFO_NEEDED'].includes(req.status)) {
      throw new ForbiddenException('Cannot edit a request in this state');
    }
    return this.prisma.spendRequest.update({
      where: { id },
      data: { ...dto, status: 'DRAFT' } as any,
    });
  }

  async cancel(id: string, orgId: string, actorId: string) {
    const req = await this.findById(id, orgId);
    if (req.requesterId !== actorId) throw new ForbiddenException();
    if (!['DRAFT', 'SUBMITTED'].includes(req.status)) {
      throw new ForbiddenException('Cannot cancel request in this state');
    }
    return this.prisma.spendRequest.update({
      where: { id },
      data: { status: 'CANCELLED', closedAt: new Date() },
    });
  }

  async createRevision(id: string, orgId: string, actorId: string) {
    const original = await this.findById(id, orgId);
    if (original.requesterId !== actorId) throw new ForbiddenException();
    if (original.status !== 'REJECTED') {
      throw new ForbiddenException('Can only revise rejected requests');
    }

    return this.prisma.spendRequest.create({
      data: {
        orgId,
        requesterId: actorId,
        departmentId: original.departmentId,
        toolId: original.toolId,
        title: original.title,
        description: original.description,
        category: original.category,
        vendorName: original.vendorName,
        estimatedAmount: original.estimatedAmount,
        currency: original.currency,
        businessJustification: original.businessJustification,
        status: 'DRAFT',
        revisionOfId: id,
      },
    });
  }

  async addComment(requestId: string, orgId: string, authorId: string, body: string) {
    await this.findById(requestId, orgId);
    return this.prisma.comment.create({
      data: { spendRequestId: requestId, authorId, body },
    });
  }
}
