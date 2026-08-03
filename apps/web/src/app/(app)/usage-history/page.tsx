'use client';

import { useEffect, useState, useCallback } from 'react';
import { Cpu, MemoryStick, Clock, History, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { fmt } from '@/lib/utils';

interface BreakdownItem { measurement: string; amountUSD: number; rawValue: number; }
interface ProjectBreakdownItem { projectId: string; projectName: string; amountUSD: number; }

interface Tool {
  id: string; name: string; vendor: string;
  usedAmount: number; capAmount: number;
  integration: {
    provider: string; isActive: boolean;
    lastSyncAt: string | null; lastSyncAmountUSD: number | null;
    lastSyncBreakdown: BreakdownItem[] | null;
    lastSyncByProject: ProjectBreakdownItem[] | null;
  } | null;
}

interface HistoryResult {
  amountUSD: number; breakdown: BreakdownItem[]; byProject: ProjectBreakdownItem[];
  startDate: string; endDate: string;
}

const PROJECT_ROWS_SHOWN = 5;

type Period = 'current' | 'last' | 'quarter' | 'ytd' | 'custom';

// Validated categorical pair (dataviz skill, --mode dark): CVD-safe on this app's dark surfaces.
const MEASUREMENT_META: Record<string, { label: string; unit: string; color: string; icon: typeof Cpu }> = {
  CPU_USAGE:       { label: 'Compute (CPU)', unit: 'vCPU-hrs', color: '#5E6AD2', icon: Cpu },
  MEMORY_USAGE_GB: { label: 'Memory',        unit: 'GB-hrs',   color: '#0EA5A8', icon: MemoryStick },
};

// Local YYYY-MM-DD — never toISOString() for a calendar date. toISOString() converts to
// UTC first, and in a timezone ahead of UTC (e.g. IST, UTC+5:30) that pushes local midnight
// on the 1st back to 18:30 the previous day, so "Jul 1" silently becomes "Jun 30".
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthRange(monthsAgo: number): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const end = monthsAgo === 0
    ? now
    : new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 0, 23, 59, 59);
  return { from: toLocalDateStr(start), to: toLocalDateStr(end) };
}

// Calendar quarter-to-date (Jul 1 – today for Q3), matching the same definition
// used on Reports > Billing History and the Dashboard's period dropdown, so
// "This Quarter" means the same set of dates everywhere in the app.
function quarterRange(): { from: string; to: string } {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const start = new Date(now.getFullYear(), quarterStartMonth, 1);
  return { from: toLocalDateStr(start), to: toLocalDateStr(now) };
}

function yearToDateRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return { from: toLocalDateStr(start), to: toLocalDateStr(now) };
}

function fmtRangeLabel(from: string, to: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  return `${new Date(from).toLocaleDateString('en-US', opts)} – ${new Date(to).toLocaleDateString('en-US', opts)}`;
}

// Provider usage APIs (Railway's included) can return slightly different numbers for the
// same query seconds apart — an "as of" stamp makes clear this is one live read, not a
// disagreement with any other screen reading the same provider at a different instant.
// Same relative format as the dashboard's tool rows ("synced Xm ago"), so the two screens
// read consistently.
function fmtFetchedAt(d: Date): string {
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

const fieldStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13, color: '#E8EAF0',
  backgroundColor: '#1A1D26', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9,
  outline: 'none',
};
const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#767b86',
  marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em',
};

export default function UsageHistoryPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolId, setToolId] = useState<string>('');
  const [period, setPeriod] = useState<Period>('current');
  const [customFrom, setCustomFrom] = useState(monthRange(0).from);
  const [customTo, setCustomTo] = useState(monthRange(0).to);

  const [result, setResult] = useState<HistoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const [currency, setCurrency] = useState<'INR' | 'USD'>('USD');
  const [fxRate, setFxRate] = useState(94.4);
  const [showAllProjects, setShowAllProjects] = useState(false);

  // Forces a re-render every 30s purely so "Xm ago" keeps ticking up without a manual
  // refresh — same cadence as the dashboard's auto-refresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

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
    api.get<Tool[]>('/tools').then((all) => {
      const integrated = all.filter((t) => t.integration?.isActive);
      setTools(integrated);
      if (integrated.length && !toolId) setToolId(integrated[0].id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rangeFor = useCallback((p: Period): { from: string; to: string } => {
    if (p === 'current') return monthRange(0);
    if (p === 'last') return monthRange(1);
    if (p === 'quarter') return quarterRange();
    if (p === 'ytd') return yearToDateRange();
    return { from: customFrom, to: customTo };
  }, [customFrom, customTo]);

  // Current Month is never fetched live from the provider — it reads the same
  // usedAmount/breakdown the regular 15-min sync already wrote to the DB, so this
  // page can never disagree with the dashboard about "current month" (they're
  // reading the same row). Last Month / Custom Range have nothing synced to read,
  // since the app only tracks the current period, so those still call the provider
  // live via /history.
  const refreshCurrentFromDb = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const all = await api.get<Tool[]>('/tools');
      const integrated = all.filter((t) => t.integration?.isActive);
      setTools(integrated);
    } catch (e: any) {
      setError(e.message || 'Could not load tool data.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!toolId) return;

    if (period === 'current') {
      await refreshCurrentFromDb();
      return;
    }

    const { from, to } = rangeFor(period);
    if (new Date(from) > new Date(to)) { setError('Start date must be before end date.'); return; }

    setLoading(true); setError(''); setResult(null);
    try {
      const res = await api.get<HistoryResult>(`/integrations/${toolId}/history?from=${from}&to=${to}`);
      setResult(res);
      setFetchedAt(new Date());
    } catch (e: any) {
      setError(e.message || 'Could not fetch usage history.');
    } finally {
      setLoading(false);
    }
  }, [toolId, period, rangeFor, refreshCurrentFromDb]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);
  useEffect(() => { setShowAllProjects(false); }, [toolId, period]);

  const fmtAmt = (usd: number) => currency === 'USD'
    ? fmt(usd)
    : `₹${(usd * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const isCurrent = period === 'current';
  const selectedTool = tools.find((t) => t.id === toolId);
  const activeRange = rangeFor(period);

  const total = isCurrent ? (selectedTool?.usedAmount ?? 0) : (result?.amountUSD ?? 0);
  const breakdown = (isCurrent ? (selectedTool?.integration?.lastSyncBreakdown ?? []) : (result?.breakdown ?? []))
    .filter((b) => MEASUREMENT_META[b.measurement]);
  const byProject = isCurrent ? (selectedTool?.integration?.lastSyncByProject ?? []) : (result?.byProject ?? []);
  const hasData = isCurrent ? !!selectedTool?.integration?.lastSyncAt : !!result;
  const syncedAt = isCurrent
    ? (selectedTool?.integration?.lastSyncAt ? new Date(selectedTool.integration.lastSyncAt) : null)
    : fetchedAt;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(94,106,210,.14)', color: '#9aa2ef', flexShrink: 0 }}>
          <History size={17} />
        </div>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 660, color: '#F2F3F5', letterSpacing: '-.02em', margin: '0 0 2px' }}>Usage History</h1>
          <p style={{ fontSize: 12, color: '#767b86', margin: 0 }}>
            Spend pulled directly from the provider for any past period.
          </p>
        </div>
      </div>

      {tools.length === 0 ? (
        <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, padding: '36px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: '#9aa0ab', marginBottom: 4 }}>No tools with a live integration yet</div>
          <div style={{ fontSize: 12, color: '#5e636e' }}>Connect a tool (e.g. Railway) from the dashboard to see its usage history here.</div>
        </div>
      ) : (
        <>
          {/* Filters */}
          <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: period === 'custom' ? '1fr 2fr 1fr 1fr' : '1fr 2.4fr', gap: 14, alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>Tool</label>
                <select value={toolId} onChange={(e) => setToolId(e.target.value)} style={{ ...fieldStyle, cursor: 'pointer' }}>
                  {tools.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} · {t.integration?.provider}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle}><Clock size={11} /> Period</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6 }}>
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
                      type="date" value={customFrom} max={customTo}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      style={{ ...fieldStyle, colorScheme: 'dark' }}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>To</label>
                    <input
                      type="date" value={customTo} min={customFrom} max={monthRange(0).to}
                      onChange={(e) => setCustomTo(e.target.value)}
                      style={{ ...fieldStyle, colorScheme: 'dark' }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Result card */}
          <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 14, padding: '24px 26px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: '#cfd3da', marginBottom: 2 }}>
                  {selectedTool ? `${selectedTool.name} · ${selectedTool.integration?.provider}` : ''}
                </div>
                <div style={{ fontSize: 11, color: '#5e636e' }}>{fmtRangeLabel(activeRange.from, activeRange.to)}</div>
                {syncedAt && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 10.5, color: '#4a4f59' }}>
                    <span>{isCurrent ? 'Synced' : 'Live read'} {fmtFetchedAt(syncedAt)}</span>
                    <button
                      type="button"
                      onClick={fetchHistory}
                      disabled={loading}
                      title={isCurrent ? 'Refresh from the last background sync' : 'Refresh — provider usage APIs can shift slightly between reads'}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 16, height: 16, padding: 0, border: 'none', borderRadius: 4,
                        background: 'transparent', color: '#5e636e', cursor: loading ? 'default' : 'pointer',
                      }}
                    >
                      <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
                    </button>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, background: '#161921', borderRadius: 8, padding: 3, flexShrink: 0 }}>
                {(['USD', 'INR'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setCurrency(c);
                      localStorage.setItem('spend_currency', c);
                      window.dispatchEvent(new CustomEvent('spend_currency_change', { detail: c }));
                    }}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, border: 'none', cursor: 'pointer',
                      background: currency === c ? '#5E6AD2' : 'transparent',
                      color: currency === c ? '#fff' : '#7a8090',
                    }}
                  >
                    {c === 'USD' ? '$ USD' : '₹ INR'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              {loading ? (
                <div style={{ fontSize: 32, fontWeight: 680, color: '#2a2d36', letterSpacing: '-.02em' }}>Loading…</div>
              ) : error ? (
                <div style={{ fontSize: 12.5, color: '#F85149', lineHeight: 1.5, maxWidth: 480 }}>{error}</div>
              ) : hasData ? (
                <div style={{ fontSize: 38, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmt(total)}
                </div>
              ) : isCurrent ? (
                <div style={{ fontSize: 13, color: '#5e636e' }}>Not synced yet — connect the integration or wait for the next 15-min sync.</div>
              ) : (
                <div style={{ fontSize: 13, color: '#5e636e' }}>No data for this period.</div>
              )}
            </div>

            {/* CPU / Memory breakdown */}
            {hasData && breakdown.length > 0 && total > 0 && (
              <div style={{ marginTop: 22 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#4a4f59', marginBottom: 10 }}>
                  Where it came from
                </div>

                {/* Segmented bar */}
                <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 999, overflow: 'hidden', marginBottom: 14 }}>
                  {breakdown.map((b) => {
                    const meta = MEASUREMENT_META[b.measurement];
                    const pct = Math.max((b.amountUSD / total) * 100, b.amountUSD > 0 ? 1.5 : 0);
                    return pct > 0 ? (
                      <div key={b.measurement} style={{ width: `${pct}%`, background: meta.color, borderRadius: 4 }} />
                    ) : null;
                  })}
                </div>

                {/* Rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {breakdown.map((b) => {
                    const meta = MEASUREMENT_META[b.measurement];
                    const Icon = meta.icon;
                    const pct = total > 0 ? Math.round((b.amountUSD / total) * 100) : 0;
                    const rawHours = (b.rawValue / 60).toLocaleString('en-US', { maximumFractionDigits: 1 });
                    return (
                      <div key={b.measurement} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: meta.color, flexShrink: 0 }} />
                        <Icon size={13} color="#6b707b" style={{ flexShrink: 0 }} />
                        <span style={{ fontSize: 12.5, color: '#c2c6cf', fontWeight: 550, minWidth: 118 }}>{meta.label}</span>
                        <span style={{ fontSize: 11.5, color: '#5e636e', flex: 1 }}>{rawHours} {meta.unit}</span>
                        <span style={{ fontSize: 12.5, color: '#9aa0ab', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
                        <span style={{ fontSize: 13, color: '#E8EAF0', fontWeight: 650, fontVariantNumeric: 'tabular-nums', minWidth: 70, textAlign: 'right' }}>
                          {fmtAmt(b.amountUSD)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Per-project breakdown — a ranked magnitude list, not identity, so every
                row shares one accent hue; bar length carries the comparison, not color. */}
            {hasData && byProject.length > 0 && total > 0 && (
              <div style={{ marginTop: 22 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#4a4f59', marginBottom: 10 }}>
                  By project
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(showAllProjects ? byProject : byProject.slice(0, PROJECT_ROWS_SHOWN)).map((p) => {
                    const pct = total > 0 ? (p.amountUSD / total) * 100 : 0;
                    return (
                      <div key={p.projectId}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 12, color: '#c2c6cf', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.projectName}
                          </span>
                          <span style={{ fontSize: 12, color: '#9aa0ab', fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0, marginLeft: 10 }}>
                            {fmtAmt(p.amountUSD)}
                          </span>
                        </div>
                        <div style={{ height: 5, borderRadius: 999, background: '#1B1E26', overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 999, width: `${Math.max(pct, p.amountUSD > 0 ? 1 : 0)}%`, background: '#5E6AD2' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {byProject.length > PROJECT_ROWS_SHOWN && (
                  <button
                    type="button"
                    onClick={() => setShowAllProjects((v) => !v)}
                    style={{
                      marginTop: 10, fontSize: 11.5, fontWeight: 600, color: '#7a8090',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    }}
                  >
                    {showAllProjects ? 'Show fewer' : `+ ${byProject.length - PROJECT_ROWS_SHOWN} more project${byProject.length - PROJECT_ROWS_SHOWN === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
