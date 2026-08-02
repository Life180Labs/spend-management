import * as XLSX from 'xlsx';
import { exportBillingHistory, exportToolsList } from './excel';

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
    expect(rows[0]['Payment Type']).toBe('Pre-paid');
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

describe('exportBillingHistory', () => {
  let jsonToSheetSpy: jest.SpyInstance;

  beforeEach(() => {
    jsonToSheetSpy = jest.spyOn(XLSX.utils, 'json_to_sheet');
    jest.spyOn(XLSX, 'writeFile').mockImplementation(() => {}); // no real file write in tests
  });

  afterEach(() => jest.restoreAllMocks());

  it('labels a live current-month row "In progress", matching the on-screen Billing History table', () => {
    exportBillingHistory(
      [
        {
          id: 'live-tool1', tool: { name: 'Railway', category: 'CLOUD_INFRA' },
          monthLabel: 'Aug 2026', amount: 16.68, status: 'PENDING',
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
        { id: 'live-t1', tool: { name: 'Claude', category: 'AI_LLM' }, monthLabel: 'Aug 2026', amount: 20, status: 'PENDING' },
        { id: 'rec_2', tool: { name: 'Railway', category: 'CLOUD_INFRA' }, monthLabel: 'Jun 2026', amount: 7.88, status: 'PAID' },
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

  it('falls back to each row\'s own monthLabel when no range label is supplied (backward compatible)', () => {
    exportBillingHistory(
      [{ id: 'live-t1', tool: { name: 'Claude', category: 'AI_LLM' }, monthLabel: 'Aug 2026', amount: 20, status: 'PENDING' }],
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
          id: 'rec_abc123', tool: { name: 'Namecheap', category: 'HOSTING' },
          monthLabel: 'Jul 2026', amount: 10, status: 'PENDING',
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
          id: 'live-tool2', tool: { name: 'Claude', category: 'AI_LLM' },
          monthLabel: 'Aug 2026', amount: 20, status: 'PAID',
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
