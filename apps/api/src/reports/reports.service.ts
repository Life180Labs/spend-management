import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { monthlyEquivalentSpend } from '../tools/spend-math.util';

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month) - 1]} ${year}`;
}

// Shape mirrors a BillingRecord (+ included tool) so the frontend can treat
// live and historical rows identically.
export interface SpendRow {
  id: string;
  toolId: string | null;
  monthKey: string;
  monthLabel: string;
  amount: number;
  status: 'PAID' | 'PENDING';
  tool: { name: string; monoInitials: string; monoBgColor: string; category: string } | null;
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Synthesises billing-record-shaped rows from live tool spend for the
   * current month. No billing records are written until a month closes, so
   * without this the Reports screen would be empty for the active period.
   */
  private async currentMonthLiveRows(orgId: string): Promise<SpendRow[]> {
    const monthKey = currentMonthKey();
    const monthLabel = formatMonthLabel(monthKey);

    const tools = await this.prisma.tool.findMany({
      where: { orgId, deletedAt: null, paymentKind: { not: 'NOBUDGET' } },
      select: {
        id: true, name: true, category: true, monoInitials: true,
        monoBgColor: true, paymentKind: true, billingCycle: true, usedAmount: true, monthlyAmount: true,
      },
    });

    return tools
      .map((t): SpendRow => {
        const amount = monthlyEquivalentSpend(t);
        return {
          id: `live-${t.id}`,
          toolId: t.id,
          monthKey,
          monthLabel,
          amount,
          status: 'PENDING',
          tool: {
            name: t.name,
            monoInitials: t.monoInitials,
            monoBgColor: t.monoBgColor,
            category: t.category,
          },
        };
      })
      .filter((r) => r.amount > 0);
  }

  async spendByCategory(orgId: string, monthKey?: string) {
    const targetMonth = monthKey || currentMonthKey();

    let rows: SpendRow[];
    if (targetMonth === currentMonthKey()) {
      rows = await this.currentMonthLiveRows(orgId);
    } else {
      const records = await this.prisma.billingRecord.findMany({
        where: { orgId, monthKey: targetMonth },
        include: { tool: { select: { category: true, name: true, monoInitials: true, monoBgColor: true } } },
      });
      rows = records.map((r) => ({
        id: r.id,
        toolId: r.toolId,
        monthKey: r.monthKey,
        monthLabel: r.monthLabel,
        amount: r.amount,
        status: r.status as 'PAID' | 'PENDING',
        tool: r.tool
          ? { name: r.tool.name, monoInitials: r.tool.monoInitials, monoBgColor: r.tool.monoBgColor, category: r.tool.category }
          : { name: (r.toolSnapshotJson as any)?.name || 'Deleted tool', monoInitials: '?', monoBgColor: '#5E6AD2', category: (r.toolSnapshotJson as any)?.category || 'OTHER' },
      }));
    }

    const grouped: Record<string, { category: string; total: number; count: number }> = {};
    let grandTotal = 0;

    for (const r of rows) {
      const cat = r.tool?.category || 'OTHER';
      if (!grouped[cat]) grouped[cat] = { category: cat, total: 0, count: 0 };
      grouped[cat].total += r.amount;
      grouped[cat].count++;
      grandTotal += r.amount;
    }

    return Object.values(grouped)
      .sort((a, b) => b.total - a.total)
      .map((g) => ({
        ...g,
        pct: grandTotal > 0 ? Math.round((g.total / grandTotal) * 100) : 0,
      }));
  }

  async spendByDepartment(orgId: string, monthKey?: string) {
    const tools = await this.prisma.tool.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, departmentId: true, department: { select: { name: true } } },
    });

    const toolDeptMap = new Map(tools.map((t) => [t.id, { deptId: t.departmentId, deptName: t.department?.name }]));

    const where: any = { orgId };
    if (monthKey) where.monthKey = monthKey;

    const records = await this.prisma.billingRecord.findMany({ where });

    const grouped: Record<string, { department: string; total: number }> = {};
    for (const r of records) {
      if (!r.toolId) continue;
      const dept = toolDeptMap.get(r.toolId);
      const key = dept?.deptId || 'unknown';
      const name = dept?.deptName || 'Unknown';
      if (!grouped[key]) grouped[key] = { department: name, total: 0 };
      grouped[key].total += r.amount;
    }

    return Object.values(grouped);
  }

  async billingHistory(orgId: string, filters: { monthKey?: string; toolId?: string; status?: string; page?: number; limit?: number }) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const currentMonth = currentMonthKey();

    // Live current-month rows (synthesised from tool spend) + historical
    // billing records for every prior month. Excluding the current month from
    // the DB query prevents double-counting once a real record exists for it.
    const live = await this.currentMonthLiveRows(orgId);

    const dbRecords = await this.prisma.billingRecord.findMany({
      where: { orgId, monthKey: { not: currentMonth } },
      include: { tool: { select: { name: true, monoInitials: true, monoBgColor: true, category: true } } },
      orderBy: [{ monthKey: 'desc' }],
    });

    const historical: SpendRow[] = dbRecords.map((r) => ({
      id: r.id,
      toolId: r.toolId,
      monthKey: r.monthKey,
      monthLabel: r.monthLabel,
      amount: r.amount,
      status: r.status as 'PAID' | 'PENDING',
      tool: r.tool
        ? { name: r.tool.name, monoInitials: r.tool.monoInitials, monoBgColor: r.tool.monoBgColor, category: r.tool.category }
        : { name: (r.toolSnapshotJson as any)?.name || 'Deleted tool', monoInitials: '?', monoBgColor: '#5E6AD2', category: (r.toolSnapshotJson as any)?.category || 'OTHER' },
    }));

    let all = [...live, ...historical];
    if (filters.monthKey) all = all.filter((r) => r.monthKey === filters.monthKey);
    if (filters.toolId) all = all.filter((r) => r.toolId === filters.toolId);
    if (filters.status) all = all.filter((r) => r.status === filters.status);

    const total = all.length;
    const items = all.slice((page - 1) * limit, page * limit);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async approvalSla(orgId: string) {
    // Average hours between request.submitted and final approval action
    const actions = await this.prisma.approvalAction.findMany({
      where: {
        action: { in: ['APPROVED', 'REJECTED'] },
        spendRequest: { orgId },
      },
      include: {
        spendRequest: { select: { createdAt: true, departmentId: true, department: { select: { name: true } } } },
      },
    });

    const deptTotals: Record<string, { dept: string; totalHours: number; count: number }> = {};

    for (const a of actions) {
      const deptId = a.spendRequest.departmentId;
      const deptName = a.spendRequest.department?.name || deptId;
      const hours =
        (new Date(a.createdAt).getTime() - new Date(a.spendRequest.createdAt).getTime()) / 3600000;
      if (!deptTotals[deptId]) deptTotals[deptId] = { dept: deptName, totalHours: 0, count: 0 };
      deptTotals[deptId].totalHours += hours;
      deptTotals[deptId].count++;
    }

    return Object.values(deptTotals).map((d) => ({
      department: d.dept,
      avgHours: d.count > 0 ? Math.round(d.totalHours / d.count) : 0,
      count: d.count,
    }));
  }

  async forecastedSpend(orgId: string, months = 3) {
    // Simple linear regression on last 6 months of billing totals
    const history = await this.prisma.billingRecord.groupBy({
      by: ['monthKey'],
      where: { orgId },
      _sum: { amount: true },
      orderBy: { monthKey: 'asc' },
      take: 6,
    });

    if (history.length < 2) return [];

    const totals = history.map((h) => h._sum.amount || 0);
    const n = totals.length;
    const sumX = n * (n - 1) / 2;
    const sumY = totals.reduce((a, b) => a + b, 0);
    const sumXY = totals.reduce((acc, y, i) => acc + i * y, 0);
    const sumX2 = totals.reduce((acc, _, i) => acc + i * i, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const lastMonth = history[history.length - 1].monthKey;
    const [lastYear, lastMo] = lastMonth.split('-').map(Number);

    return Array.from({ length: months }, (_, i) => {
      const mo = ((lastMo + i) % 12) + 1;
      const yr = lastYear + Math.floor((lastMo + i) / 12);
      const monthKey = `${yr}-${String(mo).padStart(2, '0')}`;
      const projected = Math.max(0, Math.round(intercept + slope * (n + i)));
      return { monthKey, projected };
    });
  }

  async dashboardKpis(orgId: string) {
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    // Get historical billing records for this month
    const billingSum = await this.prisma.billingRecord.aggregate({
      where: { orgId, monthKey: currentMonth },
      _sum: { amount: true },
    });
    const historicalSpend = billingSum._sum.amount || 0;

    // Get real-time tool spend (subscription tools use monthlyAmount pro-rated by
    // billingCycle, prepaid use usedAmount - see monthlyEquivalentSpend)
    const tools = await this.prisma.tool.findMany({
      where: { orgId, deletedAt: null },
      select: { paymentKind: true, billingCycle: true, monthlyAmount: true, usedAmount: true },
    });
    const realtimeSpend = tools.reduce((sum, t) => {
      if (t.paymentKind === 'NOBUDGET') return sum;
      return sum + monthlyEquivalentSpend(t);
    }, 0);

    const totalThisMonth = historicalSpend + realtimeSpend;

    const [alertCount, toolCount, noBudgetCount] = await Promise.all([
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint as count FROM tools
        WHERE "orgId" = ${orgId} AND "deletedAt" IS NULL
          AND "paymentKind" != 'NOBUDGET'
          AND "barPct" >= "alertThresholdPct"
      `.then((r) => Number(r[0].count)),
      this.prisma.tool.count({ where: { orgId, deletedAt: null } }),
      this.prisma.tool.count({ where: { orgId, deletedAt: null, paymentKind: 'NOBUDGET' } }),
    ]);

    // Use start-of-today so tools with today's renewal date are included
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const fiveDaysLater = new Date(startOfToday);
    fiveDaysLater.setDate(fiveDaysLater.getDate() + 5);
    fiveDaysLater.setHours(23, 59, 59, 999);

    const renewalWindow = { gte: startOfToday, lte: fiveDaysLater };

    const [nearestRenewal, renewalCount] = await Promise.all([
      this.prisma.tool.findFirst({
        where: { orgId, deletedAt: null, renewalDate: renewalWindow },
        orderBy: { renewalDate: 'asc' },
        select: { name: true, renewalDate: true },
      }),
      this.prisma.tool.count({
        where: { orgId, deletedAt: null, renewalDate: renewalWindow },
      }),
    ]);

    return {
      totalMonthlySpend: totalThisMonth,
      alertCount,
      toolCount,
      noBudgetCount,
      renewalCount,
      nearestRenewal: nearestRenewal
        ? {
            name: nearestRenewal.name,
            date: nearestRenewal.renewalDate,
            daysAway: Math.max(0, Math.ceil(
              (new Date(nearestRenewal.renewalDate!).getTime() - startOfToday.getTime()) / 86400000,
            )),
          }
        : null,
    };
  }
}
