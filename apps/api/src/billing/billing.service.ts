import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class BillingService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async list(orgId: string, filters: { monthKey?: string; toolId?: string; status?: string }) {
    const where: any = { orgId };
    if (filters.monthKey) where.monthKey = filters.monthKey;
    if (filters.toolId) where.toolId = filters.toolId;
    if (filters.status) where.status = filters.status;

    return this.prisma.billingRecord.findMany({
      where,
      include: {
        tool: { select: { id: true, name: true, monoInitials: true, monoBgColor: true } },
      },
      orderBy: [{ monthKey: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(orgId: string, actorId: string, dto: {
    toolId: string;
    monthKey: string;
    amount: number;
  }) {
    const tool = await this.prisma.tool.findFirst({ where: { id: dto.toolId, orgId } });
    if (!tool) throw new NotFoundException('Tool not found');

    const monthLabel = this.formatMonthLabel(dto.monthKey);

    const record = await this.prisma.billingRecord.create({
      data: {
        orgId,
        toolId: dto.toolId,
        toolSnapshotJson: { name: tool.name, vendor: tool.vendor, category: tool.category },
        monthKey: dto.monthKey,
        monthLabel,
        amount: dto.amount,
        status: 'PENDING',
      },
    });

    await this.audit.log(orgId, actorId, 'billing.created', 'BillingRecord', record.id, null, record);
    return record;
  }

  /**
   * Auto-logs a completed billing period as PAID - called by the scheduler either when a
   * subscription's renewal date rolls over, or when a usage-based integrated tool's
   * calendar month closes (see SchedulerService.rollForwardRenewalDates and
   * .recordCompletedMonthUsageBilling). Idempotent: the (orgId, toolId, monthKey) unique
   * constraint means a re-run for the same period is silently ignored, not double-billed.
   */
  async recordCompletedCycle(orgId: string, toolId: string, monthKey: string, amount: number, billedAt: Date) {
    const tool = await this.prisma.tool.findFirst({ where: { id: toolId, orgId } });
    if (!tool) return null;

    try {
      return await this.prisma.billingRecord.create({
        data: {
          orgId,
          toolId,
          toolSnapshotJson: { name: tool.name, vendor: tool.vendor, category: tool.category },
          monthKey,
          monthLabel: this.formatMonthLabel(monthKey),
          amount,
          status: 'PAID',
          paidAt: billedAt,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null; // already recorded for this tool+month
      throw err;
    }
  }

  async markPaid(id: string, orgId: string, actorId: string) {
    const record = await this.prisma.billingRecord.findFirst({ where: { id, orgId } });
    if (!record) throw new NotFoundException('Billing record not found');

    const updated = await this.prisma.billingRecord.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date(), paidByUserId: actorId },
    });

    await this.audit.log(orgId, actorId, 'billing.marked_paid', 'BillingRecord', id, record, updated);
    return updated;
  }

  async monthSummary(orgId: string) {
    const records = await this.prisma.billingRecord.groupBy({
      by: ['monthKey'],
      where: { orgId },
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { monthKey: 'desc' },
      take: 12,
    });

    const summary = records.map((r) => ({
      monthKey: r.monthKey,
      monthLabel: this.formatMonthLabel(r.monthKey),
      total: r._sum.amount || 0,
      count: r._count.id,
    }));

    // The current month is not billed yet, so it has no records. Derive its
    // total from live tool spend so the month filter reflects current usage.
    const currentMonth = new Date().toISOString().slice(0, 7);
    const tools = await this.prisma.tool.findMany({
      where: { orgId, deletedAt: null, paymentKind: { not: 'NOBUDGET' } },
      select: { paymentKind: true, usedAmount: true, monthlyAmount: true },
    });

    let liveTotal = 0;
    let liveCount = 0;
    for (const t of tools) {
      const usageBased = t.paymentKind === 'PREPAID' || t.paymentKind === 'CAPSUB';
      const amount = (usageBased ? t.usedAmount : t.monthlyAmount) || 0;
      if (amount > 0) {
        liveTotal += amount;
        liveCount++;
      }
    }

    if (liveTotal > 0) {
      const withoutCurrent = summary.filter((s) => s.monthKey !== currentMonth);
      return [
        { monthKey: currentMonth, monthLabel: this.formatMonthLabel(currentMonth), total: liveTotal, count: liveCount },
        ...withoutCurrent,
      ];
    }

    return summary;
  }

  private formatMonthLabel(monthKey: string): string {
    const [year, month] = monthKey.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(month) - 1]} ${year}`;
  }
}
