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
export type SpendPeriod = 'this_month' | 'last_month' | 'this_quarter' | 'year_to_date';

// How many calendar months the Dashboard's period dropdown spans - mirrors the
// backend's monthKeysForPeriod (reports.service.ts), which counts the
// in-progress current month, so "This quarter" in September is 3 and "Year to
// date" in September is 9.
export function monthsInPeriod(period: SpendPeriod, now: Date = new Date()): number {
  if (period === 'this_quarter') return (now.getMonth() % 3) + 1;
  if (period === 'year_to_date') return now.getMonth() + 1;
  return 1;
}

// Period context for the Budget Status column. Omitted for "This month",
// which keeps the tool's live usedAmount/barPct/alert exactly as before.
// For any other period, budgeted tools show the period's spend (the same
// per-tool figure as the period-spend column) against the monthly cap scaled
// to the period's length, and subscriptions show their period total.
export interface BudgetPeriod { months: number; amount: number }

export function computeRow(t: Tool, fmtAmt: (n: number) => string, budgetPeriod?: BudgetPeriod) {
  const months = budgetPeriod?.months ?? 1;
  const periodCap = t.capAmount * months;
  const used = budgetPeriod ? budgetPeriod.amount : t.usedAmount;
  const barPct = !budgetPeriod ? t.barPct : periodCap > 0 ? Math.round((budgetPeriod.amount / periodCap) * 100) : 0;
  // Live alert for this month; for a past/multi-month period, "breached" means
  // that period's spend crossed the threshold of its scaled cap.
  const budgetAlert = !budgetPeriod ? t.alert
    : (t.paymentKind === 'PREPAID' || t.paymentKind === 'CAPSUB') && periodCap > 0 && barPct >= t.alertThresholdPct;
  const statusSub = !budgetPeriod ? t.statusSub
    : t.paymentKind === 'PREPAID' ? `${barPct}% used`
      : t.paymentKind === 'CAPSUB' ? `${barPct}% of cap`
        : t.statusSub;
  const periodUnit = months > 1 ? `${months} mo` : 'mo';

  let statusMain = '';
  if (t.paymentKind === 'PREPAID') statusMain = `${fmtAmt(used)} / ${fmtAmt(periodCap)}`;
  else if (t.paymentKind === 'CAPSUB') statusMain = `${fmtAmt(budgetPeriod ? budgetPeriod.amount : t.monthlyAmount)} / ${fmtAmt(periodCap)}`;
  else if (t.paymentKind === 'MOSUB') statusMain = budgetPeriod
    ? `${fmtAmt(budgetPeriod.amount)} / ${periodUnit}`
    : `${fmtAmt(t.monthlyAmount)} / ${t.billingCycle === 'YEARLY' ? 'yr' : 'mo'}`;
  else if (t.paymentKind === 'ONETIME') statusMain = `${fmtAmt(t.monthlyAmount)} · one-time`;

  const statusSubColor = budgetAlert ? 'var(--c-f85149)' : barPct >= 75 ? 'var(--c-f5a623)' : t.paymentKind === 'PREPAID' && barPct < 70 ? 'var(--c-3fb950)' : 'var(--c-9aa0ab)';
  const barColor = budgetAlert ? 'linear-gradient(90deg,#C9352B,var(--c-f85149))' : barPct >= 75 ? 'linear-gradient(90deg,#D9881F,var(--c-f5a623))' : t.paymentKind === 'PREPAID' ? 'linear-gradient(90deg,#2EA043,var(--c-3fb950))' : 'linear-gradient(90deg,#4F5BD5,#6470e0)';

  let renewMain = '-'; let renewSub = ''; let renewColor = 'var(--c-9aa0ab)'; let renewUrgent = false;

  if (t.renewalDate) {
    renewMain = fmtDate(t.renewalDate);
    const days = t.daysUntilRenewal;
    renewUrgent = days != null && days <= 5;
    if (renewUrgent) {
      renewSub = days === 0 ? 'renews today!' : `in ${days}d`;
      renewColor = days === 0 ? 'var(--c-f85149)' : 'var(--c-f5a623)';
    } else {
      renewSub = days != null && days <= 30 ? `in ${days}d` : 'auto-renews';
      renewColor = 'var(--c-cfd3da)';
    }
  } else if (t.paymentKind === 'PREPAID') {
    if (t.alert) { renewMain = 'Alert active'; renewSub = `breached ${t.alertThresholdPct}%`; renewColor = 'var(--c-f85149)'; }
    else { renewMain = 'Top-up rule'; renewSub = `at ${t.alertThresholdPct}% used`; renewColor = 'var(--c-9aa0ab)'; }
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
  const payBg = isWallet ? 'rgba(14,165,168,0.14)' : t.paymentKind === 'PREPAID' ? 'rgba(94,106,210,0.14)' : 'rgba(var(--fg-rgb),0.05)';
  const payColor = isWallet ? 'var(--c-4fc9cb)' : t.paymentKind === 'PREPAID' ? 'var(--c-9aa2ef)' : 'var(--c-9aa0ab)';
  const payLabel = isWallet ? 'Wallet'
    : t.paymentKind === 'PREPAID' ? 'Usage-based'
      : t.paymentKind === 'NOBUDGET' ? 'No budget'
        : t.paymentKind === 'ONETIME' ? 'One Time' : 'Subscription';

  return { statusMain, statusSub, barPct, budgetAlert, statusSubColor, barColor, renewMain, renewSub, renewColor, renewUrgent, payBg, payColor, payLabel };
}
