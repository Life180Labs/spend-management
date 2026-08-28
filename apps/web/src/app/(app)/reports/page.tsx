'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { fmt } from '@/lib/utils';
import { exportSpendAnalysis, exportBillingHistory } from '@/lib/excel';

interface CategoryData { category: string; total: number; pct: number; }
interface BillingRecord {
  id: string; monthKey: string; monthLabel: string; amount: number; status: string;
  tool: {
    name: string; monoInitials: string; monoBgColor: string; category: string;
    billingCycle: string; renewalDate: string | null;
  } | null;
}

type Period = 'current' | 'last' | 'quarter' | 'ytd' | 'custom';

function monthKeyNMonthsAgo(n: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Mirrors the backend's dashboard period-spend windowing (apps/api reports.service.ts
// periodSpend) so "This Quarter" / "Year to Date" mean the same set of months everywhere
// in the app, not just here.
function quarterMonthKeys(): string[] {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3; // 0-indexed
  const keys: string[] = [];
  for (let m = quarterStartMonth; m <= now.getMonth(); m++) {
    keys.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
  }
  return keys;
}

function yearToDateMonthKeys(): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let m = 0; m <= now.getMonth(); m++) {
    keys.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
  }
  return keys;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKeyToLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

// A visible "what date range am I actually looking at" label - without this, a
// period like "This Quarter" can look identical to "Current Month" whenever
// there's no data yet for the quarter's earlier months, which reads as broken
// even though the underlying filter is correct.
function periodRangeLabel(period: Period, customFrom: string, customTo: string): string {
  const now = new Date();
  if (period === 'current') return monthKeyToLabel(monthKeyNMonthsAgo(0));
  if (period === 'last') return monthKeyToLabel(monthKeyNMonthsAgo(1));
  if (period === 'quarter') {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    const quarterEndMonth = quarterStartMonth + 2;
    return `${MONTH_NAMES[quarterStartMonth]} – ${MONTH_NAMES[quarterEndMonth]} ${now.getFullYear()}`;
  }
  if (period === 'ytd') return `Jan – ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  return `${monthKeyToLabel(customFrom)} – ${monthKeyToLabel(customTo)}`;
}

// Actual start/end Date objects for the selected period, for the Excel export's
// Start Date / End Date rows. An in-progress period (current month, this
// quarter, YTD, or a custom range ending in the current month) ends "today" -
// not the calendar month-end - since there's no data beyond today yet; a fully
// closed period (last month, or a custom range ending before this month) ends
// on that period's actual last day.
function periodDateRange(period: Period, customFrom: string, customTo: string): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (period === 'current') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: today };
  if (period === 'last') {
    const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0) };
  }
  if (period === 'quarter') {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return { start: new Date(now.getFullYear(), quarterStartMonth, 1), end: today };
  }
  if (period === 'ytd') return { start: new Date(now.getFullYear(), 0, 1), end: today };

  // custom
  const [fy, fm] = customFrom.split('-').map(Number);
  const [ty, tm] = customTo.split('-').map(Number);
  const isOngoingMonth = customTo === monthKeyNMonthsAgo(0);
  return {
    start: new Date(fy, fm - 1, 1),
    end: isOngoingMonth ? today : new Date(ty, tm, 0),
  };
}

const CAT_LABELS: Record<string, string> = {
  AI_LLM: 'AI / LLM', CLOUD_INFRA: 'Cloud Infra', COMMUNICATION: 'Communication',
  DEV_TOOLS: 'Dev Tools', DESIGN: 'Design', HOSTING: 'Hosting', MONITORING: 'Monitoring', OTHER: 'Other',
};

const fieldStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13, color: '#E8EAF0',
  backgroundColor: '#1A1D26', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, outline: 'none',
};
const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#767b86',
  marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em',
};

export default function ReportsPage() {
  const [tab, setTab] = useState<'spend' | 'billing'>('spend');
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [billing, setBilling] = useState<BillingRecord[]>([]);
  const [period, setPeriod] = useState<Period>('current');
  const [customFrom, setCustomFrom] = useState(monthKeyNMonthsAgo(2));
  const [customTo, setCustomTo] = useState(monthKeyNMonthsAgo(0));
  const [currency, setCurrency] = useState<'INR' | 'USD'>('USD');
  const [fxRate, setFxRate] = useState(94.4);

  useEffect(() => {
    const saved = localStorage.getItem('spend_currency') as 'INR' | 'USD' | null;
    if (saved) setCurrency(saved);
    fetch('https://api.frankfurter.app/latest?from=USD&to=INR')
      .then((r) => r.json())
      .then((d: any) => { if (d?.rates?.INR) setFxRate(d.rates.INR); })
      .catch(() => { });
    const onCurrencyChange = (e: Event) => setCurrency((e as CustomEvent<'INR' | 'USD'>).detail);
    window.addEventListener('spend_currency_change', onCurrencyChange);
    return () => window.removeEventListener('spend_currency_change', onCurrencyChange);
  }, []);

  useEffect(() => {
    api.get<CategoryData[]>('/reports/spend-by-category').then(setCategories);
    api.get<{ items: BillingRecord[] }>('/reports/billing-history?limit=100').then((d) => setBilling(d.items));
  }, []);

  const totalSpend = categories.reduce((s, c) => s + c.total, 0);
  const toolCount = billing.reduce((acc, r) => { acc.add(r.tool?.name || '?'); return acc; }, new Set<string>()).size;

  const periodLabel = period === 'current' ? monthKeyNMonthsAgo(0)
    : period === 'last' ? monthKeyNMonthsAgo(1)
    : period === 'quarter' ? `Q${Math.floor(new Date().getMonth() / 3) + 1}_${new Date().getFullYear()}`
    : period === 'ytd' ? `YTD_${new Date().getFullYear()}`
    : `${customFrom}_to_${customTo}`;
  const filteredBilling = period === 'current' ? billing.filter((r) => r.monthKey === monthKeyNMonthsAgo(0))
    : period === 'last' ? billing.filter((r) => r.monthKey === monthKeyNMonthsAgo(1))
    : period === 'quarter' ? billing.filter((r) => quarterMonthKeys().includes(r.monthKey))
    : period === 'ytd' ? billing.filter((r) => yearToDateMonthKeys().includes(r.monthKey))
    : billing.filter((r) => r.monthKey >= customFrom && r.monthKey <= customTo); // YYYY-MM sorts lexicographically
  const filteredTotal = filteredBilling.reduce((s, r) => s + r.amount, 0);

  const fmtAmt = (n: number) => currency === 'USD'
    ? fmt(n)
    : `₹${(n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const reportStats = [
    { label: 'Total Monthly Spend', value: fmtAmt(totalSpend), sub: 'this period' },
    { label: 'Tracked Tools', value: String(toolCount), sub: 'with billing records' },
    { label: 'Categories', value: String(categories.length), sub: 'active categories' },
  ];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 980 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ marginBottom: 4 }}>
          <h1 style={{ fontSize: 18, fontWeight: 660, color: '#F2F3F5', letterSpacing: '-.02em', margin: '0 0 4px' }}>Reports</h1>
          <p style={{ fontSize: 12, color: '#767b86', margin: 0 }}>Spend breakdown across categories and tools.</p>
        </div>
        <DownloadBtn
          onClick={() => {
            if (tab === 'spend') {
              const { start, end } = periodDateRange(period, customFrom, customTo);
              exportSpendAnalysis(categories, reportStats, currency, fxRate, start, end);
            } else {
              // Billing History computes each row's own Start/End Date from its
              // tool's renewal day, not a single report-level range - see
              // billingRowPeriod() in excel.ts.
              exportBillingHistory(filteredBilling, periodLabel, currency, fxRate, periodRangeLabel(period, customFrom, customTo));
            }
          }}
          label={tab === 'spend' ? 'Download Spend Report' : 'Download Billing History'}
        />
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 4, background: '#121419', border: '1px solid #1E212A', borderRadius: 10, padding: 3, alignSelf: 'flex-start' }}>
        <TabBtn active={tab === 'spend'} onClick={() => setTab('spend')}>Spend Analysis</TabBtn>
        <TabBtn active={tab === 'billing'} onClick={() => setTab('billing')}>Billing History</TabBtn>
      </div>

      {tab === 'spend' && (
        <>
          {/* Report stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
            {reportStats.map((s) => (
              <div key={s.label} style={{ background: '#101218', border: '1px solid #1E212A', borderRadius: 13, padding: '16px 18px' }}>
                <div style={{ fontSize: 11.5, color: '#878c96', marginBottom: 9 }}>{s.label}</div>
                <div style={{ fontSize: 23, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.02em', lineHeight: 1 }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#6b707b', marginTop: 7 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          {/* Spend by Category */}
          <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, padding: '22px 24px' }}>
            <h3 style={{ fontSize: 14, fontWeight: 650, color: '#E6E8EC', margin: '0 0 4px' }}>Spend by Category</h3>
            <p style={{ fontSize: 12, color: '#767b86', margin: '0 0 20px' }}>Monthly spend &amp; pre-paid consumption grouped by category.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {categories.length === 0 && <p style={{ fontSize: 13, color: '#5e636e', margin: 0 }}>No spend data for this period.</p>}
              {categories.map((c) => (
                <div key={c.category}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 550, color: '#cfd3da' }}>{CAT_LABELS[c.category] || c.category}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 650, color: '#F2F3F5' }}>{fmtAmt(c.total)}</span>
                  </div>
                  <div style={{ height: 9, borderRadius: 999, background: '#16191F', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 999, width: `${c.pct}%`, background: 'linear-gradient(90deg,#5E6AD2,#8B5CF6)' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {tab === 'billing' && (
        <>
          {/* Period selector */}
          <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, padding: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: period === 'custom' ? '2fr 1fr 1fr' : '1fr', gap: 14, alignItems: 'end' }}>
              <div>
                <label style={labelStyle}><Clock size={11} /> Period</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6, maxWidth: 660 }}>
                  {([
                    { key: 'current', label: 'Current Month' },
                    { key: 'last', label: 'Last Month' },
                    { key: 'quarter', label: 'This Quarter' },
                    { key: 'ytd', label: 'Year to Date' },
                    { key: 'custom', label: 'Custom' },
                  ] as const).map((p) => {
                    const on = period === p.key;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => setPeriod(p.key)}
                        style={{
                          padding: '9px 8px', fontSize: 12, fontWeight: 600, textAlign: 'center',
                          backgroundColor: on ? 'rgba(94,106,210,0.16)' : '#161921',
                          border: on ? '1.5px solid rgba(94,106,210,0.55)' : '1.5px solid rgba(255,255,255,0.07)',
                          color: on ? '#9aa2ef' : '#7a8090',
                          borderRadius: 9, cursor: 'pointer', transition: 'background .15s, border-color .15s',
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {period === 'custom' && (
                <>
                  <div>
                    <label style={labelStyle}>From</label>
                    <input
                      type="month" value={customFrom} max={customTo}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      style={{ ...fieldStyle, colorScheme: 'dark' }}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>To</label>
                    <input
                      type="month" value={customTo} min={customFrom} max={monthKeyNMonthsAgo(0)}
                      onChange={(e) => setCustomTo(e.target.value)}
                      style={{ ...fieldStyle, colorScheme: 'dark' }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Billing table */}
          <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 1fr 0.9fr 0.9fr 1fr 100px', padding: '11px 20px', background: '#0C0E12', borderBottom: '1px solid #1A1D24' }}>
              {['Tool', 'Category', 'Month', 'Period', 'Amount', 'Status'].map((h) => (
                <div key={h} style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#5e636e' }}>{h}</div>
              ))}
            </div>
            {filteredBilling.map((r, i) => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.8fr 1fr 0.9fr 0.9fr 1fr 100px', alignItems: 'center', padding: '13px 20px', borderBottom: i < filteredBilling.length - 1 ? '1px solid #15181E' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: r.tool?.monoBgColor || '#5E6AD2', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700, flexShrink: 0 }}>{r.tool?.monoInitials || '?'}</div>
                  <span style={{ fontSize: 13, fontWeight: 550, color: '#E6E8EC' }}>{r.tool?.name || 'Deleted tool'}</span>
                </div>
                <div style={{ fontSize: 12, color: '#9aa0ab' }}>{CAT_LABELS[r.tool?.category || ''] || r.tool?.category || '-'}</div>
                <div style={{ fontSize: 12, color: '#9aa0ab' }}>{r.monthLabel}</div>
                <div style={{ fontSize: 12, color: '#9aa0ab' }}>{periodRangeLabel(period, customFrom, customTo)}</div>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: '#F2F3F5', fontVariantNumeric: 'tabular-nums' }}>{fmtAmt(r.amount)}</div>
                <div>
                  {(() => {
                    const isLive = r.id.startsWith('live-');
                    const label = r.status === 'PAID' ? 'Paid' : isLive ? 'In progress' : 'Pending';
                    const color = r.status === 'PAID' ? '#3FB950' : isLive ? '#9aa2ef' : '#d99e3e';
                    const bg = r.status === 'PAID' ? 'rgba(63,185,80,.12)' : isLive ? 'rgba(94,106,210,.14)' : 'rgba(245,166,35,.12)';
                    return (
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, background: bg, color }}>
                        {label}
                      </span>
                    );
                  })()}
                </div>
              </div>
            ))}
            {filteredBilling.length === 0 && (
              <div style={{ padding: '24px 20px', textAlign: 'center', fontSize: 13, color: '#5e636e' }}>No billing records found</div>
            )}
            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', background: '#0A0C10', borderTop: '1px solid #1A1D24' }}>
              <span style={{ fontSize: 12, color: '#6b707b' }}>{filteredBilling.length} records</span>
              <span style={{ fontSize: 13, fontWeight: 650, color: '#F2F3F5' }}>{fmtAmt(filteredTotal)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DownloadBtn({ onClick, label }: { onClick: () => void; label: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 9, background: hover ? '#1f2330' : '#171a22', border: '1px solid #2a2e3d', color: '#9aa2ef', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap' }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v8M5 7l3 3 3-3" /><rect x="2" y="12" width="12" height="2" rx="1" />
      </svg>
      {label}
    </button>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontFamily: 'inherit', fontSize: 12.5, fontWeight: 550, padding: '7px 16px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${active ? '#2a2e3d' : 'transparent'}`, background: active ? '#1B1E26' : 'transparent', color: active ? '#E6E8EC' : '#6b707b' }}>
      {children}
    </button>
  );
}
