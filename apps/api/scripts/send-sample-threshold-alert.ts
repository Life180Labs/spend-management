/**
 * Sends a real sample consolidated threshold-alert email (2+ tools) using the
 * actual MailService.sendThresholdAlert path, so the recipient can see exactly
 * what the redesigned template looks like in a real inbox.
 *
 * Usage: npx ts-node scripts/send-sample-threshold-alert.ts <recipient-email>
 */
import { ConfigService } from '@nestjs/config';
import { MailService, ThresholdAlertItem } from '../src/mail/mail.service';

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: ts-node scripts/send-sample-threshold-alert.ts <recipient-email>');
    process.exit(1);
  }

  const config = new ConfigService();
  const mail = new MailService(config);

  const sampleAlerts: ThresholdAlertItem[] = [
    { toolName: 'Railway', vendor: 'Railway.com', barPct: 93, thresholdPct: 80, capAmount: 18 },
    { toolName: 'Claude', vendor: 'Anthropic', barPct: 96, thresholdPct: 80, capAmount: null },
    { toolName: 'Figma', vendor: 'Figma Inc.', barPct: 85, thresholdPct: 80, capAmount: 500 },
  ];

  await mail.sendThresholdAlert(to, sampleAlerts);
  console.log(`Sample consolidated threshold alert (3 tools) sent to ${to}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
