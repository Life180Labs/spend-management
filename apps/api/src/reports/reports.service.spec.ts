import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let prisma: any;
  let service: ReportsService;

  beforeEach(() => {
    prisma = {
      tool: { findMany: jest.fn() },
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
});
