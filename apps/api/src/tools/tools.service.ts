import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import { CreateToolDto } from './dto/create-tool.dto';
import { UpdateToolDto } from './dto/update-tool.dto';

const MONO_COLORS = [
  '#5E6AD2', '#3FB950', '#F5A623', '#10A37F',
  '#E0529C', '#0EA5E9', '#8B5CF6',
];

// Payment kinds with no ongoing bar%/cap being tracked - NOBUDGET was never
// configured, ONETIME is a single past payment, not a budget accruing toward
// a limit. Neither can breach a threshold.
const UNBUDGETED_KINDS = ['NOBUDGET', 'ONETIME'];

@Injectable()
export class ToolsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private billing: BillingService,
  ) {}

  async create(orgId: string, actorId: string, dto: CreateToolDto) {
    const count = await this.prisma.tool.count({ where: { orgId } });
    const monoBg = MONO_COLORS[count % MONO_COLORS.length];
    const initials = dto.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'T';

    let tool: any;
    try {
    tool = await this.prisma.tool.create({
      data: {
        orgId,
        departmentId: dto.departmentId,
        name: dto.name,
        vendor: dto.vendor || '',
        category: (dto.category || 'OTHER') as any,
        paymentKind: (dto.paymentKind || 'NOBUDGET') as any,
        billingCycle: (dto.billingCycle || 'MONTHLY') as any,
        capAmount: dto.capAmount || 0,
        monthlyAmount: dto.monthlyAmount || 0,
        alertThresholdPct: dto.alertThresholdPct || 80,
        triggerEmail: dto.triggerEmail,
        // ONETIME never gets a renewalDate, regardless of what the caller sends -
        // checkRenewalRemindersImpl has no payment-kind filter of its own (see
        // docs/onetime-payment-kind-loop-prompt.md design decision 1), so a stray
        // renewalDate here would silently reintroduce the exact false "renewing
        // soon" email this payment kind exists to avoid. Enforced here rather than
        // trusted to the frontend never sending one.
        renewalDate: dto.paymentKind === 'ONETIME' ? undefined : (dto.renewalDate ? new Date(dto.renewalDate) : undefined),
        monoInitials: initials,
        monoBgColor: monoBg,
        alertConfigs: {
          create: {
            thresholdPct: dto.alertThresholdPct || 80,
            triggerEmail: dto.triggerEmail,
          },
        },
      },
    });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(`A tool named "${dto.name}" already exists in this workspace`);
      }
      throw err;
    }

    // ONETIME's amount+date is captured as a single billing_records row, not a
    // Tool column - reuses the exact idempotent method the rollover cron and
    // every manual backfill this session already use, rather than a second
    // insert path. renewalDate deliberately stays null for ONETIME (see
    // docs/onetime-payment-kind-loop-prompt.md) so this is the only place its
    // paid-date/amount is recorded at all.
    if (dto.paymentKind === 'ONETIME') {
      const paidAt = dto.oneTimePaidAt ? new Date(dto.oneTimePaidAt) : new Date();
      const monthKey = `${paidAt.getFullYear()}-${String(paidAt.getMonth() + 1).padStart(2, '0')}`;
      await this.billing.recordCompletedCycle(orgId, tool.id, monthKey, dto.monthlyAmount || 0, paidAt);
    }

    await this.audit.log(orgId, actorId, 'tool.created', 'Tool', tool.id, null, tool);
    return tool;
  }

  async list(orgId: string, filters: { category?: string; paymentKind?: string; hasAlert?: boolean }) {
    const where: any = { orgId, deletedAt: null };
    if (filters.category) where.category = filters.category;
    if (filters.paymentKind) where.paymentKind = filters.paymentKind;
    if (filters.hasAlert === true) where.barPct = { gte: where.alertThresholdPct };

    const tools = await this.prisma.tool.findMany({
      where,
      include: { alertConfigs: { where: { isActive: true } }, integration: { select: { provider: true, lastSyncAt: true, lastSyncAmountUSD: true, lastSyncBreakdown: true, lastSyncByProject: true, lastSyncRemainingBalanceUSD: true, isActive: true, lastError: true } } },
      orderBy: { name: 'asc' },
    });

    return tools.map((t) => this.enrichTool(t));
  }

  async findOne(id: string, orgId: string) {
    const tool = await this.prisma.tool.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { alertConfigs: true, department: { select: { id: true, name: true } } },
    });
    if (!tool) throw new NotFoundException('Tool not found');
    return this.enrichTool(tool);
  }

  async update(id: string, orgId: string, actorId: string, dto: UpdateToolDto) {
    const existing = await this.findOne(id, orgId);

    let updated: any;
    try {
      const newCap = dto.capAmount ?? existing.capAmount;
      const barPct = newCap > 0
        ? Math.min(100, Math.round((Number(existing.usedAmount) / newCap) * 100))
        : 0;

      updated = await this.prisma.tool.update({
        where: { id },
        data: {
          name: dto.name,
          vendor: dto.vendor,
          category: dto.category as any,
          paymentKind: dto.paymentKind as any,
          billingCycle: dto.billingCycle as any,
          capAmount: dto.capAmount,
          monthlyAmount: dto.monthlyAmount,
          alertThresholdPct: dto.alertThresholdPct,
          triggerEmail: dto.triggerEmail,
          renewalDate: dto.renewalDate ? new Date(dto.renewalDate) : undefined,
          barPct,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(`A tool named "${dto.name}" already exists in this workspace`);
      }
      throw err;
    }

    if (dto.alertThresholdPct !== undefined || dto.triggerEmail !== undefined) {
      await this.prisma.alertConfig.updateMany({
        where: { toolId: id },
        data: {
          thresholdPct: dto.alertThresholdPct,
          triggerEmail: dto.triggerEmail,
        },
      });
    }

    await this.audit.log(orgId, actorId, 'tool.updated', 'Tool', id, existing, updated);
    return this.enrichTool(updated);
  }

  async updateUsage(id: string, orgId: string, usedAmount: number) {
    const tool = await this.findOne(id, orgId);
    const barPct = tool.capAmount > 0 ? Math.round((usedAmount / tool.capAmount) * 100) : 0;

    return this.prisma.tool.update({
      where: { id },
      data: { usedAmount, barPct },
    });
  }

  async softDelete(id: string, orgId: string, actorId: string) {
    const tool = await this.findOne(id, orgId);
    const deleted = await this.prisma.tool.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    // Deactivate any live integration too - otherwise the 15-min sync cron keeps
    // polling the deleted tool's provider indefinitely (real bug found in testing).
    await this.prisma.toolIntegration.updateMany({
      where: { toolId: id },
      data: { isActive: false },
    });
    await this.audit.log(orgId, actorId, 'tool.deleted', 'Tool', id, tool, null);
    return deleted;
  }

  private enrichTool(tool: any) {
    const thresholdPct = tool.alertConfigs?.[0]?.thresholdPct ?? tool.alertThresholdPct ?? 80;
    // ONETIME has no ongoing bar%/threshold to breach - it's a single past
    // payment, not a budget being tracked toward a cap - same reasoning as
    // NOBUDGET's exclusion here.
    const alert = !UNBUDGETED_KINDS.includes(tool.paymentKind) && tool.barPct >= thresholdPct;

    // Clamped to 0 minimum, matching every other days-away calc in the codebase
    // (dashboardKpis' nearestRenewal, checkRenewalReminders) - a renewal date that
    // has passed but hasn't been rolled forward yet (daily cron runs once, at a
    // fixed time) should read "renews today," not a confusing negative count.
    const daysUntilRenewal = tool.renewalDate
      ? Math.max(0, Math.ceil((new Date(tool.renewalDate).getTime() - Date.now()) / 86400000))
      : null;

    return {
      ...tool,
      alert: alert || false,
      daysUntilRenewal,
      statusSub: this.buildStatusSub(tool),
    };
  }

  private buildStatusSub(tool: any): string {
    if (tool.paymentKind === 'PREPAID') return `${tool.barPct}% used`;
    if (tool.paymentKind === 'CAPSUB') return `${tool.barPct}% of cap`;
    if (tool.paymentKind === 'MOSUB') return `cycle ${tool.barPct}%`;
    if (tool.paymentKind === 'ONETIME') return 'One-time purchase';
    return 'No budget configured';
  }
}
