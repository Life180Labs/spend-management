import * as XLSX from 'xlsx';

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
) {
  const fmt = (n: number) =>
    currency === 'USD'
      ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : (n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sym = currency === 'USD' ? '$' : '₹';

  const summaryData = stats.map((s) => ({ Metric: s.label, Value: s.value }));
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
  tool: { name: string; category: string } | null;
  monthLabel: string;
  amount: number;
  status: string;
}

export function exportBillingHistory(
  rows: BillingRow[],
  monthFilter: string,
  currency: 'INR' | 'USD',
  fxRate: number,
  // The selected filter's human-readable range (e.g. "Jul – Sep 2026" for This
  // Quarter) - shown in every row's Period column instead of that record's own
  // billing month, matching the on-screen Billing History table. Falls back to
  // each row's own monthLabel if not supplied, so existing callers don't break.
  periodRangeLabel?: string,
) {
  const fmt = (n: number) =>
    currency === 'USD'
      ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : (n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sym = currency === 'USD' ? '$' : '₹';

  const data = rows.map((r) => ({
    Tool: r.tool?.name || 'Deleted tool',
    Category: CAT_LABELS[r.tool?.category || ''] || r.tool?.category || '-',
    Period: periodRangeLabel ?? r.monthLabel,
    [`Amount (${sym})`]: fmt(r.amount),
    // Same status labeling as the Billing History table on-screen: a live
    // synthesized current-month row (id starts with "live-") reads "In
    // progress," not the more final-sounding "Pending" a closed, unpaid
    // historical month gets - otherwise the export disagrees with what the
    // user just saw on screen for the exact same rows.
    Status: r.status === 'PAID' ? 'Paid' : r.id.startsWith('live-') ? 'In progress' : 'Pending',
  }));

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
  PREPAID: 'Pre-paid', MOSUB: 'Subscription', CAPSUB: 'Cap + Sub', NOBUDGET: 'No budget',
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
