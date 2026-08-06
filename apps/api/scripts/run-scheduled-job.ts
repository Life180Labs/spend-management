/**
 * Entry point for Railway Cron Job services. Boots the app just enough to run
 * ONE scheduled job's logic (full Nest DI graph, no HTTP listener), then exits -
 * matching Railway's "start container, run task, exit" cron model, instead of
 * the always-alive server the in-process @Cron decorators in scheduler.service.ts
 * assume. Those decorators are disabled wherever DISABLE_INPROCESS_SCHEDULER=true
 * is set (see scheduler.service.ts), which must be set on any deployment using
 * this script, so the same job never runs from both places.
 *
 * Usage: npx ts-node scripts/run-scheduled-job.ts <jobName>
 * jobName is one of: syncIntegrations | checkThresholdAlerts | checkRenewalReminders
 *                   | rollForwardRenewalDates | recordCompletedMonthUsageBilling
 *
 * Railway Cron Job service start command, one per cadence:
 *   syncIntegrations                  - hourly
 *   checkThresholdAlerts              - hourly
 *   checkRenewalReminders             - daily at 9:00 (server timezone)
 *   rollForwardRenewalDates           - daily at 9:10 (server timezone)
 *   recordCompletedMonthUsageBilling  - monthly, 00:20 on the 1st
 * Matching crontab expressions are in scheduler.service.ts's @Cron decorators.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';

const VALID_JOBS = [
  'syncIntegrations',
  'checkThresholdAlerts',
  'checkRenewalReminders',
  'rollForwardRenewalDates',
  'recordCompletedMonthUsageBilling',
] as const;
type JobName = (typeof VALID_JOBS)[number];

async function main() {
  const jobName = process.argv[2] as JobName;
  if (!VALID_JOBS.includes(jobName)) {
    console.error(`Usage: run-scheduled-job.ts <jobName>\nValid job names: ${VALID_JOBS.join(', ')}`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  try {
    const scheduler = app.get(SchedulerService);
    console.log(`Running ${jobName}...`);
    await scheduler[jobName]();
    console.log(`✓ ${jobName} completed.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('❌ Scheduled job failed:', err);
  process.exit(1);
});
