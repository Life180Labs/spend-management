import * as XLSX from 'xlsx';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// dd/mmm/yyyy (e.g. "09/Aug/2026") - the format requested for the report's
// covered date range, distinct from the locale-formatted dates used elsewhere
// in this file (e.g. Renewal Date's toLocaleDateString) so it stays exactly
// this shape regardless of the browser's locale settings.
function fmtDDMMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = MONTH_ABBR[d.getMonth()];
  return `${dd}/${mmm}/${d.getFullYear()}`;
}

function download(wb: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function sheet(data: Record<string, unknown>[]): XLSX.WorkSheet {
  return XLSX.utils.json_to_sheet(data);
}

function autoWidth(ws: XLSX.WorkSheet, data: Record<string, unknown>[]) {
  if (!data.length) return;
  const cols = Object.keys(data[0]).map((key) => {
    const maxLen = Math.max(key.length, ...data.map((r) => String(r[key] ?? '').length));
    return { wch: Math.min(maxLen + 2, 40) };
  });
  ws['!cols'] = cols;
}

// ─── Spend Analysis Export ────────────────────────────────────────────────────

interface CategoryData { category: string; total: number; pct: number; }
interface ReportStat { label: string; value: string; }

const CAT_LABELS: Record<string, string> = {
  AI_LLM: 'AI / LLM', CLOUD_INFRA: 'Cloud Infra', COMMUNICATION: 'Communication',
  DEV_TOOLS: 'Dev Tools', DESIGN: 'Design', HOSTING: 'Hosting', MONITORING: 'Monitoring', OTHER: 'Other',
};

export function exportSpendAnalysis(
  categories: CategoryData[],
  stats: ReportStat[],
  currency: 'INR' | 'USD',
  fxRate: number,
  startDate: Date,
  endDate: Date,
) {
  const fmt = (n: number) =>
    currency === 'USD'
      ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : (n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sym = currency === 'USD' ? '$' : '₹';

  const summaryData = [
    { Metric: 'Start Date', Value: fmtDDMMMYYYY(startDate) },
    { Metric: 'End Date', Value: fmtDDMMMYYYY(endDate) },
    ...stats.map((s) => ({ Metric: s.label, Value: s.value })),
  ];
  const summaryWs = sheet(summaryData);
  autoWidth(summaryWs, summaryData);

  const catData = categories.map((c) => ({
    Category: CAT_LABELS[c.category] || c.category,
    [`Amount (${sym})`]: fmt(c.total),
    '% of Total': `${c.pct}%`,
  }));
  const catWs = sheet(catData);
  autoWidth(catWs, catData);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');
  XLSX.utils.book_append_sheet(wb, catWs, 'By Category');

  const month = new Date().toISOString().slice(0, 7);
  download(wb, `spend-analysis-${month}`);
}

// ─── Billing History Export ───────────────────────────────────────────────────

interface BillingRow {
  id: string;
  tool: { name: string; category: string; billingCycle: string; renewalDate: string | null } | null;
  monthKey: string;
  monthLabel: string;
  amount: number;
  status: string;
}

// This row's actual billing-cycle start/end, anchored to the tool's renewal
// cycle rather than calendar-month boundaries (e.g. "renews on the 18th" means
// the cycle covering early August actually runs 18 Jul - 17 Aug, not 1-31 Aug).
// Applies to any tool with a renewalDate set, regardless of payment kind -
// a tool with no renewalDate at all falls back to the calendar month instead.
//
// For a LIVE row (still accruing, "live-" id), the tool's CURRENT renewalDate
// already points at the boundary this cycle is heading toward -
// rollForwardRenewalDates keeps it in the future, so "today" always falls
// inside [boundary - cycleLength, boundary). For a closed HISTORICAL row, that
// boundary has to be reconstructed instead: the renewal day-of-month is stable
// across cycles (rollForwardRenewalDates preserves it when advancing), so
// combining that day with the row's OWN month/year reconstructs the exact date
// this specific cycle ended on.
function billingRowPeriod(r: BillingRow): { start: Date; end: Date } {
  const [y, m] = r.monthKey.split('-').map(Number); // m is 1-indexed
  const isLive = r.id.startsWith('live-');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const renewalDate = r.tool?.renewalDate ? new Date(r.tool.renewalDate) : null;

  if (!renewalDate) {
    const start = new Date(y, m - 1, 1);
    const end = isLive ? today : new Date(y, m, 0); // last calendar day of the month
    return { start, end };
  }

  const cycleMonths = r.tool?.billingCycle === 'YEARLY' ? 12 : 1;
  const boundary = isLive ? renewalDate : new Date(y, m - 1, renewalDate.getDate());

  const cycleEnd = new Date(boundary.getFullYear(), boundary.getMonth(), boundary.getDate() - 1);
  const cycleStart = new Date(boundary.getFullYear(), boundary.getMonth() - cycleMonths, boundary.getDate());
  const end = isLive && cycleEnd > today ? today : cycleEnd;
  return { start: cycleStart, end };
}

export function exportBillingHistory(
  rows: BillingRow[],
  monthFilter: string,
  currency: 'INR' | 'USD',
  fxRate: number,
  // The selected filter's human-readable range (e.g. "Jul – Sep 2026" for This
  // Quarter) - shown in every row's Period column, same for every row in the
  // export, unlike the Month column which is each row's own actual billing
  // month - without Month, multiple rows for the same tool across a wide
  // filter range (e.g. Year to Date) are indistinguishable, matching the
  // on-screen Billing History table's Month column. Falls back to each row's
  // own monthLabel if not supplied, so existing callers don't break.
  periodRangeLabel?: string,
) {
  const fmt = (n: number) =>
    currency === 'USD'
      ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : (n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sym = currency === 'USD' ? '$' : '₹';

  const data = rows.map((r) => {
    const { start, end } = billingRowPeriod(r);
    return {
      Tool: r.tool?.name || 'Deleted tool',
      Category: CAT_LABELS[r.tool?.category || ''] || r.tool?.category || '-',
      Month: r.monthLabel,
      Period: periodRangeLabel ?? r.monthLabel,
      'Start Date': fmtDDMMMYYYY(start),
      'End Date': fmtDDMMMYYYY(end),
      [`Amount (${sym})`]: fmt(r.amount),
      // Same status labeling as the Billing History table on-screen: a live
      // synthesized current-month row (id starts with "live-") reads "In
      // progress," not the more final-sounding "Pending" a closed, unpaid
      // historical month gets - otherwise the export disagrees with what the
      // user just saw on screen for the exact same rows.
      Status: r.status === 'PAID' ? 'Paid' : r.id.startsWith('live-') ? 'In progress' : 'Pending',
    };
  });

  const ws = sheet(data);
  autoWidth(ws, data);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Billing History');

  const suffix = monthFilter === 'all' ? 'all-months' : monthFilter;
  download(wb, `billing-history-${suffix}`);
}

// ─── Tools List Export ────────────────────────────────────────────────────────

interface ToolRow {
  name: string; vendor: string; category: string; paymentKind: string;
  usedAmount: number; capAmount: number; monthlyAmount: number;
  barPct: number; alertThresholdPct: number; alert: boolean;
  triggerEmail: string | null; renewalDate: string | null; daysUntilRenewal: number | null;
  integration?: { lastSyncRemainingBalanceUSD: number | null } | null;
}

const PAY_LABELS: Record<string, string> = {
  PREPAID: 'Usage-based', MOSUB: 'Subscription', CAPSUB: 'Cap + Sub', NOBUDGET: 'No budget',
};

export function exportToolsList(
  tools: ToolRow[],
  filterLabel: string,
  currency: 'INR' | 'USD',
  fxRate: number,
) {
  const fmt = (n: number) =>
    currency === 'USD'
      ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : (n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sym = currency === 'USD' ? '$' : '₹';

  const data = tools.map((t) => {
    const used = t.paymentKind === 'PREPAID' || t.paymentKind === 'CAPSUB'
      ? t.usedAmount : t.monthlyAmount;
    const cap = t.capAmount || 0;
    // "Wallet" mirrors the Dashboard's display-only relabeling - still PaymentKind
    // PREPAID underneath, just a wallet-style integration (e.g. HeyGen) that reports
    // a remaining balance instead of climbing toward a manually-set cap.
    const remainingBalance = t.integration?.lastSyncRemainingBalanceUSD;
    const isWallet = remainingBalance != null;
    return {
      'Tool Name': t.name,
      Vendor: t.vendor,
      Category: CAT_LABELS[t.category] || t.category,
      'Payment Type': isWallet ? 'Wallet' : (PAY_LABELS[t.paymentKind] || t.paymentKind),
      [`Used (${sym})`]: fmt(used),
      [`Budget Cap (${sym})`]: cap > 0 ? fmt(cap) : 'Uncapped',
      '% Used': t.paymentKind !== 'NOBUDGET' ? `${t.barPct}%` : '-',
      [`Remaining Balance (${sym})`]: isWallet ? fmt(remainingBalance!) : '-',
      'Alert Threshold': t.paymentKind !== 'NOBUDGET' ? `${t.alertThresholdPct}%` : '-',
      'Alert Active': t.alert ? 'Yes' : 'No',
      'Notify Email': t.triggerEmail || '-',
      'Renewal Date': t.renewalDate ? new Date(t.renewalDate).toLocaleDateString('en-IN') : '-',
      'Days Until Renewal': t.daysUntilRenewal ?? '-',
    };
  });

  const ws = sheet(data);
  autoWidth(ws, data);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tools');

  const month = new Date().toISOString().slice(0, 7);
  const suffix = filterLabel === 'All' ? 'all' : filterLabel.toLowerCase().replace(/\s+/g, '-');
  download(wb, `tools-${suffix}-${month}`);
}
