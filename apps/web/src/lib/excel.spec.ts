import * as XLSX from 'xlsx';
import { exportBillingHistory, exportSpendAnalysis, exportToolsList } from './excel';

describe('exportToolsList', () => {
  let jsonToSheetSpy: jest.SpyInstance;

  beforeEach(() => {
    jsonToSheetSpy = jest.spyOn(XLSX.utils, 'json_to_sheet');
    jest.spyOn(XLSX, 'writeFile').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('labels a tool reporting a remaining balance as "Wallet", matching the Dashboard\'s relabeling', () => {
    exportToolsList(
      [
        {
          name: 'HeyGen', vendor: 'HeyGen', category: 'AI_LLM', paymentKind: 'PREPAID',
          usedAmount: 0, capAmount: 20, monthlyAmount: 0, barPct: 0, alertThresholdPct: 80, alert: false,
          triggerEmail: null, renewalDate: null, daysUntilRenewal: null,
          integration: { lastSyncRemainingBalanceUSD: 4.28 },
        },
      ],
      'All',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Payment Type']).toBe('Wallet');
    expect(rows[0]['Remaining Balance ($)']).toBe('4.28');
  });

  it('keeps the normal PaymentKind label and shows "-" for Remaining Balance when no balance is reported', () => {
    exportToolsList(
      [
        {
          name: 'Railway', vendor: 'Railway.com', category: 'CLOUD_INFRA', paymentKind: 'PREPAID',
          usedAmount: 16.68, capAmount: 20, monthlyAmount: 0, barPct: 83, alertThresholdPct: 80, alert: true,
          triggerEmail: null, renewalDate: null, daysUntilRenewal: null,
          integration: { lastSyncRemainingBalanceUSD: null },
        },
      ],
      'All',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Payment Type']).toBe('Usage-based');
    expect(rows[0]['Remaining Balance ($)']).toBe('-');
  });

  it('shows "-" for Remaining Balance for a tool with no integration at all (e.g. Namecheap)', () => {
    exportToolsList(
      [
        {
          name: 'Namecheap', vendor: 'Namecheap', category: 'HOSTING', paymentKind: 'MOSUB',
          usedAmount: 0, capAmount: 0, monthlyAmount: 10, barPct: 0, alertThresholdPct: 80, alert: false,
          triggerEmail: null, renewalDate: null, daysUntilRenewal: null,
        },
      ],
      'All',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Payment Type']).toBe('Subscription');
    expect(rows[0]['Remaining Balance ($)']).toBe('-');
  });
});

describe('exportSpendAnalysis', () => {
  let jsonToSheetSpy: jest.SpyInstance;

  beforeEach(() => {
    jsonToSheetSpy = jest.spyOn(XLSX.utils, 'json_to_sheet');
    jest.spyOn(XLSX, 'writeFile').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('adds Start Date / End Date rows to the Summary sheet, formatted dd/mmm/yyyy', () => {
    exportSpendAnalysis(
      [{ category: 'AI_LLM', total: 20, pct: 100 }],
      [{ label: 'Total Monthly Spend', value: '$20.00' }],
      'USD',
      94.4,
      new Date(2026, 7, 1), // 1 Aug 2026
      new Date(2026, 7, 9), // 9 Aug 2026
    );

    // The Summary sheet (Start Date/End Date + stats) is built and appended first,
    // before the By Category sheet - so it's the first json_to_sheet() call.
    const summaryRows = jsonToSheetSpy.mock.calls[0][0];
    expect(summaryRows[0]).toEqual({ Metric: 'Start Date', Value: '01/Aug/2026' });
    expect(summaryRows[1]).toEqual({ Metric: 'End Date', Value: '09/Aug/2026' });
    expect(summaryRows[2]).toEqual({ Metric: 'Total Monthly Spend', Value: '$20.00' });
  });

  it('pads single-digit days with a leading zero', () => {
    exportSpendAnalysis([], [], 'USD', 94.4, new Date(2026, 0, 5), new Date(2026, 0, 5));

    const summaryRows = jsonToSheetSpy.mock.calls[0][0];
    expect(summaryRows[0].Value).toBe('05/Jan/2026');
  });
});

describe('exportBillingHistory', () => {
  let jsonToSheetSpy: jest.SpyInstance;

  beforeEach(() => {
    jsonToSheetSpy = jest.spyOn(XLSX.utils, 'json_to_sheet');
    jest.spyOn(XLSX, 'writeFile').mockImplementation(() => {}); // no real file write in tests
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reconstructs a closed cycle\'s Start/End from the renewal day-of-month + this row\'s own month (renews on the 5th, Aug record → 05/Jul to 04/Aug, NOT 05/Aug to 04/Sep)', () => {
    // Regression: the record's own monthKey is the month the cycle ENDS in (the
    // scheduler assigns monthKey from the renewal/completion date), not the month
    // it starts in - a MOSUB record shown for "Aug 2026" with a renewal day of 5
    // covers 5 Jul - 4 Aug, since the cycle that renews on 5 Aug ran through July.
    exportBillingHistory(
      [{
        id: 'rec_1', tool: { name: 'Claude', category: 'AI_LLM', billingCycle: 'MONTHLY', renewalDate: '2026-11-05' },
        monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 20, status: 'PAID',
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Start Date']).toBe('05/Jul/2026');
    expect(rows[0]['End Date']).toBe('04/Aug/2026');
    expect(new Date(2026, 6, 5).getTime()).toBeLessThan(new Date(2026, 7, 4).getTime()); // sanity: start < end
  });

  it('spans a full 12 months for a YEARLY tool, not 1', () => {
    exportBillingHistory(
      [{
        id: 'rec_yearly', tool: { name: 'Namecheap', category: 'HOSTING', billingCycle: 'YEARLY', renewalDate: '2027-03-05' },
        monthKey: '2026-03', monthLabel: 'Mar 2026', amount: 10, status: 'PAID',
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Start Date']).toBe('05/Mar/2025');
    expect(rows[0]['End Date']).toBe('04/Mar/2026');
  });

  it('follows the renewal date for a PREPAID (usage-based) tool too, same as any other tool with a renewalDate set (e.g. Railway renewing on the 2nd → 02/Jul to 01/Aug)', () => {
    // Any tool with a renewalDate set uses it, regardless of payment kind - a
    // PREPAID/usage-based tool is not special-cased differently from MOSUB/CAPSUB.
    exportBillingHistory(
      [{
        id: 'rec_2', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: '2026-09-02' },
        monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 1.34, status: 'PAID',
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Start Date']).toBe('02/Jul/2026');
    expect(rows[0]['End Date']).toBe('01/Aug/2026');
  });

  it('falls back to calendar-month boundaries when the tool has no fixed renewal date at all', () => {
    exportBillingHistory(
      [{
        id: 'rec_3', tool: { name: 'GCP', category: 'HOSTING', billingCycle: 'MONTHLY', renewalDate: null },
        monthKey: '2026-02', monthLabel: 'Feb 2026', amount: 5.61, status: 'PAID',
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Start Date']).toBe('01/Feb/2026');
    expect(rows[0]['End Date']).toBe('28/Feb/2026'); // 2026 is not a leap year
  });

  it('a live row still mid-cycle before its renewal day has arrived starts BEFORE end (regression: renews on the 18th, today is the 9th → 18/Jul to 09/Aug, not 18/Aug to 09/Aug)', () => {
    // This is the exact bug reported: today (9 Aug) is before the renewal day
    // (18th), so the live tool's current cycle actually started in July, not
    // August - a live row's CURRENT (future) renewalDate is used directly as
    // the boundary, not reconstructed from monthKey the way a historical row is.
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 9)); // "today" = 9 Aug 2026

    exportBillingHistory(
      [{
        id: 'live-tool1', tool: { name: 'Claude', category: 'AI_LLM', billingCycle: 'MONTHLY', renewalDate: '2026-08-18' },
        monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 20, status: 'PENDING',
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Start Date']).toBe('18/Jul/2026');
    expect(rows[0]['End Date']).toBe('09/Aug/2026');
    expect(new Date(2026, 6, 18).getTime()).toBeLessThan(new Date(2026, 7, 9).getTime()); // sanity: start < end
  });

  it('caps a still-in-progress live row\'s End Date at today, not the theoretical future cycle end', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 9)); // "today" = 9 Aug 2026

    exportBillingHistory(
      [{
        id: 'live-tool1', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: '2026-08-25' },
        monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 16.68, status: 'PENDING',
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['Start Date']).toBe('25/Jul/2026');
    expect(rows[0]['End Date']).toBe('09/Aug/2026'); // capped at today, not 24/Aug/2026
  });

  it('uses the full real cycle end for a closed historical row rather than capping it, even when that end falls after "today"', () => {
    // The isLive check (the "live-" id prefix) gates capping, not a date
    // comparison - a genuinely closed record's End Date is never capped.
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 9)); // "today" = 9 Aug 2026

    exportBillingHistory(
      [{
        id: 'rec_abc123', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: '2026-11-05' },
        monthKey: '2026-09', monthLabel: 'Sep 2026', amount: 16.68, status: 'PAID', // not a "live-" id - already closed
      }],
      'current', 'USD', 94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0]['End Date']).toBe('04/Sep/2026'); // not capped at 09/Aug/2026, even though that's earlier than today
  });

  it('labels a live current-month row "In progress", matching the on-screen Billing History table', () => {
    exportBillingHistory(
      [
        {
          id: 'live-tool1', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: null },
          monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 16.68, status: 'PENDING',
        },
      ],
      'current',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0].Status).toBe('In progress');
  });

  it('uses the selected filter\'s range label for every row\'s Period column, not each record\'s own billing month, when one is supplied', () => {
    exportBillingHistory(
      [
        { id: 'live-t1', tool: { name: 'Claude', category: 'AI_LLM', billingCycle: 'MONTHLY', renewalDate: null }, monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 20, status: 'PENDING' },
        { id: 'rec_2', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: null }, monthKey: '2026-06', monthLabel: 'Jun 2026', amount: 7.88, status: 'PAID' },
      ],
      'quarter',
      'USD',
      94.4,
      'Jul – Sep 2026',
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0].Period).toBe('Jul – Sep 2026');
    expect(rows[1].Period).toBe('Jul – Sep 2026');
  });

  it('gives each row its own Month column even when Period is identical across all of them (e.g. two rows for the same tool across a wide Year to Date range are otherwise indistinguishable)', () => {
    exportBillingHistory(
      [
        { id: 'rec_1', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: null }, monthKey: '2026-06', monthLabel: 'Jun 2026', amount: 7.88, status: 'PAID' },
        { id: 'rec_2', tool: { name: 'Railway', category: 'CLOUD_INFRA', billingCycle: 'MONTHLY', renewalDate: null }, monthKey: '2026-07', monthLabel: 'Jul 2026', amount: 17.0, status: 'PAID' },
      ],
      'ytd',
      'USD',
      94.4,
      'Jan – Aug 2026',
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0].Period).toBe('Jan – Aug 2026');
    expect(rows[1].Period).toBe('Jan – Aug 2026');
    expect(rows[0].Month).toBe('Jun 2026');
    expect(rows[1].Month).toBe('Jul 2026');
  });

  it('falls back to each row\'s own monthLabel when no range label is supplied (backward compatible)', () => {
    exportBillingHistory(
      [{ id: 'live-t1', tool: { name: 'Claude', category: 'AI_LLM', billingCycle: 'MONTHLY', renewalDate: null }, monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 20, status: 'PENDING' }],
      'current',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0].Period).toBe('Aug 2026');
  });

  it('labels a real historical unpaid record "Pending" (not "In progress" - it is not a live row)', () => {
    exportBillingHistory(
      [
        {
          id: 'rec_abc123', tool: { name: 'Namecheap', category: 'HOSTING', billingCycle: 'YEARLY', renewalDate: null },
          monthKey: '2026-07', monthLabel: 'Jul 2026', amount: 10, status: 'PENDING',
        },
      ],
      'last',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0].Status).toBe('Pending');
  });

  it('labels a paid record "Paid" regardless of whether it is a live-id row', () => {
    exportBillingHistory(
      [
        {
          id: 'live-tool2', tool: { name: 'Claude', category: 'AI_LLM', billingCycle: 'MONTHLY', renewalDate: null },
          monthKey: '2026-08', monthLabel: 'Aug 2026', amount: 20, status: 'PAID',
        },
      ],
      'current',
      'USD',
      94.4,
    );

    const rows = jsonToSheetSpy.mock.calls[0][0];
    expect(rows[0].Status).toBe('Paid');
  });
});
