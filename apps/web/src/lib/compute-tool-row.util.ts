import { fmtDate } from './utils';

export interface Tool {
  id: string; name: string; vendor: string; category: string;
  paymentKind: string; billingCycle: string; monoInitials: string; monoBgColor: string;
  usedAmount: number; capAmount: number; monthlyAmount: number; // USD - the app's base currency
  barPct: number; alertThresholdPct: number; alert: boolean;
  statusSub: string; triggerEmail: string | null;
  renewalDate: string | null; daysUntilRenewal: number | null;
  isActive: boolean;
  integration: { provider: string; lastSyncAt: string | null; lastSyncAmountUSD: number | null; lastSyncRemainingBalanceUSD: number | null; isActive: boolean; lastError: string | null } | null;
}

// Extracted out of dashboard/page.tsx so it's independently unit-testable -
// a page.tsx file's exports are constrained by Next.js's App Router typed
// routes (only default/metadata/config/etc. are allowed), so a plain named
// export of this function from the page itself fails `tsc` even though it
// works fine at runtime.
export function computeRow(t: Tool, fmtAmt: (n: number) => string) {
  let statusMain = '';
  if (t.paymentKind === 'PREPAID') statusMain = `${fmtAmt(t.usedAmount)} / ${fmtAmt(t.capAmount)}`;
  else if (t.paymentKind === 'CAPSUB') statusMain = `${fmtAmt(t.monthlyAmount)} / ${fmtAmt(t.capAmount)}`;
  else if (t.paymentKind === 'MOSUB') statusMain = `${fmtAmt(t.monthlyAmount)} / ${t.billingCycle === 'YEARLY' ? 'yr' : 'mo'}`;
  else if (t.paymentKind === 'ONETIME') statusMain = `${fmtAmt(t.monthlyAmount)} · one-time`;

  const statusSubColor = t.alert ? '#F85149' : t.barPct >= 75 ? '#F5A623' : t.paymentKind === 'PREPAID' && t.barPct < 70 ? '#3FB950' : '#9aa0ab';
  const barColor = t.alert ? 'linear-gradient(90deg,#C9352B,#F85149)' : t.barPct >= 75 ? 'linear-gradient(90deg,#D9881F,#F5A623)' : t.paymentKind === 'PREPAID' ? 'linear-gradient(90deg,#2EA043,#3FB950)' : 'linear-gradient(90deg,#4F5BD5,#6470e0)';

  let renewMain = '-'; let renewSub = ''; let renewColor = '#9aa0ab'; let renewUrgent = false;

  if (t.renewalDate) {
    renewMain = fmtDate(t.renewalDate);
    const days = t.daysUntilRenewal;
    renewUrgent = days != null && days <= 5;
    if (renewUrgent) {
      renewSub = days === 0 ? 'renews today!' : `in ${days}d`;
      renewColor = days === 0 ? '#F85149' : '#F5A623';
    } else {
      renewSub = days != null && days <= 30 ? `in ${days}d` : 'auto-renews';
      renewColor = '#cfd3da';
    }
  } else if (t.paymentKind === 'PREPAID') {
    if (t.alert) { renewMain = 'Alert active'; renewSub = `breached ${t.alertThresholdPct}%`; renewColor = '#F85149'; }
    else { renewMain = 'Top-up rule'; renewSub = `at ${t.alertThresholdPct}% used`; renewColor = '#9aa0ab'; }
  }

  // "Wallet" is a display-only relabeling, not a new PaymentKind - it's still PREPAID
  // underneath (see docs/heygen-remaining-balance-loop-prompt.md for why a real new
  // enum value was rejected: 20+ unguarded paymentKind branches across this file and
  // add-tool-modal.tsx). Triggered purely by "does this integration report a balance."
  const isWallet = t.integration?.lastSyncRemainingBalanceUSD != null;
  // Teal (#0EA5A8) is already an established accent in this app (usage-history's
  // Memory metric) - reused here rather than inventing a new hue, and deliberately
  // distinct from the indigo Pre-paid badge and the amber/red low-balance warning
  // that can appear on the same row.
  const payBg = isWallet ? 'rgba(14,165,168,0.14)' : t.paymentKind === 'PREPAID' ? 'rgba(94,106,210,0.14)' : 'rgba(255,255,255,0.05)';
  const payColor = isWallet ? '#4fc9cb' : t.paymentKind === 'PREPAID' ? '#9aa2ef' : '#9aa0ab';
  const payLabel = isWallet ? 'Wallet'
    : t.paymentKind === 'PREPAID' ? 'Usage-based'
      : t.paymentKind === 'NOBUDGET' ? 'No budget'
        : t.paymentKind === 'ONETIME' ? 'One Time' : 'Subscription';

  return { statusMain, statusSubColor, barColor, renewMain, renewSub, renewColor, renewUrgent, payBg, payColor, payLabel };
}
