import { BillingService } from './billing.service';

describe('BillingService', () => {
  let prisma: any;
  let audit: any;
  let service: BillingService;

  beforeEach(() => {
    prisma = {
      tool: { findFirst: jest.fn(), findMany: jest.fn() },
      billingRecord: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
    };
    audit = { log: jest.fn() };
    service = new BillingService(prisma, audit);
  });

  describe('recordCompletedCycle', () => {
    it('returns null without creating a record when the tool does not exist', async () => {
      prisma.tool.findFirst.mockResolvedValue(null);
      const result = await service.recordCompletedCycle('org1', 'tool1', '2026-07', 20, new Date());
      expect(result).toBeNull();
      expect(prisma.billingRecord.create).not.toHaveBeenCalled();
    });

    it('creates a PAID billing record with the correct snapshot and monthLabel', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 'tool1', name: 'Namecheap', vendor: 'Namecheap', category: 'OTHER' });
      prisma.billingRecord.create.mockResolvedValue({ id: 'rec1' });

      const billedAt = new Date(2026, 6, 15);
      const result = await service.recordCompletedCycle('org1', 'tool1', '2026-07', 20, billedAt);

      expect(prisma.billingRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orgId: 'org1',
          toolId: 'tool1',
          monthKey: '2026-07',
          monthLabel: 'Jul 2026',
          amount: 20,
          status: 'PAID',
          paidAt: billedAt,
          toolSnapshotJson: { name: 'Namecheap', vendor: 'Namecheap', category: 'OTHER' },
        }),
      });
      expect(result).toEqual({ id: 'rec1' });
    });

    it('is idempotent: swallows a P2002 unique-constraint violation and returns null instead of throwing', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 'tool1', name: 'Namecheap', vendor: 'Namecheap', category: 'OTHER' });
      const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      prisma.billingRecord.create.mockRejectedValue(p2002);

      const result = await service.recordCompletedCycle('org1', 'tool1', '2026-07', 20, new Date());
      expect(result).toBeNull();
    });

    it('re-throws non-P2002 errors', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 'tool1', name: 'Namecheap', vendor: 'Namecheap', category: 'OTHER' });
      prisma.billingRecord.create.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.recordCompletedCycle('org1', 'tool1', '2026-07', 20, new Date()),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('monthSummary', () => {
    it('pro-rates a YEARLY MOSUB tool by /12 when deriving the current month live total', async () => {
      prisma.billingRecord.groupBy.mockResolvedValue([]);
      prisma.tool.findMany.mockResolvedValue([
        { paymentKind: 'MOSUB', billingCycle: 'YEARLY', usedAmount: 0, monthlyAmount: 120 }, // Namecheap-like: $10/mo equivalent
        { paymentKind: 'PREPAID', billingCycle: 'MONTHLY', usedAmount: 15, monthlyAmount: 0 }, // Railway-like: live usage
      ]);

      const summary = await service.monthSummary('org1');
      const currentMonth = new Date().toISOString().slice(0, 7);

      expect(summary[0].monthKey).toBe(currentMonth);
      expect(summary[0].total).toBeCloseTo(25, 5); // 120/12 + 15
      expect(summary[0].count).toBe(2);
    });

    it('falls back to the raw groupBy summary when there is no live spend to derive', async () => {
      const rows = [{ monthKey: '2026-06', _sum: { amount: 42 }, _count: { id: 1 } }];
      prisma.billingRecord.groupBy.mockResolvedValue(rows);
      prisma.tool.findMany.mockResolvedValue([]);

      const summary = await service.monthSummary('org1');
      expect(summary).toEqual([{ monthKey: '2026-06', monthLabel: 'Jun 2026', total: 42, count: 1 }]);
    });
  });
});
