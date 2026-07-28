import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationProvider } from './provider.interface';
import { RailwayProvider } from './providers/railway.provider';
import { ClaudeProvider } from './providers/claude.provider';

// Register new providers here - no other file needs to change.
export const PROVIDERS: Record<string, IntegrationProvider> = {
  RAILWAY: new RailwayProvider(),
  CLAUDE: new ClaudeProvider(),
};

@Injectable()
export class IntegrationRunnerService {
  private readonly logger = new Logger(IntegrationRunnerService.name);

  constructor(private prisma: PrismaService) { }

  /** Run all active integrations. Called by the scheduler cron. */
  async runAll() {
    const integrations = await this.prisma.toolIntegration.findMany({
      where: { isActive: true, tool: { deletedAt: null } },
    });
    await Promise.allSettled(integrations.map((i) => this.runOne(i)));
  }

  /** Run a single integration and update the tool's usedAmount + barPct (and capAmount/alertThresholdPct, if the provider exposes a budget). All amounts are USD - the app's base currency. */
  async runOne(integration: { id: string; toolId: string; provider: string; config: any }) {
    const provider = PROVIDERS[integration.provider];
    if (!provider) {
      this.logger.warn(`No provider registered for "${integration.provider}"`);
      return;
    }

    try {
      const config = integration.config as Record<string, any>;
      const { amountUSD, breakdown, byProject } = await provider.fetchSpendUSD(config);

      // Pull the latest budget cap too, if this provider can report one - keeps the
      // dashboard's cap in sync with whatever's configured on the provider's side,
      // not just whatever was captured when the tool was first connected.
      let hardLimitUSD: number | null = null;
      let softLimitUSD: number | null = null;
      if (provider.fetchLimitsUSD) {
        try {
          const limits = await provider.fetchLimitsUSD(config);
          if (limits && limits.computeHardLimitUSD > 0) {
            hardLimitUSD = limits.computeHardLimitUSD;
            softLimitUSD = limits.computeSoftLimitUSD ?? null;
          }
        } catch (limitsErr: any) {
          this.logger.warn(`Could not refresh limits for tool ${integration.toolId}: ${limitsErr.message}`);
        }
      }

      await this.prisma.$transaction(async (tx) => {
        const tool = await tx.tool.findUnique({
          where: { id: integration.toolId },
          select: { capAmount: true, alertThresholdPct: true },
        });

        const capAmount = hardLimitUSD ?? Number(tool?.capAmount ?? 0);
        const alertThresholdPct = hardLimitUSD !== null && softLimitUSD !== null
          ? Math.round((softLimitUSD / hardLimitUSD) * 100)
          : tool?.alertThresholdPct;
        const barPct = capAmount > 0
          ? Math.min(100, Math.round((amountUSD / capAmount) * 100))
          : 0;

        await tx.tool.update({
          where: { id: integration.toolId },
          data: { usedAmount: amountUSD, barPct, capAmount, alertThresholdPct },
        });
        await tx.toolIntegration.update({
          where: { id: integration.id },
          data: {
            lastSyncAt: new Date(),
            lastSyncAmountUSD: amountUSD,
            lastSyncBreakdown: (breakdown as unknown as Prisma.InputJsonValue) ?? undefined,
            lastSyncByProject: (byProject as unknown as Prisma.InputJsonValue) ?? undefined,
            lastError: null,
          },
        });
      });

      const capLog = hardLimitUSD !== null ? ` · cap $${hardLimitUSD.toLocaleString('en-US')}` : '';
      this.logger.log(`Synced ${integration.provider} → tool ${integration.toolId}: $${amountUSD.toFixed(2)}${capLog}`);
    } catch (err: any) {
      this.logger.error(`Sync failed for ${integration.provider} (tool ${integration.toolId}): ${err.message}`);
      await this.prisma.toolIntegration.update({
        where: { id: integration.id },
        data: { lastError: err.message },
      });
    }
  }
}
