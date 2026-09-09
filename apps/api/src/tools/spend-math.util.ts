/**
 * A tool's contribution to a "spend this month" total. PREPAID/CAPSUB are
 * already metered per-month (usedAmount). MOSUB is a flat subscription fee,
 * but that fee is only a monthly rate when billingCycle is MONTHLY - a YEARLY
 * subscription's monthlyAmount is its per-year cost, so it must be pro-rated
 * by /12 before summing it alongside monthly figures. ONETIME never
 * contributes here at all - its one real payment is captured as a single
 * billing_records row at creation (see ToolsService.create), picked up by the
 * closed-month aggregation for that month only, not as an ongoing monthly
 * rate the way MOSUB's monthlyAmount is. Used everywhere a monthly total or
 * "spend by category" breakdown aggregates tool costs - single source of
 * truth so Dashboard, Reports, and Billing History can't silently disagree
 * the way Dashboard/Usage History once did for Railway.
 */
export function monthlyEquivalentSpend(t: {
  paymentKind: string;
  billingCycle?: string | null;
  usedAmount: number;
  monthlyAmount: number;
}): number {
  if (t.paymentKind === 'ONETIME') return 0;
  const usageBased = t.paymentKind === 'PREPAID' || t.paymentKind === 'CAPSUB';
  if (usageBased) return t.usedAmount || 0;
  const raw = t.monthlyAmount || 0;
  return t.billingCycle === 'YEARLY' ? raw / 12 : raw;
}
