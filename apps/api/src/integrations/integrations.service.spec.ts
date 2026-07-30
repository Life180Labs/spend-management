jest.mock('./providers/railway.provider', () => ({
  RailwayProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
    fetchLimitsUSD: jest.fn(),
    fetchHistoricalSpendUSD: jest.fn(),
  })),
}));
jest.mock('./providers/claude.provider', () => ({
  // Claude provider deliberately has no fetchLimitsUSD/fetchHistoricalSpendUSD -
  // mirrors the real ClaudeProvider, which only exposes fetchSpendUSD.
  ClaudeProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
  })),
}));

import { NotFoundException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { PROVIDERS } from './integration-runner.service';

describe('IntegrationsService', () => {
  let prisma: any;
  let runner: any;
  let service: IntegrationsService;
  const railway = PROVIDERS.RAILWAY as any;
  const claude = PROVIDERS.CLAUDE as any;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      tool: { findFirst: jest.fn() },
      toolIntegration: { findUnique: jest.fn() },
    };
    runner = { runOne: jest.fn() };
    service = new IntegrationsService(prisma, runner);
  });

  describe('fetchLimits', () => {
    it('throws NotFoundException when no integration is configured', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue(null);
      await expect(service.fetchLimits('t1', 'org1')).rejects.toThrow(NotFoundException);
    });

    it('returns null (not a hardcoded provider check) when the dispatched provider has no fetchLimitsUSD', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue({ provider: 'CLAUDE', config: {} });

      const result = await service.fetchLimits('t1', 'org1');
      expect(result).toBeNull();
    });

    it('derives alertThresholdPct from the provider-reported soft/hard limit ratio', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue({ provider: 'RAILWAY', config: {} });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 100, computeSoftLimitUSD: 80 });

      const result = await service.fetchLimits('t1', 'org1');
      expect(result).toEqual({ computeHardLimitUSD: 100, computeSoftLimitUSD: 80, alertThresholdPct: 80 });
    });
  });

  describe('getUsageHistory', () => {
    it('throws NotFoundException when the dispatched provider has no fetchHistoricalSpendUSD (generic dispatch)', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue({ provider: 'CLAUDE', config: {} });

      await expect(
        service.getUsageHistory('t1', 'org1', new Date(2026, 5, 1), new Date(2026, 6, 1)),
      ).rejects.toThrow('Usage history is not available for this provider yet');
    });

    it('returns the provider result for a provider that supports historical spend', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue({ provider: 'RAILWAY', config: {} });
      railway.fetchHistoricalSpendUSD.mockResolvedValue({ amountUSD: 55, breakdown: [], byProject: [] });

      const start = new Date(2026, 5, 1);
      const end = new Date(2026, 6, 1);
      const result = await service.getUsageHistory('t1', 'org1', start, end);
      expect(result).toEqual({ amountUSD: 55, breakdown: [], byProject: [], startDate: start, endDate: end });
      expect(railway.fetchHistoricalSpendUSD).toHaveBeenCalledWith({}, { startDate: start, endDate: end });
    });
  });

  describe('get', () => {
    it('masks long string config values before returning them (never expose raw secrets)', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue({
        toolId: 't1',
        provider: 'RAILWAY',
        config: { apiToken: 'sk-supersecrettoken1234' },
        isActive: true,
      });

      const result = await service.get('t1', 'org1');
      expect(result!.config.apiToken).toBe('sk-s••••1234');
    });

    it('returns null when no integration exists for the tool', async () => {
      prisma.tool.findFirst.mockResolvedValue({ id: 't1' });
      prisma.toolIntegration.findUnique.mockResolvedValue(null);
      const result = await service.get('t1', 'org1');
      expect(result).toBeNull();
    });
  });

  describe('assertToolOwnership (via any method)', () => {
    it('throws NotFoundException for a tool not belonging to the org / soft-deleted', async () => {
      prisma.tool.findFirst.mockResolvedValue(null);
      await expect(service.get('t1', 'org1')).rejects.toThrow(NotFoundException);
    });
  });
});
