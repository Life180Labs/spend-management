import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { IntegrationRunnerService, PROVIDERS } from '../integrations/integration-runner.service';
import { BillingService } from '../billing/billing.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  // Dedup: toolId → epoch ms of last threshold alert email sent
  private readonly thresholdAlertSentAt = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private integrationRunner: IntegrationRunnerService,
    private billing: BillingService,
  ) { }

  // ── Integration data sync - every 15 minutes ─────────────────────
  @Cron('*/15 * * * *')
  async syncIntegrations() {
    await this.integrationRunner.runAll();
  }

  // ── Threshold breach check - every 5 minutes ──────────────────────
  @Cron('*/5 * * * *')
  async checkThresholdAlerts() {
    const tools = await this.prisma.tool.findMany({
      where: {
        deletedAt: null,
        paymentKind: 'PREPAID',
        triggerEmail: { not: null },
      },
    });

    for (const tool of tools) {
      if (!tool.triggerEmail) continue;
      if (tool.barPct < tool.alertThresholdPct) continue;

      // Skip if already sent within the last 24 hours for this tool
      const lastSent = this.thresholdAlertSentAt.get(tool.id) ?? 0;
      if (Date.now() - lastSent < 24 * 60 * 60 * 1000) continue;

      try {
        await this.mail.sendThresholdAlert(
          tool.triggerEmail,
          tool.name,
          tool.vendor,
          tool.barPct,
          tool.alertThresholdPct,
          tool.capAmount,
        );
        this.thresholdAlertSentAt.set(tool.id, Date.now());
      } catch (err: any) {
        this.logger.error(`Threshold alert failed for ${tool.name}: ${err.message}`);
      }
    }
  }

  // ── Renewal reminder - daily at 9 AM ─────────────────────────────
  @Cron('0 9 * * *')
  async checkRenewalReminders() {
    const now = new Date();
    const in5Days = new Date();
    in5Days.setDate(now.getDate() + 5);
    // Include today (daysAway = 0)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const tools = await this.prisma.tool.findMany({
      where: {
        deletedAt: null,
        renewalDate: { lte: in5Days, gte: startOfToday },
        triggerEmail: { not: null },
      },
    });

    for (const tool of tools) {
      if (!tool.triggerEmail || !tool.renewalDate) continue;

      const daysAway = Math.max(
        0,
        Math.ceil((new Date(tool.renewalDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      );

      try {
        await this.mail.sendRenewalReminder(
          tool.triggerEmail,
          tool.name,
          tool.vendor,
          new Date(tool.renewalDate),
          daysAway,
          tool.monthlyAmount,
        );
      } catch (err: any) {
        this.logger.error(`Renewal reminder failed for ${tool.name}: ${err.message}`);
      }
    }
  }

  // ── Roll forward past renewal dates - daily at 9:10 AM, right after the ──
  // reminder check above so a "renews today" (daysAway = 0) email still goes
  // out with the correct date before this advances it to the next cycle.
  // Only MOSUB/CAPSUB are recurring billing cycles - PREPAID's renewalDate is
  // a contract/license term, not a recurring one, so it's left alone here.
  // Cadence itself (monthly vs yearly) comes from each tool's billingCycle -
  // this is not "the monthly cron," it just happens to run once a day.
  @Cron('10 9 * * *')
  async rollForwardRenewalDates() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const tools = await this.prisma.tool.findMany({
      where: {
        deletedAt: null,
        paymentKind: { in: ['MOSUB', 'CAPSUB'] },
        renewalDate: { lt: startOfToday },
      },
    });

    for (const tool of tools) {
      if (!tool.renewalDate) continue;

      const { completedCycles, next } = this.advancePeriodUntilAfter(new Date(tool.renewalDate), startOfToday, tool.billingCycle);

      // Each renewal date we stepped past is a billing cycle that completed (the
      // subscription auto-renewed) - log it so it shows up in Reports > Billing
      // History without anyone having to enter it by hand. Idempotent: re-running
      // for a cycle already recorded is a no-op (see recordCompletedCycle).
      for (const billedAt of completedCycles) {
        const monthKey = `${billedAt.getFullYear()}-${String(billedAt.getMonth() + 1).padStart(2, '0')}`;
        try {
          await this.billing.recordCompletedCycle(tool.orgId, tool.id, monthKey, tool.monthlyAmount, billedAt);
        } catch (err: any) {
          this.logger.error(`Failed to auto-log billing cycle for ${tool.name} (${monthKey}): ${err.message}`);
        }
      }

      await this.prisma.tool.update({
        where: { id: tool.id },
        data: { renewalDate: next },
      });
      this.logger.log(
        `Rolled forward renewal date for ${tool.name}: ${new Date(tool.renewalDate).toDateString()} → ${next.toDateString()}`,
      );
    }
  }

  // ── Log completed-month billing for usage-based integrated tools - ───────
  // once a month, just after midnight on the 1st. Subscriptions get a billing
  // record from the renewal-date rollover above (keyed to their own billing
  // anniversary); PREPAID tools have no such date - their spend is metered
  // continuously by the provider - so this closes the calendar month instead,
  // pulling the authoritative final total via the same fetchHistoricalSpendUSD
  // path Usage History's "Last Month" view uses (never the possibly-stale
  // `usedAmount` snapshot, which reflects "so far this new month" by the time
  // this runs). Together with the rollover cron, every tool with a connected
  // integration or a subscription now gets a Billing History entry automatically.
  @Cron('20 0 1 * *')
  async recordCompletedMonthUsageBilling() {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(startOfThisMonth.getTime() - 1);
    const monthKey = `${startOfPrevMonth.getFullYear()}-${String(startOfPrevMonth.getMonth() + 1).padStart(2, '0')}`;

    const tools = await this.prisma.tool.findMany({
      where: { deletedAt: null, paymentKind: 'PREPAID' },
      include: { integration: true },
    });

    for (const tool of tools) {
      const integration = tool.integration;
      if (!integration?.isActive) continue;

      const provider = PROVIDERS[integration.provider];
      if (!provider?.fetchHistoricalSpendUSD) continue;

      try {
        const { amountUSD } = await provider.fetchHistoricalSpendUSD(
          integration.config as Record<string, any>,
          { startDate: startOfPrevMonth, endDate: startOfThisMonth },
        );
        await this.billing.recordCompletedCycle(tool.orgId, tool.id, monthKey, amountUSD, endOfPrevMonth);
        this.logger.log(`Logged completed-month billing for ${tool.name} (${monthKey}): $${amountUSD.toFixed(2)}`);
      } catch (err: any) {
        this.logger.error(`Failed to log completed-month billing for ${tool.name} (${monthKey}): ${err.message}`);
      }
    }
  }

  /**
   * Adds one billing period (a month, or a year) to `date` at a time until it's
   * on/after `untilAfter`, clamping the day to the last valid day of the target
   * month (e.g. MONTHLY: Jan 31 → Feb 28, not Mar 3; YEARLY: Feb 29 on a leap
   * year → Feb 28 the following year). Returns every intermediate date stepped
   * past (each one a completed billing cycle) alongside the final resulting
   * date. Capped at 60 iterations (5 years of MONTHLY, or 60 years of YEARLY -
   * either way, comfortably beyond any real data anomaly) so it can't loop forever.
   */
  private advancePeriodUntilAfter(date: Date, untilAfter: Date, cycle: string): { completedCycles: Date[]; next: Date } {
    const day = date.getDate();
    const completedCycles: Date[] = [];
    let result = date;
    let iterations = 0;

    while (result < untilAfter && iterations < 60) {
      completedCycles.push(result);
      const targetYear = cycle === 'YEARLY' ? result.getFullYear() + 1 : result.getFullYear();
      const targetMonthIndex = cycle === 'YEARLY' ? result.getMonth() : result.getMonth() + 1;
      const daysInTargetMonth = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
      result = new Date(targetYear, targetMonthIndex, Math.min(day, daysInTargetMonth));
      iterations++;
    }

    return { completedCycles, next: result };
  }
}
