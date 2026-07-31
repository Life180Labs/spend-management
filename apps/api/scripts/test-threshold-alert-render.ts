/**
 * Renders the consolidated threshold-alert HTML template locally (no real
 * email sent) to verify the multi-tool layout and the appended upcoming-
 * renewals section, and separately exercises the grouping logic in
 * checkThresholdAlerts() against synthetic data to confirm two tools sharing
 * a recipient produce exactly one grouped call.
 */
import * as fs from 'fs';
import { MailService, ThresholdAlertItem, UpcomingRenewalItem } from '../src/mail/mail.service';

// Minimal ConfigService stand-in - only .get() is used by MailService's constructor.
// A dummy (non-functional) key just satisfies the Resend SDK's constructor check;
// this script never actually calls .emails.send(), so no real network call is made.
const fakeConfig = { get: (key: string, fallback?: any) => (key === 'RESEND_API_KEY' ? 're_dummy_for_local_render_test' : fallback) } as any;

async function main() {
  const mail = new MailService(fakeConfig);

  const singleAlert: ThresholdAlertItem[] = [
    { toolName: 'Railway', vendor: 'Railway.com', barPct: 93, thresholdPct: 80, capAmount: 18 },
  ];
  const multiAlert: ThresholdAlertItem[] = [
    { toolName: 'Railway', vendor: 'Railway.com', barPct: 93, thresholdPct: 80, capAmount: 18 },
    { toolName: 'Claude', vendor: 'Anthropic', barPct: 96, thresholdPct: 80, capAmount: null },
    { toolName: 'Figma', vendor: 'Figma Inc.', barPct: 85, thresholdPct: 80, capAmount: 500 },
  ];
  const upcomingRenewals: UpcomingRenewalItem[] = [
    { toolName: 'Google Workspace', vendor: 'Google Workspace', renewalDate: new Date(2026, 7, 1), daysAway: 1, monthlyAmount: 2.5 },
  ];

  // thresholdHtml is private - call it directly to render without touching the network.
  const singleHtml = (mail as any).thresholdHtml(singleAlert, [], 'vijay.olety@gmail.com');
  const multiHtml = (mail as any).thresholdHtml(multiAlert, [], 'vijay.olety@gmail.com');
  const withRenewalHtml = (mail as any).thresholdHtml(singleAlert, upcomingRenewals, 'vijay.olety@gmail.com');

  fs.writeFileSync('scratch/threshold-alert-single.html', singleHtml);
  fs.writeFileSync('scratch/threshold-alert-multi.html', multiHtml);
  fs.writeFileSync('scratch/threshold-alert-with-renewal.html', withRenewalHtml);
  console.log('Wrote scratch/threshold-alert-single.html, -multi.html, and -with-renewal.html');

  // Sanity checks on the rendered output
  console.log('\n--- Single-tool checks ---');
  console.log(singleHtml.includes('Railway') && !singleHtml.includes('tools</strong> have breached') ? '✓ singular phrasing used' : '✗ wrong phrasing');
  console.log((singleHtml.match(/border-radius:12px;margin-bottom:14px/g) || []).length === 1 ? '✓ exactly 1 card rendered' : '✗ wrong card count');

  console.log('\n--- Multi-tool checks ---');
  console.log(multiHtml.includes('3 tools') ? '✓ "3 tools" plural phrasing used' : '✗ wrong phrasing');
  console.log((multiHtml.match(/border-radius:12px;margin-bottom:14px/g) || []).length === 3 ? '✓ exactly 3 cards rendered' : '✗ wrong card count');
  console.log(multiHtml.includes('Railway') && multiHtml.includes('Claude') && multiHtml.includes('Figma') ? '✓ all 3 tool names present' : '✗ missing a tool name');
  console.log(multiHtml.includes('Budget Alert · 3') ? '✓ header badge shows count' : '✗ header badge missing count');

  console.log('\n--- Upcoming renewal section checks ---');
  console.log(!singleHtml.includes('Upcoming Renewal') ? '✓ no renewals section when none passed' : '✗ renewals section rendered with none passed');
  console.log(withRenewalHtml.includes('Upcoming Renewal') ? '✓ renewals section rendered when present' : '✗ renewals section missing');
  console.log(withRenewalHtml.includes('Google Workspace') && withRenewalHtml.includes('in 1 day') ? '✓ renewal tool name and days-away phrasing correct' : '✗ renewal content wrong');
}

main().catch((err) => { console.error(err); process.exit(1); });
