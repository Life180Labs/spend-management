import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService, ThresholdAlertItem, UpcomingRenewalItem } from '../mail/mail.service';
import { IntegrationRunnerService, PROVIDERS } from '../integrations/integration-runner.service';
import { BillingService } from '../billing/billing.service';
import { advancePeriodUntilAfter } from './renewal-cycle.util';

// Set on any deployment where these jobs are instead triggered externally
// (e.g. Railway Cron Job services calling scripts/run-scheduled-job.ts) - a
// serverless/sleeping web service has no running process to fire an in-process
// timer anyway, but this also prevents double-running if the web service ever
// does happen to be awake when Railway's own scheduler fires the same job.
const IN_PROCESS_CRON_DISABLED = process.env.DISABLE_INPROCESS_SCHEDULER === 'true';

// Postgres can run in Railway's own Serverless mode independently of this API
// service - if it's been idle 10+ minutes it sleeps, and the first connection
// attempt after that can fail while it wakes back up (a known Railway cold-start
// race, not specific to this app). Rather than let that one-off failure abort
// a scheduled job, every job probes the DB with a cheap query first and retries
// with backoff - by the time the probe succeeds, Postgres is confirmed awake
// and the job's real queries proceed normally.
const DB_WAKE_MAX_ATTEMPTS = 6; // ~2+4+6+8+10s = 30s total before giving up

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

  // Probes the DB and retries on a connection-unreachable error (Postgres
  // waking from sleep) before running `fn`. Any other error, or exhausting all
  // retries, is logged and the run is skipped - never thrown, so one sleepy
  // Postgres never crashes the process or breaks the next scheduled tick.
  private async runWithDbRetry(jobName: string, fn: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= DB_WAKE_MAX_ATTEMPTS; attempt++) {
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        break;
      } catch (err: any) {
        const isConnectionError = err?.code === 'P1001' || /Can't reach database server/i.test(err?.message ?? '');
        if (!isConnectionError) {
          this.logger.error(`${jobName}: non-connection database error, aborting this run - ${err.message}`);
          return;
        }
        if (attempt === DB_WAKE_MAX_ATTEMPTS) {
          this.logger.error(`${jobName}: database still unreachable after ${DB_WAKE_MAX_ATTEMPTS} attempts - skipping this run`);
          return;
        }
        const delayMs = attempt * 2000;
        this.logger.warn(`${jobName}: database unreachable (attempt ${attempt}/${DB_WAKE_MAX_ATTEMPTS}), likely waking from Serverless sleep - retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    await fn();
  }

  // ── Integration data sync - every 15 minutes ─────────────────────
  @Cron('*/15 * * * *', { disabled: IN_PROCESS_CRON_DISABLED })
  async syncIntegrations() {
    await this.runWithDbRetry('syncIntegrations', () => this.integrationRunner.runAll());
  }

  // ── Threshold breach check - every 5 minutes. Multiple tools can breach for ──
  // the same recipient in one cycle (e.g. two PREPAID tools sharing an alert
  // email) - group by recipient first so each person gets ONE consolidated
  // email listing every breaching tool, not one email per tool.
  @Cron('*/5 * * * *', { disabled: IN_PROCESS_CRON_DISABLED })
  async checkThresholdAlerts() {
    await this.runWithDbRetry('checkThresholdAlerts', () => this.checkThresholdAlertsImpl());
  }

  private async checkThresholdAlertsImpl() {
    const tools = await this.prisma.tool.findMany({
      where: {
        deletedAt: null,
        paymentKind: 'PREPAID',
        triggerEmail: { not: null },
      },
    });

    const byRecipient = new Map<string, { tool: typeof tools[number]; item: ThresholdAlertItem }[]>();

    for (const tool of tools) {
      if (!tool.triggerEmail) continue;
      if (tool.barPct < tool.alertThresholdPct) continue;

      // Skip if already sent within the last 24 hours for this tool
      const lastSent = this.thresholdAlertSentAt.get(tool.id) ?? 0;
      if (Date.now() - lastSent < 24 * 60 * 60 * 1000) continue;

      const item: ThresholdAlertItem = {
        toolName: tool.name,
        vendor: tool.vendor,
        barPct: tool.barPct,
        thresholdPct: tool.alertThresholdPct,
        capAmount: tool.capAmount,
      };
      const group = byRecipient.get(tool.triggerEmail) ?? [];
      group.push({ tool, item });
      byRecipient.set(tool.triggerEmail, group);
    }

    if (byRecipient.size === 0) return;

    // Also surface each recipient's upcoming renewals (same 5-day lookahead as
    // checkRenewalReminders below) in the same email, so a budget-breach alert
    // doubles as a heads-up for a renewal the recipient might otherwise only
    // see in a separate reminder email later.
    const now = new Date();
    const in5Days = new Date();
    in5Days.setDate(now.getDate() + 5);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const renewingTools = await this.prisma.tool.findMany({
      where: {
        deletedAt: null,
        renewalDate: { lte: in5Days, gte: startOfToday },
        triggerEmail: { in: Array.from(byRecipient.keys()) },
      },
    });

    const renewalsByRecipient = new Map<string, UpcomingRenewalItem[]>();
    for (const t of renewingTools) {
      if (!t.triggerEmail || !t.renewalDate) continue;
      const daysAway = Math.max(
        0,
        Math.ceil((new Date(t.renewalDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      );
      const item: UpcomingRenewalItem = {
        toolName: t.name,
        vendor: t.vendor,
        renewalDate: new Date(t.renewalDate),
        daysAway,
        monthlyAmount: t.monthlyAmount,
      };
      const list = renewalsByRecipient.get(t.triggerEmail) ?? [];
      list.push(item);
      renewalsByRecipient.set(t.triggerEmail, list);
    }

    for (const [email, group] of byRecipient) {
      try {
        await this.mail.sendThresholdAlert(email, group.map((g) => g.item), renewalsByRecipient.get(email) ?? []);
        const sentAt = Date.now();
        for (const g of group) this.thresholdAlertSentAt.set(g.tool.id, sentAt);
      } catch (err: any) {
        this.logger.error(`Threshold alert failed for ${email} (${group.map((g) => g.tool.name).join(', ')}): ${err.message}`);
      }
    }
  }

  // ── Renewal reminder - daily at 9 AM ─────────────────────────────
  @Cron('0 9 * * *', { disabled: IN_PROCESS_CRON_DISABLED })
  async checkRenewalReminders() {
    await this.runWithDbRetry('checkRenewalReminders', () => this.checkRenewalRemindersImpl());
  }

  private async checkRenewalRemindersImpl() {
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
  @Cron('10 9 * * *', { disabled: IN_PROCESS_CRON_DISABLED })
  async rollForwardRenewalDates() {
    await this.runWithDbRetry('rollForwardRenewalDates', () => this.rollForwardRenewalDatesImpl());
  }

  private async rollForwardRenewalDatesImpl() {
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

      const { completedCycles, next } = advancePeriodUntilAfter(new Date(tool.renewalDate), startOfToday, tool.billingCycle);

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
  @Cron('20 0 1 * *', { disabled: IN_PROCESS_CRON_DISABLED })
  async recordCompletedMonthUsageBilling() {
    await this.runWithDbRetry('recordCompletedMonthUsageBilling', () => this.recordCompletedMonthUsageBillingImpl());
  }

  private async recordCompletedMonthUsageBillingImpl() {
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
}
