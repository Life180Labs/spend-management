const fetchHistoricalSpendUSD = jest.fn();

jest.mock('../integrations/integration-runner.service', () => ({
  IntegrationRunnerService: jest.fn(),
  PROVIDERS: {
    RAILWAY: { fetchHistoricalSpendUSD },
    CLAUDE: {}, // deliberately no fetchHistoricalSpendUSD - mirrors real ClaudeProvider
  },
}));

import { SchedulerService } from './scheduler.service';

describe('SchedulerService', () => {
  let prisma: any;
  let mail: any;
  let integrationRunner: any;
  let billing: any;
  let service: SchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      tool: { findMany: jest.fn(), update: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]), // DB-wake probe used by runWithDbRetry - resolved means "already awake"
    };
    mail = { sendThresholdAlert: jest.fn(), sendRenewalReminder: jest.fn() };
    integrationRunner = { runAll: jest.fn() };
    billing = { recordCompletedCycle: jest.fn() };
    service = new SchedulerService(prisma, mail, integrationRunner, billing);
  });

  describe('checkThresholdAlerts', () => {
    it('sends exactly ONE consolidated email when two breaching tools share a recipient', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', name: 'Railway', vendor: 'Railway.com', barPct: 90, alertThresholdPct: 80, capAmount: 20, triggerEmail: 'a@b.com' },
        { id: 't2', name: 'Claude', vendor: 'Anthropic', barPct: 95, alertThresholdPct: 80, capAmount: null, triggerEmail: 'a@b.com' },
      ]);

      await service.checkThresholdAlerts();

      expect(mail.sendThresholdAlert).toHaveBeenCalledTimes(1);
      expect(mail.sendThresholdAlert).toHaveBeenCalledWith('a@b.com', [
        { toolName: 'Railway', vendor: 'Railway.com', barPct: 90, thresholdPct: 80, capAmount: 20 },
        { toolName: 'Claude', vendor: 'Anthropic', barPct: 95, thresholdPct: 80, capAmount: null },
      ], []);
    });

    it('includes the same recipient\'s upcoming renewals (within the 5-day lookahead) in the same email', async () => {
      const breachingTool = { id: 't1', name: 'Railway', vendor: 'Railway.com', barPct: 90, alertThresholdPct: 80, capAmount: 20, triggerEmail: 'a@b.com' };
      const renewingTool = {
        id: 't2', name: 'Google Workspace', vendor: 'Google Workspace', barPct: 0, alertThresholdPct: 80, capAmount: 0,
        triggerEmail: 'a@b.com', renewalDate: new Date(), monthlyAmount: 2.5,
      };
      // Two distinct findMany calls happen inside checkThresholdAlerts: the breaching-tools
      // query, then the renewing-tools query (scoped to the recipients found above).
      prisma.tool.findMany
        .mockResolvedValueOnce([breachingTool])
        .mockResolvedValueOnce([renewingTool]);

      await service.checkThresholdAlerts();

      expect(mail.sendThresholdAlert).toHaveBeenCalledWith(
        'a@b.com',
        [{ toolName: 'Railway', vendor: 'Railway.com', barPct: 90, thresholdPct: 80, capAmount: 20 }],
        [{ toolName: 'Google Workspace', vendor: 'Google Workspace', renewalDate: renewingTool.renewalDate, daysAway: 0, monthlyAmount: 2.5 }],
      );
    });

    it('sends separate emails to different recipients', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', name: 'Railway', vendor: 'Railway.com', barPct: 90, alertThresholdPct: 80, capAmount: 20, triggerEmail: 'a@b.com' },
        { id: 't2', name: 'Figma', vendor: 'Figma Inc.', barPct: 95, alertThresholdPct: 80, capAmount: 500, triggerEmail: 'c@d.com' },
      ]);

      await service.checkThresholdAlerts();
      expect(mail.sendThresholdAlert).toHaveBeenCalledTimes(2);
    });

    it('skips tools that have not reached their alert threshold', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', name: 'Railway', vendor: 'Railway.com', barPct: 50, alertThresholdPct: 80, capAmount: 20, triggerEmail: 'a@b.com' },
      ]);

      await service.checkThresholdAlerts();
      expect(mail.sendThresholdAlert).not.toHaveBeenCalled();
    });

    it('does not re-send within 24 hours for a tool already alerted', async () => {
      const tool = { id: 't1', name: 'Railway', vendor: 'Railway.com', barPct: 90, alertThresholdPct: 80, capAmount: 20, triggerEmail: 'a@b.com' };
      prisma.tool.findMany.mockResolvedValue([tool]);

      await service.checkThresholdAlerts(); // first run sends
      await service.checkThresholdAlerts(); // second run should be suppressed

      expect(mail.sendThresholdAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('rollForwardRenewalDates', () => {
    it('records a completed billing cycle for each stepped-past renewal and advances renewalDate', async () => {
      // "Today" in this environment is 2026-07-30, so a Jul 15 2025 renewal date
      // is behind by TWO yearly cycles (Jul 15 2025 and Jul 15 2026), landing on
      // Jul 15 2027 - exercises the multi-cycle catch-up path, not just a single step.
      prisma.tool.findMany.mockResolvedValue([
        {
          id: 't1',
          orgId: 'org1',
          name: 'Namecheap',
          paymentKind: 'MOSUB',
          billingCycle: 'YEARLY',
          monthlyAmount: 120,
          renewalDate: new Date(2025, 6, 15), // Jul 15 2025
        },
      ]);

      await service.rollForwardRenewalDates();

      expect(billing.recordCompletedCycle).toHaveBeenCalledTimes(2);
      expect(billing.recordCompletedCycle).toHaveBeenNthCalledWith(
        1, 'org1', 't1', '2025-07', 120, new Date(2025, 6, 15),
      );
      expect(billing.recordCompletedCycle).toHaveBeenNthCalledWith(
        2, 'org1', 't1', '2026-07', 120, new Date(2026, 6, 15),
      );
      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { renewalDate: new Date(2027, 6, 15) },
      });
    });

    it('only queries MOSUB/CAPSUB tools with a past renewal date (PREPAID is excluded)', async () => {
      prisma.tool.findMany.mockResolvedValue([]);
      await service.rollForwardRenewalDates();
      expect(prisma.tool.findMany).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          paymentKind: { in: ['MOSUB', 'CAPSUB'] },
          renewalDate: { lt: expect.any(Date) },
        },
      });
    });
  });

  describe('recordCompletedMonthUsageBilling', () => {
    it('logs completed-month billing using fetchHistoricalSpendUSD for an active integration that supports it', async () => {
      prisma.tool.findMany.mockResolvedValue([
        {
          id: 't1', orgId: 'org1', name: 'Railway',
          integration: { isActive: true, provider: 'RAILWAY', config: {} },
        },
      ]);
      fetchHistoricalSpendUSD.mockResolvedValue({ amountUSD: 33, breakdown: [], byProject: [] });

      await service.recordCompletedMonthUsageBilling();

      expect(fetchHistoricalSpendUSD).toHaveBeenCalled();
      expect(billing.recordCompletedCycle).toHaveBeenCalledWith('org1', 't1', expect.any(String), 33, expect.any(Date));
    });

    it('skips tools whose integration is inactive', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't1', orgId: 'org1', name: 'Railway', integration: { isActive: false, provider: 'RAILWAY', config: {} } },
      ]);

      await service.recordCompletedMonthUsageBilling();
      expect(fetchHistoricalSpendUSD).not.toHaveBeenCalled();
      expect(billing.recordCompletedCycle).not.toHaveBeenCalled();
    });

    it('skips tools whose provider does not support fetchHistoricalSpendUSD (e.g. CLAUDE)', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 't2', orgId: 'org1', name: 'Claude', integration: { isActive: true, provider: 'CLAUDE', config: {} } },
      ]);

      await service.recordCompletedMonthUsageBilling();
      expect(billing.recordCompletedCycle).not.toHaveBeenCalled();
    });
  });

  describe('runWithDbRetry (Postgres Serverless wake-up handling)', () => {
    // Postgres can be asleep independently of the API service (Railway Serverless
    // mode on the DB only) - the first connection attempt after that fails with
    // Prisma's P1001 while it wakes up. These tests drive that retry loop directly
    // via checkThresholdAlerts, which calls runWithDbRetry as its very first step.
    const connErr = Object.assign(new Error("Can't reach database server at `x:5432`"), { code: 'P1001' });

    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('proceeds with the job once the DB probe succeeds without needing a retry', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      prisma.tool.findMany.mockResolvedValue([]);

      await service.checkThresholdAlerts();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.tool.findMany).toHaveBeenCalled();
    });

    it('retries the DB probe with backoff on a connection error, then runs the job once it succeeds', async () => {
      prisma.$queryRaw
        .mockRejectedValueOnce(connErr)
        .mockRejectedValueOnce(connErr)
        .mockResolvedValueOnce([{ '?column?': 1 }]);
      prisma.tool.findMany.mockResolvedValue([]);

      const run = service.checkThresholdAlerts();
      await jest.runAllTimersAsync();
      await run;

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(prisma.tool.findMany).toHaveBeenCalled(); // job's real logic still ran after the DB came back
    });

    it('gives up after exhausting all retries and skips the run - does not throw', async () => {
      prisma.$queryRaw.mockRejectedValue(connErr);
      prisma.tool.findMany.mockResolvedValue([]);

      const run = service.checkThresholdAlerts();
      await jest.runAllTimersAsync();
      await expect(run).resolves.toBeUndefined(); // never throws, even when the DB never wakes up

      expect(prisma.tool.findMany).not.toHaveBeenCalled(); // job body never ran
    });

    it('does not retry a non-connection database error - aborts immediately without running the job', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('permission denied for table tools'));
      prisma.tool.findMany.mockResolvedValue([]);

      await service.checkThresholdAlerts();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // no retry loop for a non-connection error
      expect(prisma.tool.findMany).not.toHaveBeenCalled();
    });
  });
});
