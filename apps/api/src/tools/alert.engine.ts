import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AlertEngine {
  constructor(private prisma: PrismaService) { }

  // Called after tool usage is updated - check and fire alerts
  async evaluateThreshold(toolId: string): Promise<boolean> {
    const tool = await this.prisma.tool.findUnique({
      where: { id: toolId },
      include: { alertConfigs: { where: { isActive: true } } },
    });
    if (!tool || !tool.alertConfigs.length) return false;

    const config = tool.alertConfigs[0];
    if (tool.barPct >= config.thresholdPct) {
      // Create in-app notification for org admins
      const admins = await this.prisma.departmentMembership.findMany({
        where: { role: { in: ['ADMIN', 'FINANCE'] } },
        select: { userId: true },
        distinct: ['userId'],
      });

      await this.prisma.notification.createMany({
        data: admins.map((m) => ({
          orgId: tool.orgId,
          userId: m.userId,
          type: 'THRESHOLD_BREACH',
          title: `${tool.name} at ${tool.barPct}%`,
          body: `${tool.name} has reached ${tool.barPct}% of its budget cap (threshold: ${config.thresholdPct}%).`,
          metadataJson: { toolId: tool.id, barPct: tool.barPct, thresholdPct: config.thresholdPct },
        })),
        skipDuplicates: true,
      });

      return true;
    }
    return false;
  }

  // Scan all tools in an org for upcoming renewals
  async checkRenewals(orgId: string, warningDays = 7): Promise<any[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + warningDays);

    return this.prisma.tool.findMany({
      where: {
        orgId,
        deletedAt: null,
        renewalDate: { lte: cutoff, gte: new Date() },
      },
    });
  }

  // Find tools with no budget configured
  async findNoBudgetTools(orgId: string) {
    return this.prisma.tool.findMany({
      where: { orgId, deletedAt: null, paymentKind: 'NOBUDGET' },
    });
  }
}
