'use client';

import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Plus, Download, Calendar, ChevronDown, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import { exportToolsList } from '@/lib/excel';
import { AddToolModal } from '@/components/tools/add-tool-modal';
import { IntegrationModal } from '@/components/tools/integration-modal';
import { matchProviderByVendor, INTEGRATION_PROVIDERS } from '@/lib/integration-providers';

interface KPIs {
  totalMonthlySpend: number;
  alertCount: number;
  toolCount: number;
  noBudgetCount: number;
  renewalCount: number;
  nearestRenewal: { name: string; date: string; daysAway: number } | null;
}

interface Tool {
  id: string; name: string; vendor: string; category: string;
  paymentKind: string; billingCycle: string; monoInitials: string; monoBgColor: string;
  usedAmount: number; capAmount: number; monthlyAmount: number; // USD - the app's base currency
  barPct: number; alertThresholdPct: number; alert: boolean;
  statusSub: string; triggerEmail: string | null;
  renewalDate: string | null; daysUntilRenewal: number | null;
  isActive: boolean;
  integration: { provider: string; lastSyncAt: string | null; lastSyncAmountUSD: number | null; lastSyncRemainingBalanceUSD: number | null; isActive: boolean; lastError: string | null } | null;
}

const CAT_LABELS: Record<string, string> = {
  AI_LLM: 'AI / LLM', CLOUD_INFRA: 'Cloud Infra', COMMUNICATION: 'Communication',
  DEV_TOOLS: 'Dev Tools', DESIGN: 'Design', HOSTING: 'Hosting', MONITORING: 'Monitoring', OTHER: 'Other',
};

const TABS = [
  { key: 'All', label: 'All' },
  { key: 'PREPAID', label: 'Usage-based' },
  { key: 'MOSUB', label: 'Subscription' },
  { key: 'NOBUDGET', label: 'Needs Budget' },
];

const GRID = 'minmax(200px,2fr) 1.05fr 0.95fr 1.75fr 1.15fr 1.6fr 1.05fr 60px';

type SpendPeriod = 'this_month' | 'last_month' | 'this_quarter' | 'year_to_date';
const PERIOD_OPTIONS: { key: SpendPeriod; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'year_to_date', label: 'Year to date' },
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A visible date range for Quarter/YTD, so the card doesn't just say "this
// quarter" with no indication of which months that actually spans - without
// this, "This Quarter" can look identical to "This Month" whenever there's no
// data yet for the quarter's earlier months, which reads as broken even
// though the underlying total is correct (see Reports > Billing History,
// same root confusion, same fix applied there).
function periodRangeSuffix(period: SpendPeriod): string {
  const now = new Date();
  if (period === 'this_quarter') {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    const quarterEndMonth = quarterStartMonth + 2;
    return ` (${MONTH_NAMES[quarterStartMonth]}–${MONTH_NAMES[quarterEndMonth]} ${now.getFullYear()})`;
  }
  if (period === 'year_to_date') return ` (Jan–${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()})`;
  return '';
}

function makeFmt(currency: 'INR' | 'USD', fxRate: number) {
  // Every stored amount is USD-native - the app's base currency. USD display
  // needs no conversion; INR is derived on the fly from the live FX rate.
  return (usdAmount: number) => {
    if (currency === 'USD') {
      return `$${Number(usdAmount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    }
    return `₹${(usdAmount * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  };
}

function computeRow(t: Tool, fmtAmt: (n: number) => string) {
  let statusMain = '';
  if (t.paymentKind === 'PREPAID') statusMain = `${fmtAmt(t.usedAmount)} / ${fmtAmt(t.capAmount)}`;
  else if (t.paymentKind === 'CAPSUB') statusMain = `${fmtAmt(t.monthlyAmount)} / ${fmtAmt(t.capAmount)}`;
  else if (t.paymentKind === 'MOSUB') statusMain = `${fmtAmt(t.monthlyAmount)} / ${t.billingCycle === 'YEARLY' ? 'yr' : 'mo'}`;

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
    : t.paymentKind === 'PREPAID' ? 'Usage-based' : t.paymentKind === 'NOBUDGET' ? 'No budget' : 'Subscription';

  return { statusMain, statusSubColor, barColor, renewMain, renewSub, renewColor, renewUrgent, payBg, payColor, payLabel };
}

export default function DashboardPage() {
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [filter, setFilter] = useState('All');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const [showAdd, setShowAdd] = useState(false);
  const [editTool, setEditTool] = useState<Tool | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Tool | null>(null);
  const [integrationTool, setIntegrationTool] = useState<Tool | null>(null);
  const [toast, setToast] = useState('');
  const [currency, setCurrency] = useState<'INR' | 'USD'>(
    () => (typeof window !== 'undefined' ? (localStorage.getItem('spend_currency') as 'INR' | 'USD' | null) : null) ?? 'USD'
  );
  const [fxRate, setFxRate] = useState(94.4);
  const [spendPeriod, setSpendPeriod] = useState<SpendPeriod>('this_month');
  const [periodSpendTotal, setPeriodSpendTotal] = useState<number | null>(null);
  const [periodSpendByTool, setPeriodSpendByTool] = useState<Record<string, number>>({});
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);

  useEffect(() => {
    fetch('https://api.frankfurter.app/latest?from=USD&to=INR')
      .then((r) => r.json())
      .then((d: any) => { if (d?.rates?.INR) setFxRate(d.rates.INR); })
      .catch(() => { });
  }, []);

  useEffect(() => {
    localStorage.setItem('spend_currency', currency);
    window.dispatchEvent(new CustomEvent('spend_currency_change', { detail: currency }));
  }, [currency]);

  const load = useCallback(async () => {
    const [k, t] = await Promise.all([api.get<KPIs>('/reports/dashboard-kpis'), api.get<Tool[]>('/tools')]);
    setKpis(k); setTools(t);
    window.dispatchEvent(new Event('spend_data_changed'));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30s so synced spend data appears without manual reload
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Scopes the Total Monthly Spend KPI card AND the tools table's own "period
  // spend" column below - the two always visibly sum to the same total, since
  // both read from the same backend windowing (reports.service.ts). The rest
  // of the dashboard (alerts, renewals, budget setup, cap/bar% in Budget
  // Status) stays live/current-state regardless of the period picked here,
  // since "active alert" or "upcoming renewal" isn't a past-tense concept the
  // way a spend total is.
  const loadPeriodSpend = useCallback(async (period: SpendPeriod) => {
    const [totalRes, byToolRes] = await Promise.all([
      api.get<{ total: number }>(`/reports/period-spend?period=${period}`),
      api.get<Record<string, number>>(`/reports/period-spend-by-tool?period=${period}`),
    ]);
    setPeriodSpendTotal(totalRes.total);
    setPeriodSpendByTool(byToolRes);
  }, []);

  useEffect(() => { loadPeriodSpend(spendPeriod); }, [spendPeriod, loadPeriodSpend]);

  useEffect(() => {
    const id = setInterval(() => loadPeriodSpend(spendPeriod), 30_000);
    return () => clearInterval(id);
  }, [spendPeriod, loadPeriodSpend]);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2600); }

  async function deleteTool(id: string, name: string) {
    await api.delete(`/tools/${id}`);
    showToast(`${name} deleted`);
    setConfirmDelete(null);
    load();
  }

  const displayed = filter === 'All' ? tools
    : filter === 'NOBUDGET' ? tools.filter((t) => t.paymentKind === 'NOBUDGET')
      : filter === 'PREPAID' ? tools.filter((t) => t.paymentKind === 'PREPAID')
        : tools.filter((t) => ['MOSUB', 'CAPSUB'].includes(t.paymentKind));

  const noBudgetNames = tools.filter((t) => t.paymentKind === 'NOBUDGET').map((t) => t.name).join(' & ') || 'None';
  const nearestRenewalText = (kpis?.renewalCount ?? 0) === 0 ? 'No upcoming renewals' : 'within the next 5 days';

  const periodColumnLabel = PERIOD_OPTIONS.find((p) => p.key === spendPeriod)?.label ?? 'This Month';
  const HEADERS = ['Tool', 'Category', 'Payment', 'Budget Status', periodColumnLabel, 'Alert / Renewal Trigger', 'Next Renewal', 'Actions'];

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 660, color: '#F2F3F5', letterSpacing: '-.02em' }}>Spend Overview</h1>
          <p style={{ fontSize: 12, color: '#767b86', marginTop: 3 }}>Monitor tool budgets, usage and alert thresholds across your stack.</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Period selector - scopes the Total Monthly Spend card only */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setPeriodMenuOpen((v) => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 9, background: 'transparent', border: '1px solid #1E212A', color: '#c2c6cf', fontSize: 12.5, fontWeight: 550, cursor: 'pointer' }}
            >
              <Calendar size={13} style={{ color: '#6b707b' }} />
              {PERIOD_OPTIONS.find((p) => p.key === spendPeriod)?.label}
              <ChevronDown size={13} style={{ color: '#6b707b' }} />
            </button>
            {periodMenuOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setPeriodMenuOpen(false)} />
                <div style={{ position: 'absolute', top: '110%', left: 0, background: '#1B1E26', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '4px 0', zIndex: 50, minWidth: 180, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                  {PERIOD_OPTIONS.map((p) => {
                    const active = spendPeriod === p.key;
                    return (
                      <button
                        key={p.key}
                        onClick={() => { setSpendPeriod(p.key); setPeriodMenuOpen(false); }}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: active ? 600 : 500, background: 'transparent', border: 'none', cursor: 'pointer', color: active ? '#E6E8EC' : '#9aa0ab' }}
                      >
                        {p.label}
                        {active && <Check size={13} style={{ color: '#5E6AD2' }} />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {/* Currency toggle */}
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid #1E212A', overflow: 'hidden' }}>
            {(['USD', 'INR'] as const).map((c) => (
              <button key={c} onClick={() => setCurrency(c)} style={{ padding: '6px 13px', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: currency === c ? '#5E6AD2' : 'transparent', color: currency === c ? '#fff' : '#6b707b', transition: 'all .15s' }}>
                {c === 'INR' ? '₹ INR' : '$ USD'}
              </button>
            ))}
          </div>
          <button
            onClick={() => exportToolsList(displayed, filter, currency, fxRate)}
            title="Download as Excel"
            style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: '1px solid #1E212A', color: '#6b707b', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <Download size={13} />
          </button>
          <button onClick={() => setShowAdd(true)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 9, background: '#5E6AD2', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <Plus size={14} /> Add Tool
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      {kpis && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
          {/* Card 1: Total Monthly Spend */}
          <div style={{ background: '#101218', border: '1px solid #1E212A', borderRadius: 14, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: '#878c96', fontWeight: 500 }}>Total Monthly Spend</span>
              <span style={{ color: '#5E6AD2', display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(94,106,210,.12)', fontSize: 16, fontWeight: 700 }}>
                {currency === 'INR' ? '₹' : '$'}
              </span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.02em', lineHeight: 1 }}>
              {makeFmt(currency, fxRate)(periodSpendTotal ?? kpis.totalMonthlySpend)}
            </div>
            <div style={{ fontSize: 12, color: '#6b707b', marginTop: 11 }} title="A yearly subscription's cost is divided by 12 before being added to this total, so it reflects its true monthly rate.">
              {PERIOD_OPTIONS.find((p) => p.key === spendPeriod)?.label.toLowerCase()}{periodRangeSuffix(spendPeriod)} · yearly subscriptions pro-rated
            </div>
          </div>

          {/* Card 2: Tools Needing Budget Setup */}
          <div style={{ background: 'linear-gradient(150deg,rgba(245,166,35,.09),#101218 60%)', border: '1px solid rgba(245,166,35,.35)', borderRadius: 14, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: '#d6a44e', fontWeight: 500 }}>Tools Needing Budget Setup</span>
              <span style={{ color: '#F5A623', display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(245,166,35,.14)' }}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.2L14.5 13H1.5L8 2.2Z" /><line x1="8" y1="6.5" x2="8" y2="9.3" /><circle cx="8" cy="11.1" r=".35" fill="currentColor" /></svg>
              </span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 680, color: '#F5A623', letterSpacing: '-.02em', lineHeight: 1 }}>{kpis.noBudgetCount}</div>
            <div style={{ fontSize: 12, color: '#8a7d5e', marginTop: 11 }}>{kpis.noBudgetCount > 0 ? `${noBudgetNames} - uncapped` : 'All tools are configured'}</div>
          </div>

          {/* Card 3: Active Threshold Alerts */}
          <div style={{ background: kpis.alertCount > 0 ? 'linear-gradient(150deg,rgba(248,81,73,.2),#101218 50%)' : '#101218', border: kpis.alertCount > 0 ? '2px solid #F85149' : '1px solid #1E212A', borderRadius: 14, padding: '18px 20px', boxShadow: kpis.alertCount > 0 ? '0 0 16px rgba(248,81,73,.2), inset 0 0 12px rgba(248,81,73,.08)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: '#878c96', fontWeight: 500 }}>Active Threshold Alerts</span>
              <span style={{ color: '#F85149', display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(248,81,73,.12)', animation: 'pulseRing 2.4s ease-in-out infinite' }}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2.5c-2 0-3.2 1.4-3.2 3.3 0 2.5-1 3.5-1.4 3.9-.1.2.1.4.4.4h8.4c.3 0 .5-.2.4-.4-.4-.4-1.4-1.4-1.4-3.9C11.2 3.9 10 2.5 8 2.5Z" strokeLinejoin="round" /><path d="M6.7 12.2a1.4 1.4 0 0 0 2.6 0" strokeLinecap="round" /></svg>
              </span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.02em', lineHeight: 1 }}>{kpis.alertCount}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 11, fontSize: 12 }}>
              {kpis.alertCount > 0 ? (
                <><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#F85149', flexShrink: 0, display: 'inline-block' }} /><span style={{ color: '#878c96' }}>Scroll down · alerts highlighted in list</span></>
              ) : <span style={{ color: '#6b707b' }}>No active alerts</span>}
            </div>
          </div>

          {/* Card 4: Upcoming Renewals */}
          <div style={{ background: '#101218', border: '1px solid #1E212A', borderRadius: 14, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: '#878c96', fontWeight: 500 }}>Upcoming Renewals</span>
              <span style={{ color: '#5E6AD2', display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(94,106,210,.12)' }}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="3" width="11" height="11" rx="2" /><line x1="2.5" y1="6.2" x2="13.5" y2="6.2" /><line x1="5.5" y1="1.5" x2="5.5" y2="4" /><line x1="10.5" y1="1.5" x2="10.5" y2="4" /></svg>
              </span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.02em', lineHeight: 1 }}>{kpis?.renewalCount ?? 0}</div>
            <div style={{ fontSize: 12, color: '#6b707b', marginTop: 11 }}>{nearestRenewalText}</div>
          </div>
        </div>
      )}

      {/* Tools table container */}
      <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 16, overflow: 'hidden' }}>

        {/* Filter tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '12px 16px 0', borderBottom: '1px solid #1A1D24' }}>
          {TABS.map(({ key, label }) => {
            const count = key === 'All' ? tools.length
              : key === 'NOBUDGET' ? tools.filter((t) => t.paymentKind === 'NOBUDGET').length
                : key === 'PREPAID' ? tools.filter((t) => t.paymentKind === 'PREPAID').length
                  : tools.filter((t) => ['MOSUB', 'CAPSUB'].includes(t.paymentKind)).length;
            const active = filter === key;
            return (
              <button key={key} onClick={() => setFilter(key)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: '8px 8px 0 0', border: 'none', background: active ? '#0E1014' : 'transparent', color: active ? '#E6E8EC' : '#6b707b', fontSize: 12.5, fontWeight: active ? 600 : 500, cursor: 'pointer', borderBottom: active ? '1px solid #0E1014' : 'none', marginBottom: active ? -1 : 0 }}>
                {label}
                <span style={{ fontSize: 10.5, fontWeight: 650, color: active ? '#9aa2ef' : '#4a4f59', opacity: active ? 1 : 0.7 }}>{count}</span>
              </button>
            );
          })}
          <div style={{ marginLeft: 'auto', padding: '4px 16px' }}>
            <button onClick={() => setShowAdd(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'rgba(94,106,210,.12)', border: 'none', color: '#9aa2ef', fontSize: 12, fontWeight: 550, cursor: 'pointer' }}>
              <Plus size={12} /> Add Tool
            </button>
          </div>
        </div>

        {/* Header row */}
        <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '11px 22px', borderBottom: '1px solid #1A1D24', background: '#0C0E12' }}>
          {HEADERS.map((h) => (
            <div key={h} style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#5e636e' }}>{h}</div>
          ))}
        </div>

        {/* Tool rows */}
        {displayed.map((tool) => {
          const fmtAmt = makeFmt(currency, fxRate);
          const { statusMain, statusSubColor, barColor, renewMain, renewSub, renewColor, renewUrgent, payBg, payColor, payLabel } = computeRow(tool, fmtAmt);
          const periodAmount = periodSpendByTool[tool.id] ?? 0;
          const remainingBalance = tool.integration?.lastSyncRemainingBalanceUSD;
          return (
            <ToolRow
              key={tool.id}
              tool={tool}
              statusMain={statusMain} statusSubColor={statusSubColor} barColor={barColor}
              periodSpendDisplay={fmtAmt(periodAmount)}
              remainingBalanceDisplay={remainingBalance != null ? fmtAmt(remainingBalance) : null}
              renewMain={renewMain} renewSub={renewSub} renewColor={renewColor} renewUrgent={renewUrgent}
              payBg={payBg} payColor={payColor} payLabel={payLabel}
              onEdit={() => setEditTool(tool)}
              onIntegration={() => setIntegrationTool(tool)}
              onMenu={(e: React.MouseEvent) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                setOpenMenu(openMenu === tool.id ? null : tool.id);
              }}
            />
          );
        })}

        {displayed.length === 0 && (
          <div style={{ padding: '48px 22px', textAlign: 'center', fontSize: 13, color: '#4a4f59' }}>
            No tools found. Click <span style={{ color: '#9aa2ef' }}>Add Tool</span> to get started.
          </div>
        )}
        <div style={{ textAlign: 'center', fontSize: 11.5, color: '#4a4f59', padding: '10px 22px 14px' }}>
          Click a tool row to edit · use ⋮ menu to connect an integration
        </div>
      </div>

      {/* Fixed dropdown menu */}
      {openMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpenMenu(null)} />
          <div style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, background: '#1B1E26', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '4px 0', zIndex: 50, minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
            <DropBtn label="Edit" icon={<PencilIcon />} onClick={() => { setEditTool(tools.find((t) => t.id === openMenu)!); setOpenMenu(null); }} />
            <DropBtn
              label={tools.find((t) => t.id === openMenu)?.integration ? 'Integration' : 'Connect Integration'}
              icon={<PlugIcon />}
              onClick={() => { setIntegrationTool(tools.find((t) => t.id === openMenu)!); setOpenMenu(null); }}
            />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '3px 0' }} />
            <DropBtn label="Delete" icon={<TrashIcon />} danger onClick={() => { setConfirmDelete(tools.find((t) => t.id === openMenu)!); setOpenMenu(null); }} />
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', padding: '8px 16px', borderRadius: 10, background: '#1B1E26', border: '1px solid rgba(255,255,255,0.1)', color: '#F0F0F0', fontSize: 13, fontWeight: 500, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60 }}>
          {toast}
        </div>
      )}

      {/* Modals */}
      {showAdd && (
        <AddToolModal
          // Block re-adding a provider once ANY tool for it already exists - not just
          // ones with a live integration. A manually-tracked tool (e.g. a Claude Pro
          // subscription with no API key) still means "we already have a Claude entry,"
          // so offering it again in the dropdown would just create a confusing duplicate.
          // Uses the same matchProviderByVendor() the Configure Integration modal's
          // provider lock uses, so the two checks can't drift out of sync again.
          connectedProviders={new Set(
            tools
              .map((t) => matchProviderByVendor(t.vendor))
              .filter((p): p is NonNullable<typeof p> => !!p)
              .map((p) => p.value),
          )}
          onClose={() => setShowAdd(false)}
          onCreated={(t) => { showToast(`${t.name} added`); setShowAdd(false); load(); }}
        />
      )}
      {editTool && (
        <AddToolModal tool={editTool} onClose={() => setEditTool(null)} onCreated={(updated) => { showToast(`${updated.name} updated`); setEditTool(null); load(); }} />
      )}
      {integrationTool && (
        <IntegrationModal
          toolId={integrationTool.id}
          toolName={integrationTool.name}
          toolVendor={integrationTool.vendor}
          onClose={() => setIntegrationTool(null)}
          onSynced={() => { load(); showToast('Spend data updated'); }}
        />
      )}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.6)' }}>
          <div style={{ width: '100%', maxWidth: 360, borderRadius: 18, padding: 24, background: '#0F1116', border: '1px solid #1E212A', boxShadow: '0 24px 64px rgba(0,0,0,.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(248,81,73,.12)' }}>
                <TrashIcon color="#F85149" />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 650, color: '#F2F3F5', margin: 0 }}>Delete tool</p>
                <p style={{ fontSize: 12, color: '#878c96', margin: '2px 0 0' }}>This action cannot be undone</p>
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#878c96', marginBottom: 20 }}>
              Are you sure you want to delete <span style={{ color: '#F2F3F5', fontWeight: 600 }}>{confirmDelete.name}</span>? Billing history will be preserved.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConfirmDelete(null)} style={{ flex: 1, padding: '10px 0', borderRadius: 9, background: '#1B1E26', border: '1px solid #2a2e38', color: '#9aa0ab', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => deleteTool(confirmDelete.id, confirmDelete.name)} style={{ flex: 1, padding: '10px 0', borderRadius: 9, background: '#F85149', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulseRing  { 0%,100% { box-shadow: 0 0 0 0 rgba(248,81,73,0); } 50% { box-shadow: 0 0 0 4px rgba(248,81,73,.18); } }
        @keyframes pulseAmber { 0%,100% { box-shadow: 0 0 0 0 rgba(245,166,35,0); } 50% { box-shadow: 0 0 0 4px rgba(245,166,35,.2); } }
      `}</style>
    </div>
  );
}

// Provider usage APIs (Railway's included) can return slightly different numbers for the
// same query seconds apart — showing when this figure was last pulled makes clear it's one
// live read, not a disagreement with e.g. the Usage History page reading the same provider
// at a different instant.
function fmtSyncAgo(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'synced just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `synced ${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `synced ${diffHr}h ago`;
}

function ToolRow({ tool, statusMain, statusSubColor, barColor, periodSpendDisplay, remainingBalanceDisplay, renewMain, renewSub, renewColor, renewUrgent, payBg, payColor, payLabel, onEdit, onIntegration, onMenu }: any) {
  const [hover, setHover] = useState(false);
  const hasIntegration = !!tool.integration;
  const syncError = tool.integration?.lastError;
  // Batch-exported providers (currently just GCP's BigQuery Billing Export, hours-to-
  // days behind) must never read "Live" - that would misrepresent how fresh the number
  // actually is. Looked up by provider key, not vendor text, since this is about which
  // integration is connected, not the tool's free-text vendor field.
  const hasLag = !!INTEGRATION_PROVIDERS.find((p) => p.value === tool.integration?.provider)?.hasLag;
  const remainingBalance: number | null = tool.integration?.lastSyncRemainingBalanceUSD ?? null;
  // Wallet-style providers (e.g. HeyGen) drain toward zero rather than climb toward a
  // cap - a low balance is the meaningful warning signal here, not barPct. Fixed
  // thresholds, not a configurable field (see docs/heygen-remaining-balance-loop-prompt.md).
  const balanceColor = remainingBalance == null ? '#4a4f59' : remainingBalance < 1 ? '#F85149' : remainingBalance < 5 ? '#F5A623' : '#4a4f59';
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '13px 22px', borderBottom: '1px solid #15181E', background: tool.alert ? (hover ? '#1a1018' : 'rgba(248,81,73,.03)') : (hover ? '#121419' : 'transparent'), boxShadow: `inset 3px 0 0 ${tool.alert ? '#F85149' : 'transparent'}`, transition: 'background .12s', cursor: 'pointer' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={onEdit}
    >
      {/* Tool */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, paddingRight: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: tool.monoBgColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0, border: '1px solid rgba(255,255,255,.08)' }}>{tool.monoInitials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13.5, fontWeight: 580, color: '#E6E8EC', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tool.name}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#34394a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}><path d="M6 3.5L10.5 8L6 12.5" /></svg>
            {tool.alert && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#F85149', flexShrink: 0, boxShadow: '0 0 0 3px rgba(248,81,73,.15)', display: 'inline-block' }} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#6b707b' }}>{tool.vendor}</span>
            {hasIntegration ? (
              <button
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); onIntegration(); }}
                title={
                  syncError ? `Sync error: ${syncError}`
                    : hasLag ? 'Batch-exported data (e.g. BigQuery Billing Export) - hours to a few days behind, never real-time. Click to configure.'
                      : 'Integration active - click to configure'
                }
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 20,
                  background: syncError ? 'rgba(248,81,73,.12)' : hasLag ? 'rgba(245,166,35,.1)' : 'rgba(63,185,80,.1)',
                  border: `1px solid ${syncError ? 'rgba(248,81,73,.3)' : hasLag ? 'rgba(245,166,35,.28)' : 'rgba(63,185,80,.25)'}`,
                  color: syncError ? '#F85149' : hasLag ? '#d99e3e' : '#3FB950',
                  fontSize: 9.5, fontWeight: 600, cursor: 'pointer', letterSpacing: '.03em',
                }}
              >
                <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'currentColor', flexShrink: 0, display: 'inline-block' }} />
                {syncError ? 'Sync error' : hasLag ? 'Periodic' : 'Live'}
              </button>
            ) : tool.isActive && (
              // No API sync exists for this tool (e.g. a manual subscription like Claude
              // Pro) - "Active" signals the team is using it, without implying a live
              // data feed the way "Live" does. Keep the two labels distinct so "Live"
              // never stops meaning "actually syncing via an integration."
              <span
                title="Marked as an actively used tool"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 20, background: 'rgba(94,106,210,.14)', border: '1px solid rgba(94,106,210,.32)', color: '#9aa2ef', fontSize: 9.5, fontWeight: 600, letterSpacing: '.03em' }}
              >
                <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'currentColor', flexShrink: 0, display: 'inline-block' }} />
                Active
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Category */}
      <div><span style={{ fontSize: 12, color: '#9aa0ab', fontWeight: 450 }}>{CAT_LABELS[tool.category] || tool.category}</span></div>

      {/* Payment */}
      <div><span style={{ display: 'inline-flex', fontSize: 11, fontWeight: 550, padding: '3px 9px', borderRadius: 20, background: payBg, color: payColor }}>{payLabel}</span></div>

      {/* Budget Status */}
      <div style={{ paddingRight: 18 }}>
        {tool.paymentKind === 'NOBUDGET' ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 550, padding: '4px 11px', borderRadius: 20, background: 'rgba(245,166,35,.1)', color: '#d99e3e', border: '1px solid rgba(245,166,35,.28)' }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 2.5L14.5 13H1.5L8 2.5Z" strokeLinejoin="round" /><line x1="8" y1="6.5" x2="8" y2="9" /></svg>
            No Budget Set
          </span>
        ) : tool.paymentKind === 'MOSUB' ? (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#cfd3da', letterSpacing: '-.01em' }}>{statusMain}</div>
            <div style={{ fontSize: 10.5, color: '#6b707b', marginTop: 2 }}>flat rate · no cap</div>
          </div>
        ) : remainingBalanceDisplay ? (
          // Wallet-style integration (e.g. HeyGen) - the meaningful number is a
          // balance draining toward zero, not spend climbing toward a manually-set
          // cap, so the usedAmount/capAmount bar doesn't apply here at all - show
          // only the balance, as the primary figure rather than a secondary line.
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 650, color: balanceColor === '#4a4f59' ? '#cfd3da' : balanceColor, letterSpacing: '-.01em' }}>
              {remainingBalance != null && remainingBalance < 5 && (
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 2.5L14.5 13H1.5L8 2.5Z" strokeLinejoin="round" /><line x1="8" y1="6.5" x2="8" y2="9" /></svg>
              )}
              {remainingBalanceDisplay} left
            </div>
            {hasIntegration && tool.integration?.lastSyncAt && (
              <div style={{ fontSize: 10, color: '#4a4f59', marginTop: 4 }}>{fmtSyncAgo(tool.integration.lastSyncAt)}</div>
            )}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 560, color: '#cfd3da' }}>{statusMain}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: statusSubColor }}>{tool.statusSub}</span>
            </div>
            <div style={{ height: 6, borderRadius: 999, background: '#1B1E26', overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 999, width: `${Math.min(100, tool.barPct)}%`, background: barColor }} />
            </div>
            {hasIntegration && tool.integration?.lastSyncAt && (
              <div style={{ fontSize: 10, color: '#4a4f59', marginTop: 4 }}>{fmtSyncAgo(tool.integration.lastSyncAt)}</div>
            )}
            {tool.alert && (
              <div style={{ marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 20, background: 'rgba(248,81,73,.1)', border: '1px solid rgba(248,81,73,.28)' }}>
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="#F85149" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5L14.5 13H1.5L8 2.5Z" strokeLinejoin="round" /><line x1="8" y1="6.5" x2="8" y2="9" /></svg>
                <span style={{ fontSize: 10, fontWeight: 650, color: '#F85149', letterSpacing: '.02em' }}>Alert: {tool.barPct}% used · threshold {tool.alertThresholdPct}%</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Period Spend - this tool's contribution to the Total Monthly Spend KPI
          card for the currently-selected dropdown period. Always $0 for
          NOBUDGET tools (they're excluded from that total by design). */}
      <div style={{ paddingRight: 14 }}>
        {tool.paymentKind === 'NOBUDGET' ? (
          <span style={{ fontSize: 12.5, color: '#4a4f59' }}>-</span>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#cfd3da', fontVariantNumeric: 'tabular-nums' }}>{periodSpendDisplay}</span>
        )}
      </div>

      {/* Alert Trigger */}
      <div style={{ minWidth: 0, paddingRight: 14 }}>
        {tool.triggerEmail ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <span style={{ color: '#5E6AD2', display: 'flex', flexShrink: 0 }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.8" y="3.5" width="12.4" height="9" rx="2" /><path d="M2.4 4.5L8 8.3l5.6-3.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#c2c6cf', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tool.triggerEmail}</div>
              <div style={{ fontSize: 10.5, color: '#6b707b' }}>
                {tool.paymentKind === 'MOSUB' ? 'renewal reminder' : `at ${tool.alertThresholdPct}% usage`}
              </div>
            </div>
          </div>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#5e636e' }}>
            <span style={{ width: 14, height: 1.5, background: '#34394a', display: 'inline-block' }} />
            Not configured
          </span>
        )}
      </div>

      {/* Next Renewal */}
      <div>
        {renewUrgent ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 20,
            background: renewColor === '#F85149' ? 'rgba(248,81,73,0.12)' : 'rgba(245,166,35,0.12)',
            border: `1px solid ${renewColor === '#F85149' ? 'rgba(248,81,73,0.4)' : 'rgba(245,166,35,0.4)'}`,
            animation: renewColor === '#F85149' ? 'pulseRing 2.4s ease-in-out infinite' : 'pulseAmber 2.4s ease-in-out infinite',
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={renewColor} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="8" cy="8" r="6" /><path d="M8 5v3.5l2 2" />
            </svg>
            <div>
              <div style={{ fontSize: 12, fontWeight: 660, color: renewColor, lineHeight: 1 }}>{renewMain}</div>
              <div style={{ fontSize: 10.5, color: renewColor, opacity: 0.75, marginTop: 2 }}>{renewSub}</div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, fontWeight: 550, color: renewColor }}>{renewMain}</div>
            {renewSub && <div style={{ fontSize: 11, color: '#6b707b' }}>{renewSub}</div>}
          </>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ThreeDotBtn onMenu={onMenu} />
      </div>
    </div>
  );
}

function ThreeDotBtn({ onMenu }: { onMenu: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onMenu(e); }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: 32, height: 32, borderRadius: 8, background: hover ? '#16181F' : 'transparent', border: 'none', color: hover ? '#9aa0ab' : '#6b707b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="4" r="1.5" fill="currentColor" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /><circle cx="8" cy="12" r="1.5" fill="currentColor" /></svg>
    </button>
  );
}

function DropBtn({ label, icon, danger, onClick }: { label: string; icon: ReactNode; danger?: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', fontSize: 12, background: hover ? 'rgba(255,255,255,0.04)' : 'transparent', border: 'none', cursor: 'pointer', color: danger ? '#F85149' : hover ? '#E6E8EC' : '#9aa0ab', transition: 'all .1s' }}>
      {icon} {label}
    </button>
  );
}

function PencilIcon() { return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 2.5a2.1 2.1 0 0 1 3 3L5 15H2v-3L11.5 2.5Z" /></svg>; }
function TrashIcon({ color = 'currentColor' }: { color?: string }) { return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 13 6" /><path d="M5 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M4 6l1 9h6l1-9" /></svg>; }
function PlugIcon() { return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 1v3M10 1v3" /><rect x="3" y="4" width="10" height="5" rx="2" /><path d="M8 9v3" /><path d="M6 12h4" /></svg>; }
