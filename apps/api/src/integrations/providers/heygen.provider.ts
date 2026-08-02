import { Logger } from '@nestjs/common';
import { IntegrationProvider, SpendResult } from '../provider.interface';

// HeyGen API - https://developers.heygen.com/docs/api-key
// Authenticated via an `X-Api-Key` header (a real API key, not OAuth).
const USER_ME_URL = 'https://api.heygen.com/v3/users/me';

// No fetchLimitsUSD, no fetchHistoricalSpendUSD: HeyGen's API has no documented
// spend-limit/budget endpoint and no historical/transaction-log endpoint - only a
// live "how much is left in the wallet" figure. Inventing either would mean
// fabricating behavior HeyGen doesn't actually expose - see fetchSpendUSD below
// for how spend itself is derived instead.
export class HeyGenProvider implements IntegrationProvider {
  private readonly logger = new Logger(HeyGenProvider.name);

  /**
   * HeyGen's wallet is prepaid and declining - the API only ever reports a
   * remaining USD balance, never a queryable "spend in this date range" total
   * the way Railway/Claude's APIs do. So "spend this month" has to be derived
   * by tracking the balance across syncs:
   *   - balance dropped since the last sync  → that drop is spend, accumulate it
   *   - balance rose since the last sync      → a manual top-up, not spend -
   *                                              don't subtract it from the total
   *   - a new calendar month has started      → last month's accumulator no
   *                                              longer applies, reset to 0
   *   - no prior baseline (first sync ever)   → spend before this point is
   *                                              unknowable, start at 0
   * The running accumulator + last-seen balance + the month it belongs to are
   * persisted back into ToolIntegration.config via providerState, since this
   * provider (unlike Railway/Claude) can't recompute the total from scratch.
   */
  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    const { apiKey } = config;
    if (!apiKey) throw new Error('HeyGen config missing apiKey');

    const resp = await fetch(USER_ME_URL, { headers: { 'X-Api-Key': apiKey } });
    const json = (await resp.json()) as any;

    if (!resp.ok) {
      const message = json?.message ?? json?.error?.message ?? `HTTP ${resp.status}`;
      throw new Error(`HeyGen API error: ${message}`);
    }

    const currentBalance = json?.data?.wallet?.remaining_balance;
    if (typeof currentBalance !== 'number') {
      // A malformed/unexpected response is NOT "zero spend" - reporting it as such
      // would overwrite the last known-good total with a false number. Fail loud
      // instead, same principle Railway's provider uses for its rate-limit case.
      throw new Error('HeyGen response missing wallet.remaining_balance - check the API key has wallet billing access.');
    }

    const currentMonthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    const storedBalance: number | undefined = config.heygenLastBalance;
    const storedSpend: number = typeof config.heygenPeriodSpend === 'number' ? config.heygenPeriodSpend : 0;
    const storedMonthKey: string | undefined = config.heygenPeriodMonthKey;

    let periodSpend: number;
    if (typeof storedBalance !== 'number' || storedMonthKey !== currentMonthKey) {
      // First sync ever, or a new calendar month started since the last one - start fresh.
      periodSpend = 0;
    } else {
      const delta = storedBalance - currentBalance; // positive = spent, negative/zero = topped up or unchanged
      periodSpend = delta > 0 ? storedSpend + delta : storedSpend;
    }

    this.logger.log(
      `HeyGen wallet: $${currentBalance.toFixed(2)} remaining, $${periodSpend.toFixed(2)} spent this month`,
    );

    return {
      amountUSD: periodSpend,
      remainingBalanceUSD: currentBalance,
      providerState: {
        heygenLastBalance: currentBalance,
        heygenPeriodSpend: periodSpend,
        heygenPeriodMonthKey: currentMonthKey,
      },
    };
  }
}
