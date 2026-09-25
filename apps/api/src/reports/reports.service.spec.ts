import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let prisma: any;
  let service: ReportsService;

  beforeEach(() => {
    prisma = {
      tool: { findMany: jest.fn().mockResolvedValue([]) },
      billingRecord: { aggregate: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ReportsService(prisma);
  });

  describe('periodSpendByTool', () => {
    it('this_month: keys by toolId, using live pro-rated spend, skipping NOBUDGET tools', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0 },
        { id: 't2', paymentKind: 'MOSUB', billingCycle: 'YEARLY', usedAmount: 0, monthlyAmount: 120 }, // -> 10/mo
        { id: 't3', paymentKind: 'NOBUDGET', billingCycle: 'MONTHLY', usedAmount: 0, monthlyAmount: 0 },
      ]);

      const result = await service.periodSpendByTool('org1', 'this_month');
      expect(result).toEqual({ t1: 15, t2: 10 });
    });

    it('last_month: sums closed billing records per toolId for the prior monthKey', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([
        { toolId: 't1', amount: 20 },
        { toolId: 't2', amount: 5 },
      ]);

      const result = await service.periodSpendByTool('org1', 'last_month');
      expect(result).toEqual({ t1: 20, t2: 5 });
      expect(prisma.billingRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orgId: 'org1' }) }),
      );
    });

    it('last_month: falls back to a MOSUB tool\'s flat rate when the roll-forward cron has not logged that month yet (regression: showed $0 for an active subscription instead of its monthly fee)', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([]); // cron hasn't closed this month out yet
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{ id: 't1', paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0 }]
          : [],
      );

      const result = await service.periodSpendByTool('org1', 'last_month');
      expect(result).toEqual({ t1: 10 });
    });

    it('last_month: does NOT fall back for PREPAID/CAPSUB - current usedAmount is a live figure, not what was actually used in a past closed month', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([]);
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB' ? [] : [{ id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', monthlyAmount: 0, usedAmount: 15 }],
      );

      const result = await service.periodSpendByTool('org1', 'last_month');
      expect(result).toEqual({});
    });

    it('last_month: queries MOSUB fallback candidates with createdAt before the start of the following month, so a tool created after that month is excluded server-side', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([]);
      const now = new Date();
      const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      await service.periodSpendByTool('org1', 'last_month');

      expect(prisma.tool.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ paymentKind: 'MOSUB', createdAt: { lt: startOfThisMonth } }),
        }),
      );
    });

    it('this_month: a tool with a closed current-month record contributes ONLY that record, not the record plus its live figure too (regression: was double-counted - $8 closed + $15 live showed as $23 instead of $8)', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0 },
        { id: 't2', paymentKind: 'MOSUB', billingCycle: 'MONTHLY', usedAmount: 0, monthlyAmount: 20 }, // no closed record - still uses its live figure
      ]);
      prisma.billingRecord.findMany.mockResolvedValue([{ toolId: 't1', amount: 8 }]);

      const result = await service.periodSpendByTool('org1', 'this_month');

      expect(result).toEqual({ t1: 8, t2: 20 });
    });

    it('always sums to the same total as periodSpend, for every period (regression: table rows must sum to the KPI card)', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0 },
      ]);
      prisma.billingRecord.findMany.mockResolvedValue([{ toolId: 't1', amount: 8 }]);
      prisma.billingRecord.aggregate.mockImplementation(({ where }: any) => {
        // Same synthetic per-month data behind both the aggregate (periodSpend)
        // and findMany (periodSpendByTool) code paths, so the two must agree.
        if (where.monthKey === undefined) return { _sum: { amount: 0 } };
        return { _sum: { amount: 8 } };
      });

      for (const period of ['this_month', 'last_month', 'this_quarter', 'year_to_date'] as const) {
        const { total } = await service.periodSpend('org1', period);
        const byTool = await service.periodSpendByTool('org1', period);
        const sum = Object.values(byTool).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(total, 6);
      }
    });
  });

  describe('billingHistory', () => {
    function monthsAgo(n: number): string {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    it('backfills a MOSUB tool\'s flat rate for a past month with no billing record yet (regression: the month vanished entirely from Reports/Billing History instead of showing the tool\'s monthly fee)', async () => {
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{
            id: 't1', name: 'Namecheap', category: 'OTHER', monoInitials: 'NC', monoBgColor: '#000',
            paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0,
            renewalDate: null, createdAt: new Date(monthsAgo(6)),
          }]
          : [],
      );

      const { items } = await service.billingHistory('org1', {});
      const backfilled = items.find((r: any) => r.toolId === 't1' && r.monthKey === monthsAgo(1));
      expect(backfilled?.amount).toBe(10);
      expect(backfilled?.status).toBe('PAID'); // auto-renewing subscription in a closed month - not awaiting payment
    });

    it('does not duplicate a month that already has a real billing record', async () => {
      prisma.billingRecord.findMany.mockResolvedValue([
        {
          id: 'r1', toolId: 't1', monthKey: monthsAgo(1), monthLabel: 'x', amount: 10, status: 'PAID',
          tool: { name: 'Namecheap', monoInitials: 'NC', monoBgColor: '#000', category: 'OTHER', billingCycle: 'MONTHLY', renewalDate: null },
          toolSnapshotJson: null,
        },
      ]);
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{
            id: 't1', name: 'Namecheap', category: 'OTHER', monoInitials: 'NC', monoBgColor: '#000',
            paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0,
            renewalDate: null, createdAt: new Date(monthsAgo(6)),
          }]
          : [],
      );

      const { items } = await service.billingHistory('org1', {});
      const rowsForMonth = items.filter((r: any) => r.toolId === 't1' && r.monthKey === monthsAgo(1));
      expect(rowsForMonth).toHaveLength(1);
      expect(rowsForMonth[0].status).toBe('PAID'); // the real record, not a synthesized one
    });

    it('does not backfill months before the tool existed', async () => {
      prisma.tool.findMany.mockImplementation(({ where }: any) =>
        where.paymentKind === 'MOSUB'
          ? [{
            id: 't1', name: 'New Tool', category: 'OTHER', monoInitials: 'NT', monoBgColor: '#000',
            paymentKind: 'MOSUB', billingCycle: 'MONTHLY', monthlyAmount: 10, usedAmount: 0,
            renewalDate: null, createdAt: new Date(), // created this month
          }]
          : [],
      );

      const { items } = await service.billingHistory('org1', {});
      expect(items.filter((r: any) => r.toolId === 't1')).toHaveLength(0);
    });
  });
});
