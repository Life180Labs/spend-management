'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmt } from '@/lib/utils';
import { exportSpendAnalysis, exportBillingHistory } from '@/lib/excel';

interface CategoryData { category: string; total: number; pct: number; }
interface BillingRecord {
  id: string; monthKey: string; monthLabel: string; amount: number; status: string;
  tool: { name: string; monoInitials: string; monoBgColor: string; category: string } | null;
}
interface MonthSummary { monthKey: string; monthLabel: string; total: number; count: number; }

const CAT_LABELS: Record<string, string> = {
  AI_LLM: 'AI / LLM', CLOUD_INFRA: 'Cloud Infra', COMMUNICATION: 'Communication',
  DEV_TOOLS: 'Dev Tools', DESIGN: 'Design', HOSTING: 'Hosting', MONITORING: 'Monitoring', OTHER: 'Other',
};

export default function ReportsPage() {
  const [tab, setTab] = useState<'spend' | 'billing'>('spend');
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [billing, setBilling] = useState<BillingRecord[]>([]);
  const [monthSummary, setMonthSummary] = useState<MonthSummary[]>([]);
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [currency, setCurrency] = useState<'INR' | 'USD'>('USD');
  const [fxRate, setFxRate] = useState(94.4);

  useEffect(() => {
    const saved = localStorage.getItem('spend_currency') as 'INR' | 'USD' | null;
    if (saved) setCurrency(saved);
    fetch('https://api.frankfurter.app/latest?from=USD&to=INR')
      .then((r) => r.json())
      .then((d: any) => { if (d?.rates?.INR) setFxRate(d.rates.INR); })
      .catch(() => {});
    const onCurrencyChange = (e: Event) => setCurrency((e as CustomEvent<'INR' | 'USD'>).detail);
    window.addEventListener('spend_currency_change', onCurrencyChange);
    return () => window.removeEventListener('spend_currency_change', onCurrencyChange);
  }, []);

  useEffect(() => {
    api.get<CategoryData[]>('/reports/spend-by-category').then(setCategories);
    api.get<{ items: BillingRecord[] }>('/reports/billing-history?limit=100').then((d) => setBilling(d.items));
    api.get<MonthSummary[]>('/billing/month-summary').then(setMonthSummary);
  }, []);

  const totalSpend = categories.reduce((s, c) => s + c.total, 0);
  const toolCount = billing.reduce((acc, r) => { acc.add(r.tool?.name || '?'); return acc; }, new Set<string>()).size;
  const filteredBilling = monthFilter === 'all' ? billing : billing.filter((r) => r.monthKey === monthFilter);
  const filteredTotal = filteredBilling.reduce((s, r) => s + r.amount, 0);

  const fmtAmt = (n: number) => currency === 'USD'
    ? fmt(n)
    : `₹${(n * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const reportStats = [
    { label: 'Total Monthly Spend', value: fmtAmt(totalSpend), sub: 'this period' },
    { label: 'Tracked Tools', value: String(toolCount), sub: 'with billing records' },
    { label: 'Categories', value: String(categories.length), sub: 'active categories' },
    { label: 'Avg / Tool', value: toolCount ? fmtAmt(Math.round(totalSpend / toolCount)) : `${currency === 'USD' ? '$' : '₹'}0`, sub: 'per month' },
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
              exportSpendAnalysis(categories, reportStats, currency, fxRate);
            } else {
              exportBillingHistory(filteredBilling, monthFilter, currency, fxRate);
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
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
          {/* Month filter pills */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <MonthBtn active={monthFilter === 'all'} onClick={() => setMonthFilter('all')}>All months</MonthBtn>
            {monthSummary.map((m) => (
              <MonthBtn key={m.monthKey} active={monthFilter === m.monthKey} onClick={() => setMonthFilter(m.monthKey)}>{m.monthLabel}</MonthBtn>
            ))}
          </div>

          {/* Billing table */}
          <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.1fr 1fr 1fr 100px', padding: '11px 20px', background: '#0C0E12', borderBottom: '1px solid #1A1D24' }}>
              {['Tool', 'Category', 'Period', 'Amount', 'Status'].map((h) => (
                <div key={h} style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#5e636e' }}>{h}</div>
              ))}
            </div>
            {filteredBilling.map((r, i) => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1.1fr 1fr 1fr 100px', alignItems: 'center', padding: '13px 20px', borderBottom: i < filteredBilling.length - 1 ? '1px solid #15181E' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: r.tool?.monoBgColor || '#5E6AD2', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700, flexShrink: 0 }}>{r.tool?.monoInitials || '?'}</div>
                  <span style={{ fontSize: 13, fontWeight: 550, color: '#E6E8EC' }}>{r.tool?.name || 'Deleted tool'}</span>
                </div>
                <div style={{ fontSize: 12, color: '#9aa0ab' }}>{CAT_LABELS[r.tool?.category || ''] || r.tool?.category || '—'}</div>
                <div style={{ fontSize: 12, color: '#9aa0ab' }}>{r.monthLabel}</div>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: '#F2F3F5', fontVariantNumeric: 'tabular-nums' }}>{fmtAmt(r.amount)}</div>
                <div>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, background: r.status === 'PAID' ? 'rgba(63,185,80,.12)' : 'rgba(245,166,35,.12)', color: r.status === 'PAID' ? '#3FB950' : '#d99e3e' }}>
                    {r.status === 'PAID' ? 'Paid' : 'Pending'}
                  </span>
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
        <path d="M8 2v8M5 7l3 3 3-3"/><rect x="2" y="12" width="12" height="2" rx="1"/>
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

function MonthBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontFamily: 'inherit', fontSize: 12, fontWeight: 550, padding: '5px 13px', borderRadius: 20, cursor: 'pointer', border: `1px solid ${active ? 'rgba(94,106,210,.4)' : '#1E212A'}`, background: active ? 'rgba(94,106,210,.12)' : 'transparent', color: active ? '#9aa2ef' : '#6b707b' }}>
      {children}
    </button>
  );
}
