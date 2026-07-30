jest.mock('./providers/railway.provider', () => ({
  RailwayProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
    fetchLimitsUSD: jest.fn(),
  })),
}));
jest.mock('./providers/claude.provider', () => ({
  ClaudeProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
  })),
}));

import { IntegrationRunnerService, PROVIDERS } from './integration-runner.service';

describe('IntegrationRunnerService', () => {
  let prisma: any;
  let service: IntegrationRunnerService;
  const railway = PROVIDERS.RAILWAY as any;
  const claude = PROVIDERS.CLAUDE as any;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      toolIntegration: { findMany: jest.fn(), update: jest.fn() },
      tool: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    service = new IntegrationRunnerService(prisma);
  });

  describe('runAll', () => {
    it('only queries active integrations belonging to non-deleted tools', async () => {
      prisma.toolIntegration.findMany.mockResolvedValue([]);
      await service.runAll();
      expect(prisma.toolIntegration.findMany).toHaveBeenCalledWith({
        where: { isActive: true, tool: { deletedAt: null } },
      });
    });

    it('runs every returned integration', async () => {
      prisma.toolIntegration.findMany.mockResolvedValue([
        { id: 'i1', toolId: 't1', provider: 'RAILWAY', config: {} },
        { id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {} },
      ]);
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 5 });
      claude.fetchSpendUSD.mockResolvedValue({ amountUSD: 8 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runAll();

      expect(railway.fetchSpendUSD).toHaveBeenCalledTimes(1);
      expect(claude.fetchSpendUSD).toHaveBeenCalledTimes(1);
    });
  });

  describe('runOne', () => {
    it('dispatches to the provider registered for integration.provider (generic, no hardcoded vendor check)', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 12.5, breakdown: [], byProject: [] });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { token: 'x' } });

      expect(railway.fetchSpendUSD).toHaveBeenCalledWith({ token: 'x' });
      expect(claude.fetchSpendUSD).not.toHaveBeenCalled();
    });

    it('logs a warning and does nothing when no provider is registered for the given key', async () => {
      await service.runOne({ id: 'i1', toolId: 't1', provider: 'UNKNOWN_VENDOR', config: {} });
      expect(prisma.tool.update).not.toHaveBeenCalled();
      expect(prisma.toolIntegration.update).not.toHaveBeenCalled();
    });

    it('updates usedAmount/barPct using the tool cap when the provider does not expose limits', async () => {
      claude.fetchSpendUSD.mockResolvedValue({ amountUSD: 40, breakdown: [], byProject: [] });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 100, alertThresholdPct: 80 });

      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {} });

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't2' },
        data: { usedAmount: 40, barPct: 40, capAmount: 100, alertThresholdPct: 80 },
      });
    });

    it('refreshes cap/alertThresholdPct from provider-reported limits when available', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 9, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 20, computeSoftLimitUSD: 16 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: {} });

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { usedAmount: 9, barPct: 45, capAmount: 20, alertThresholdPct: 80 },
      });
    });

    it('records lastError on the integration instead of throwing when the provider call fails', async () => {
      claude.fetchSpendUSD.mockRejectedValue(new Error('API key revoked'));

      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {} });

      expect(prisma.toolIntegration.update).toHaveBeenCalledWith({
        where: { id: 'i2' },
        data: { lastError: 'API key revoked' },
      });
    });
  });
});
