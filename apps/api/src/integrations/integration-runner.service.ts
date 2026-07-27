import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationProvider } from './provider.interface';
import { RailwayProvider } from './providers/railway.provider';

// Register new providers here — no other file needs to change.
const PROVIDERS: Record<string, IntegrationProvider> = {
  RAILWAY: new RailwayProvider(),
};

// Frankfurter API — backed by the European Central Bank, free, no key needed.
const FX_URL = 'https://api.frankfurter.app/latest?from=USD&to=INR';
const FX_CACHE_TTL_MS = 60 * 60 * 1000; // refresh rate once per hour
let fxCache: { rate: number; fetchedAt: number } | null = null;

async function getUsdToInr(): Promise<number> {
  if (fxCache && Date.now() - fxCache.fetchedAt < FX_CACHE_TTL_MS) {
    return fxCache.rate;
  }
  try {
    const res = await fetch(FX_URL);
    const json = (await res.json()) as { rates?: { INR?: number } };
    const rate = json?.rates?.INR;
    if (rate && rate > 0) {
      fxCache = { rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch {
    // fall through to fallback
  }
  // Fallback: env var → hardcoded default
  return Number(process.env.USD_TO_INR) || 84;
}

@Injectable()
export class IntegrationRunnerService {
  private readonly logger = new Logger(IntegrationRunnerService.name);

  constructor(private prisma: PrismaService) {}

  /** Run all active integrations. Called by the scheduler cron. */
  async runAll() {
    const integrations = await this.prisma.toolIntegration.findMany({
      where: { isActive: true },
    });
    await Promise.allSettled(integrations.map((i) => this.runOne(i)));
  }

  /** Run a single integration and update the tool's usedAmount + barPct (and capAmount/alertThresholdPct, if the provider exposes a budget). */
  async runOne(integration: { id: string; toolId: string; provider: string; config: any }) {
    const provider = PROVIDERS[integration.provider];
    if (!provider) {
      this.logger.warn(`No provider registered for "${integration.provider}"`);
      return;
    }

    try {
      const config    = integration.config as Record<string, any>;
      const amountUSD = await provider.fetchSpendUSD(config);
      const usdToInr  = await getUsdToInr();
      const amountINR = amountUSD * usdToInr;
      this.logger.log(`FX rate: $1 = ₹${usdToInr.toFixed(2)} · $${amountUSD.toFixed(4)} = ₹${amountINR.toFixed(2)}`);

      // Pull the latest budget cap too, if this provider can report one — keeps the
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

        const capAmount = hardLimitUSD !== null
          ? Math.round(hardLimitUSD * usdToInr)
          : Number(tool?.capAmount ?? 0);
        const alertThresholdPct = hardLimitUSD !== null && softLimitUSD !== null
          ? Math.round((softLimitUSD / hardLimitUSD) * 100)
          : tool?.alertThresholdPct;
        const barPct = capAmount > 0
          ? Math.min(100, Math.round((amountINR / capAmount) * 100))
          : 0;

        await tx.tool.update({
          where: { id: integration.toolId },
          data: { usedAmount: amountINR, barPct, capAmount, alertThresholdPct },
        });
        await tx.toolIntegration.update({
          where: { id: integration.id },
          data: { lastSyncAt: new Date(), lastSyncAmountINR: amountINR, lastError: null },
        });
      });

      const capLog = hardLimitUSD !== null ? ` · cap ₹${Math.round(hardLimitUSD * usdToInr).toLocaleString('en-IN')}` : '';
      this.logger.log(`Synced ${integration.provider} → tool ${integration.toolId}: ₹${amountINR.toFixed(2)}${capLog}`);
    } catch (err: any) {
      this.logger.error(`Sync failed for ${integration.provider} (tool ${integration.toolId}): ${err.message}`);
      await this.prisma.toolIntegration.update({
        where: { id: integration.id },
        data: { lastError: err.message },
      });
    }
  }
}
