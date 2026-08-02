import { ConflictException, NotFoundException } from '@nestjs/common';
import { ToolsService } from './tools.service';

describe('ToolsService', () => {
  let prisma: any;
  let audit: any;
  let service: ToolsService;

  beforeEach(() => {
    prisma = {
      tool: { count: jest.fn(), create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
      toolIntegration: { updateMany: jest.fn() },
      alertConfig: { updateMany: jest.fn() },
    };
    audit = { log: jest.fn() };
    service = new ToolsService(prisma, audit);
  });

  describe('create', () => {
    it('translates a P2002 unique-constraint violation into a ConflictException', async () => {
      prisma.tool.count.mockResolvedValue(0);
      prisma.tool.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

      await expect(
        service.create('org1', 'actor1', { name: 'Namecheap', departmentId: 'd1' } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('creates the tool with billingCycle defaulted to MONTHLY when not provided', async () => {
      prisma.tool.count.mockResolvedValue(0);
      prisma.tool.create.mockResolvedValue({ id: 't1' });

      await service.create('org1', 'actor1', { name: 'Figma', departmentId: 'd1' } as any);

      expect(prisma.tool.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ billingCycle: 'MONTHLY' }) }),
      );
    });

    it('persists an explicit YEARLY billingCycle', async () => {
      prisma.tool.count.mockResolvedValue(0);
      prisma.tool.create.mockResolvedValue({ id: 't1' });

      await service.create('org1', 'actor1', {
        name: 'Namecheap',
        departmentId: 'd1',
        billingCycle: 'YEARLY',
      } as any);

      expect(prisma.tool.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ billingCycle: 'YEARLY' }) }),
      );
    });
  });

  describe('softDelete', () => {
    it('deactivates the tool AND its integration, so the 15-min sync cron stops polling it', async () => {
      prisma.tool.findFirst.mockResolvedValue({
        id: 't1',
        orgId: 'org1',
        alertConfigs: [],
        paymentKind: 'PREPAID',
        barPct: 10,
      });
      prisma.tool.update.mockResolvedValue({ id: 't1', deletedAt: new Date() });

      await service.softDelete('t1', 'org1', 'actor1');

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { deletedAt: expect.any(Date), isActive: false },
      });
      expect(prisma.toolIntegration.updateMany).toHaveBeenCalledWith({
        where: { toolId: 't1' },
        data: { isActive: false },
      });
    });

    it('throws NotFoundException for a tool that does not belong to the org', async () => {
      prisma.tool.findFirst.mockResolvedValue(null);
      await expect(service.softDelete('t1', 'org1', 'actor1')).rejects.toThrow(NotFoundException);
      expect(prisma.toolIntegration.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('enrichTool / statusSub (via findOne)', () => {
    it('flags alert=true only when barPct has reached the threshold and paymentKind has a budget', async () => {
      prisma.tool.findFirst.mockResolvedValue({
        id: 't1',
        paymentKind: 'PREPAID',
        barPct: 90,
        alertConfigs: [{ thresholdPct: 80 }],
      });
      const result = await service.findOne('t1', 'org1');
      expect(result.alert).toBe(true);
      expect(result.statusSub).toBe('90% used');
    });

    it('never flags alert for NOBUDGET tools regardless of barPct', async () => {
      prisma.tool.findFirst.mockResolvedValue({
        id: 't1',
        paymentKind: 'NOBUDGET',
        barPct: 100,
        alertConfigs: [],
      });
      const result = await service.findOne('t1', 'org1');
      expect(result.alert).toBe(false);
      expect(result.statusSub).toBe('No budget configured');
    });

    it('clamps daysUntilRenewal to 0 for a renewal date that has already passed but not yet been rolled forward', async () => {
      const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000); // ~1.1 days ago
      prisma.tool.findFirst.mockResolvedValue({
        id: 't1',
        paymentKind: 'MOSUB',
        barPct: 0,
        alertConfigs: [],
        renewalDate: yesterday,
      });
      const result = await service.findOne('t1', 'org1');
      // Without the Math.max(0, ...) clamp this would be a negative number (e.g. -1),
      // which the dashboard renders as the confusing "in -1d" - it should read as
      // "renews today" (0) until the daily rollover cron catches up.
      expect(result.daysUntilRenewal).toBe(0);
    });

    it('computes a positive daysUntilRenewal for a future renewal date', async () => {
      const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 3600_000); // pad past exact 3.0 to avoid a ceil-boundary flake
      prisma.tool.findFirst.mockResolvedValue({
        id: 't1',
        paymentKind: 'MOSUB',
        barPct: 0,
        alertConfigs: [],
        renewalDate: in3Days,
      });
      const result = await service.findOne('t1', 'org1');
      expect(result.daysUntilRenewal).toBe(4);
    });
  });
});
