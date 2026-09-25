import { computeRow, monthsInPeriod, Tool } from './compute-tool-row.util';

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

describe('computeRow - Budget Status follows the Dashboard period filter', () => {
  const prepaid: Tool = {
    ...baseTool, name: 'Google Cloud', paymentKind: 'PREPAID',
    usedAmount: 0.39, capAmount: 5, barPct: 8, alertThresholdPct: 50, alert: false, statusSub: '8% used',
  };
  const mosub: Tool = { ...baseTool, name: 'Claude', paymentKind: 'MOSUB', monthlyAmount: 20, statusSub: 'cycle 0%' };

  it('keeps the live usedAmount/barPct/alert when no period is given ("This month")', () => {
    const row = computeRow({ ...prepaid, alert: true }, fmtAmt);
    expect(row.statusMain).toBe('$0.39 / $5');
    expect(row.barPct).toBe(8);
    expect(row.statusSub).toBe('8% used');
    expect(row.budgetAlert).toBe(true);
  });

  it('usage-based: shows the period spend against the monthly cap for a single-month period (Last month)', () => {
    const row = computeRow(prepaid, fmtAmt, { months: 1, amount: 4 });
    expect(row.statusMain).toBe('$4 / $5');
    expect(row.barPct).toBe(80);
    expect(row.statusSub).toBe('80% used');
    expect(row.budgetAlert).toBe(true); // 80% ≥ 50% threshold in that period
  });

  it('usage-based: scales the cap by the number of months for a multi-month period', () => {
    const row = computeRow(prepaid, fmtAmt, { months: 3, amount: 3 });
    expect(row.statusMain).toBe('$3 / $15');
    expect(row.barPct).toBe(20);
    expect(row.budgetAlert).toBe(false);
  });

  it('does not carry the live alert into a period where the threshold was not breached', () => {
    const row = computeRow({ ...prepaid, alert: true, barPct: 90 }, fmtAmt, { months: 1, amount: 1 });
    expect(row.barPct).toBe(20);
    expect(row.budgetAlert).toBe(false);
  });

  it('subscriptions: shows the period total instead of the per-month rate', () => {
    expect(computeRow(mosub, fmtAmt, { months: 3, amount: 60 }).statusMain).toBe('$60 / 3 mo');
    expect(computeRow(mosub, fmtAmt, { months: 1, amount: 20 }).statusMain).toBe('$20 / mo');
    expect(computeRow(mosub, fmtAmt).statusMain).toBe('$20 / mo');
  });

  it('monthsInPeriod counts the in-progress month, matching the backend window', () => {
    const sept = new Date(2026, 8, 25);
    expect(monthsInPeriod('this_month', sept)).toBe(1);
    expect(monthsInPeriod('last_month', sept)).toBe(1);
    expect(monthsInPeriod('this_quarter', sept)).toBe(3);
    expect(monthsInPeriod('this_quarter', new Date(2026, 9, 5))).toBe(1);
    expect(monthsInPeriod('year_to_date', sept)).toBe(9);
  });
});
