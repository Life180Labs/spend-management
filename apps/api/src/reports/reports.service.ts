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

function shiftMonthKey(monthKey: string, deltaMonths: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  const d = new Date(year, month - 1 + deltaMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export type DashboardSpendPeriod = 'this_month' | 'last_month' | 'this_quarter' | 'year_to_date';

// Shape mirrors a BillingRecord (+ included tool) so the frontend can treat
// live and historical rows identically.
export interface SpendRow {
  id: string;
  toolId: string | null;
  monthKey: string;
  monthLabel: string;
  amount: number;
  status: 'PAID' | 'PENDING';
  tool: {
    name: string; monoInitials: string; monoBgColor: string; category: string;
    // "MONTHLY" or "YEARLY" - the billing cycle length used to anchor a row's
    // Start/End Date to its renewal date (see excel.ts's billingRowPeriod),
    // for any tool that has a renewalDate set, regardless of payment kind.
    billingCycle: string;
    // The tool's CURRENT renewal date - rollForwardRenewalDates advances this
    // to the next upcoming cycle after each one completes, so for a historical
    // row this is a stand-in for "which day of the month this tool bills on,"
    // not literally that row's own renewal date (see excel.ts's
    // billingRowPeriod for the full reconstruction). Null for a deleted tool
    // (not captured in toolSnapshotJson) or a tool with no renewal date set.
    renewalDate: Date | null;
  } | null;
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
        renewalDate: true,
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
            billingCycle: t.billingCycle,
            renewalDate: t.renewalDate,
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
        // billingCycle/renewalDate aren't selected/needed here - this branch only
        // feeds the category rollup, never the per-row billing export (see billingHistory()).
        tool: r.tool
          ? { name: r.tool.name, monoInitials: r.tool.monoInitials, monoBgColor: r.tool.monoBgColor, category: r.tool.category, billingCycle: 'MONTHLY', renewalDate: null }
          : { name: (r.toolSnapshotJson as any)?.name || 'Deleted tool', monoInitials: '?', monoBgColor: '#5E6AD2', category: (r.toolSnapshotJson as any)?.category || 'OTHER', billingCycle: 'MONTHLY', renewalDate: null },
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
      include: {
        tool: {
          select: { name: true, monoInitials: true, monoBgColor: true, category: true, billingCycle: true, renewalDate: true },
        },
      },
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
        ? {
          name: r.tool.name, monoInitials: r.tool.monoInitials, monoBgColor: r.tool.monoBgColor, category: r.tool.category,
          billingCycle: r.tool.billingCycle, renewalDate: r.tool.renewalDate,
        }
        // toolSnapshotJson doesn't capture billingCycle/renewalDate - fall back to
        // the calendar month for a deleted tool rather than guessing its cycle.
        : {
          name: (r.toolSnapshotJson as any)?.name || 'Deleted tool', monoInitials: '?', monoBgColor: '#5E6AD2',
          category: (r.toolSnapshotJson as any)?.category || 'OTHER', billingCycle: 'MONTHLY', renewalDate: null,
        },
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

  /**
   * This month's total spend: for a tool that already has a closed billing
   * record for the current month (rare - usually empty until month-end), that
   * record IS its contribution; every other active tool contributes its live
   * pro-rated figure (see monthlyEquivalentSpend). This is the "live" figure -
   * the only one of the four dashboard-spend-period options with no fixed
   * historical answer, since the month isn't over yet.
   *
   * Deliberately NOT closed-record-plus-live: a closed record represents that
   * tool's ENTIRE month already, so adding the live figure on top double-counts
   * it (regression - hit in production for three different tools' current-month
   * rows before this was fixed to prefer the closed record instead of summing).
   */
  private async currentMonthTotal(orgId: string): Promise<number> {
    const byTool = await this.currentMonthTotalByTool(orgId);
    return Object.values(byTool).reduce((sum, amount) => sum + amount, 0);
  }

  private async closedMonthTotal(orgId: string, monthKey: string): Promise<number> {
    const sum = await this.prisma.billingRecord.aggregate({
      where: { orgId, monthKey },
      _sum: { amount: true },
    });
    return sum._sum.amount || 0;
  }

  /**
   * Every tool's contribution to the current month, keyed by toolId. A tool
   * that already has a closed billing record for this month (rare but
   * possible) uses ONLY that record - it already represents the tool's whole
   * month, so also adding the live pro-rated figure on top would double-count
   * it. Only a tool with NO closed record yet falls back to its live figure.
   */
  private async currentMonthTotalByTool(orgId: string): Promise<Record<string, number>> {
    const result = await this.closedMonthTotalByTool(orgId, currentMonthKey());

    const tools = await this.prisma.tool.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, paymentKind: true, billingCycle: true, monthlyAmount: true, usedAmount: true },
    });
    for (const t of tools) {
      if (t.paymentKind === 'NOBUDGET') continue;
      if (result[t.id] != null) continue; // already has a closed record this month - don't also add the live figure
      const amount = monthlyEquivalentSpend(t);
      if (amount > 0) result[t.id] = amount;
    }
    return result;
  }

  /** Closed billing records for one month, summed per toolId (at most one record per tool per month - see the (orgId, toolId, monthKey) unique constraint). */
  private async closedMonthTotalByTool(orgId: string, monthKey: string): Promise<Record<string, number>> {
    const records = await this.prisma.billingRecord.findMany({
      where: { orgId, monthKey },
      select: { toolId: true, amount: true },
    });
    const result: Record<string, number> = {};
    for (const r of records) {
      if (!r.toolId) continue;
      result[r.toolId] = (result[r.toolId] ?? 0) + r.amount;
    }
    return result;
  }

  /**
   * The set of monthKeys a non-"this_month" period spans - shared by periodSpend
   * and periodSpendByTool so the two can never disagree about which months are
   * "in" a given quarter/YTD window.
   */
  private monthKeysForPeriod(period: 'this_quarter' | 'year_to_date'): string[] {
    const now = new Date();
    const startMonth = period === 'this_quarter' ? Math.floor(now.getMonth() / 3) * 3 : 0; // 0-indexed
    const monthKeys: string[] = [];
    for (let m = startMonth; m <= now.getMonth(); m++) {
      monthKeys.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
    }
    return monthKeys;
  }

  /**
   * Total spend for the Dashboard's period dropdown. "This month" is live
   * (see currentMonthTotal); every other period sums closed billing-record
   * months plus the live current month where it falls inside the window (e.g.
   * "This quarter" includes the in-progress current month). A historical
   * month with no billing record yet (e.g. the cron hasn't closed it out)
   * contributes 0 rather than throwing - same convention as Reports' billing
   * history / spend-by-category views.
   */
  async periodSpend(orgId: string, period: DashboardSpendPeriod) {
    const currentMonth = currentMonthKey();

    if (period === 'this_month') {
      return { total: await this.currentMonthTotal(orgId) };
    }

    if (period === 'last_month') {
      const lastMonth = shiftMonthKey(currentMonth, -1);
      return { total: await this.closedMonthTotal(orgId, lastMonth) };
    }

    const monthKeys = this.monthKeysForPeriod(period);
    let total = 0;
    for (const monthKey of monthKeys) {
      total += monthKey === currentMonth
        ? await this.currentMonthTotal(orgId)
        : await this.closedMonthTotal(orgId, monthKey);
    }
    return { total };
  }

  /**
   * Same windowing as periodSpend, but broken down per tool instead of a single
   * total - powers the Dashboard tools table's period-spend column, so each row
   * visibly sums to the Total Monthly Spend KPI card above it.
   */
  async periodSpendByTool(orgId: string, period: DashboardSpendPeriod): Promise<Record<string, number>> {
    const currentMonth = currentMonthKey();

    if (period === 'this_month') {
      return this.currentMonthTotalByTool(orgId);
    }

    if (period === 'last_month') {
      return this.closedMonthTotalByTool(orgId, shiftMonthKey(currentMonth, -1));
    }

    const monthKeys = this.monthKeysForPeriod(period);
    const result: Record<string, number> = {};
    for (const monthKey of monthKeys) {
      const byTool = monthKey === currentMonth
        ? await this.currentMonthTotalByTool(orgId)
        : await this.closedMonthTotalByTool(orgId, monthKey);
      for (const [toolId, amount] of Object.entries(byTool)) {
        result[toolId] = (result[toolId] ?? 0) + amount;
      }
    }
    return result;
  }

  async dashboardKpis(orgId: string) {
    const totalThisMonth = await this.currentMonthTotal(orgId);

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
