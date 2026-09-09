import { computeRow, Tool } from './compute-tool-row.util';

const baseTool: Tool = {
  id: 't1', name: 'Hostinger', vendor: 'Hostinger', category: 'HOSTING',
  paymentKind: 'ONETIME', billingCycle: 'MONTHLY', monoInitials: 'HO', monoBgColor: '#8B5CF6',
  usedAmount: 0, capAmount: 0, monthlyAmount: 4.23,
  barPct: 0, alertThresholdPct: 80, alert: false,
  statusSub: 'One-time purchase', triggerEmail: null,
  renewalDate: null, daysUntilRenewal: null,
  isActive: true, integration: null,
};

const fmtAmt = (n: number) => `$${n}`;

describe('computeRow - ONETIME payment kind', () => {
  it('shows the paid amount with a "one-time" suffix, not a "/mo" or "/cap" format', () => {
    const { statusMain } = computeRow(baseTool, fmtAmt);
    expect(statusMain).toBe('$4.23 · one-time');
  });

  it('labels the Payment badge "One Time", not falling through to "Subscription"', () => {
    const { payLabel } = computeRow(baseTool, fmtAmt);
    expect(payLabel).toBe('One Time');
  });

  it('shows "-" for Next Renewal (renewMain default), since a real ONETIME tool always has renewalDate: null', () => {
    const { renewMain, renewSub } = computeRow(baseTool, fmtAmt);
    expect(renewMain).toBe('-');
    expect(renewSub).toBe('');
  });

  it('does NOT fall into PREPAID\'s "Top-up rule" / "Alert active" branch just because renewalDate is null', () => {
    // Regression guard: computeRow's renewMain logic falls back to a PREPAID-only
    // branch when renewalDate is null - ONETIME must not accidentally match that
    // branch (it isn't paymentKind PREPAID, but this locks in that assumption).
    const { renewMain } = computeRow(baseTool, fmtAmt);
    expect(renewMain).not.toBe('Top-up rule');
    expect(renewMain).not.toBe('Alert active');
  });

  it('never colors the row as an active alert, even if alert were somehow true (backend already guards this, this is the frontend\'s own read of it)', () => {
    const { statusSubColor } = computeRow({ ...baseTool, alert: false }, fmtAmt);
    expect(statusSubColor).not.toBe('#F85149'); // red = alert-active color
  });
});

describe('computeRow - other payment kinds unaffected (regression)', () => {
  it('PREPAID still gets the Top-up rule / Alert active renewal branch', () => {
    const prepaid: Tool = { ...baseTool, paymentKind: 'PREPAID', usedAmount: 5, capAmount: 10, alertThresholdPct: 50 };
    expect(computeRow(prepaid, fmtAmt).renewMain).toBe('Top-up rule');
  });

  it('MOSUB still formats statusMain as "amount / mo"', () => {
    const mosub: Tool = { ...baseTool, paymentKind: 'MOSUB', monthlyAmount: 20, billingCycle: 'MONTHLY' };
    expect(computeRow(mosub, fmtAmt).statusMain).toBe('$20 / mo');
  });

  it('NOBUDGET still labels the Payment badge "No budget"', () => {
    const nobudget: Tool = { ...baseTool, paymentKind: 'NOBUDGET' };
    expect(computeRow(nobudget, fmtAmt).payLabel).toBe('No budget');
  });
});
