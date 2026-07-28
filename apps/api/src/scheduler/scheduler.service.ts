import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { IntegrationRunnerService } from '../integrations/integration-runner.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  // Dedup: toolId → epoch ms of last threshold alert email sent
  private readonly thresholdAlertSentAt = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private integrationRunner: IntegrationRunnerService,
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
}
