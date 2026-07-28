import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationRunnerService } from './integration-runner.service';
import { RailwayProvider } from './providers/railway.provider';

@Injectable()
export class IntegrationsService {
  constructor(
    private prisma: PrismaService,
    private runner: IntegrationRunnerService,
  ) { }

  async get(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) return null;
    // Return config with apiToken masked - never expose raw secrets over the API
    const { config, ...rest } = integration;
    const safeConfig = this.maskConfig(config as Record<string, any>);
    return { ...rest, config: safeConfig };
  }

  async upsert(toolId: string, orgId: string, body: { provider: string; config: Record<string, any>; isActive?: boolean }) {
    await this.assertToolOwnership(toolId, orgId);
    return this.prisma.toolIntegration.upsert({
      where: { toolId },
      update: {
        provider: body.provider,
        config: body.config,
        isActive: body.isActive ?? true,
        lastError: null,
        updatedAt: new Date(),
      },
      create: {
        toolId,
        provider: body.provider,
        config: body.config,
        isActive: body.isActive ?? true,
      },
    });
  }

  async remove(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    return this.prisma.toolIntegration.delete({ where: { toolId } });
  }

  async fetchLimits(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) throw new NotFoundException('No integration configured for this tool');

    if (integration.provider !== 'RAILWAY') {
      return null; // only Railway exposes usage limits via API
    }

    const provider = new RailwayProvider();
    const limits = await provider.fetchLimitsUSD(integration.config as Record<string, any>);
    if (!limits) return null;

    return {
      computeHardLimitUSD: limits.computeHardLimitUSD,
      computeSoftLimitUSD: limits.computeSoftLimitUSD,
      alertThresholdPct: limits.computeHardLimitUSD > 0
        ? Math.round((limits.computeSoftLimitUSD / limits.computeHardLimitUSD) * 100)
        : 80,
    };
  }

  async previewLimits(provider: string, config: Record<string, any>) {
    if (provider !== 'RAILWAY') return null;

    const railwayProvider = new RailwayProvider();
    const limits = await railwayProvider.fetchLimitsUSD(config);
    if (!limits) return null;

    return {
      computeHardLimitUSD: limits.computeHardLimitUSD,
      computeSoftLimitUSD: limits.computeSoftLimitUSD,
      alertThresholdPct: limits.computeHardLimitUSD > 0
        ? Math.round((limits.computeSoftLimitUSD / limits.computeHardLimitUSD) * 100)
        : 80,
    };
  }

  async getUsageHistory(toolId: string, orgId: string, startDate: Date, endDate: Date) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) throw new NotFoundException('No integration configured for this tool');

    if (integration.provider !== 'RAILWAY') {
      throw new NotFoundException('Usage history is not available for this provider yet');
    }

    const provider = new RailwayProvider();
    const { amountUSD, breakdown, byProject } = await provider.fetchHistoricalSpendUSD(
      integration.config as Record<string, any>,
      { startDate, endDate },
    );

    return { amountUSD, breakdown, byProject, startDate, endDate };
  }

  async syncNow(toolId: string, orgId: string) {
    await this.assertToolOwnership(toolId, orgId);
    const integration = await this.prisma.toolIntegration.findUnique({ where: { toolId } });
    if (!integration) throw new NotFoundException('No integration configured for this tool');
    await this.runner.runOne(integration);
    return this.get(toolId, orgId);
  }

  private async assertToolOwnership(toolId: string, orgId: string) {
    const tool = await this.prisma.tool.findFirst({ where: { id: toolId, orgId, deletedAt: null } });
    if (!tool) throw new NotFoundException('Tool not found');
  }

  private maskConfig(config: Record<string, any>): Record<string, any> {
    const masked: Record<string, any> = {};
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === 'string' && v.length > 8) {
        masked[k] = v.slice(0, 4) + '••••' + v.slice(-4);
      } else {
        masked[k] = v;
      }
    }
    return masked;
  }
}
