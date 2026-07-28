'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

/* ─── constants ─────────────────────────────────────────────────────────── */

const CATEGORIES = [
  { value: 'AI_LLM',        label: 'AI / LLM' },
  { value: 'CLOUD_INFRA',   label: 'Cloud Infra' },
  { value: 'COMMUNICATION', label: 'Communication' },
  { value: 'DEV_TOOLS',     label: 'Dev Tools' },
  { value: 'DESIGN',        label: 'Design' },
  { value: 'HOSTING',       label: 'Hosting' },
  { value: 'MONITORING',    label: 'Monitoring' },
  { value: 'OTHER',         label: 'Other' },
];

/* ─── types ──────────────────────────────────────────────────────────────── */

interface ExistingTool {
  id: string; name: string; vendor: string; category: string;
  paymentKind: string; capAmount: number; monthlyAmount: number;
  alertThresholdPct: number; triggerEmail?: string | null;
  renewalDate?: string | null; alert?: boolean; barPct?: number;
  integration?: { provider: string; isActive: boolean } | null;
}

interface Limits {
  computeHardLimitUSD: number; computeSoftLimitUSD: number;
  alertThresholdPct: number;
}

interface Props {
  onClose: () => void;
  onCreated: (tool: any) => void;
  tool?: ExistingTool;
}

/* ─── shared styles ──────────────────────────────────────────────────────── */

const S = {
  overlay: {
    position: 'fixed' as const, inset: 0, zIndex: 9999,
    backgroundColor: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  modal: {
    width: '100%', maxWidth: 460,
    backgroundColor: '#13161D',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 16,
    display: 'flex', flexDirection: 'column' as const,
    maxHeight: '92vh',
  },
  header: {
    padding: '18px 24px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    flexShrink: 0,
  },
  body: {
    overflowY: 'auto' as const,
    padding: '20px 24px 8px',
    display: 'flex', flexDirection: 'column' as const, gap: 20,
    flex: 1,
  },
  footer: {
    padding: '16px 24px',
    borderTop: '1px solid rgba(255,255,255,0.07)',
    display: 'flex', gap: 10, flexShrink: 0,
  },
  label: {
    display: 'block', fontSize: 12, color: '#8a909b',
    marginBottom: 7, fontWeight: 500,
  },
  input: {
    display: 'block', width: '100%', boxSizing: 'border-box' as const,
    padding: '9px 12px', fontSize: 13, color: '#E8EAF0',
    backgroundColor: '#1A1D26',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, outline: 'none',
  },
  select: {
    display: 'block', width: '100%', boxSizing: 'border-box' as const,
    padding: '9px 12px', fontSize: 13, color: '#E8EAF0',
    backgroundColor: '#1A1D26',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, outline: 'none', cursor: 'pointer',
  },
  lockedInput: {
    display: 'block', width: '100%', boxSizing: 'border-box' as const,
    padding: '9px 12px', fontSize: 13, color: '#555b6b',
    backgroundColor: '#111318',
    border: '1px solid rgba(255,255,255,0.05)',
    borderRadius: 8,
  },
  btnPrimary: {
    flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600,
    color: '#fff', backgroundColor: '#5E6AD2',
    border: 'none', borderRadius: 9, cursor: 'pointer',
  },
  btnSecondary: {
    flex: 1, padding: '10px 0', fontSize: 13,
    color: '#8a909b', backgroundColor: '#1A1D26',
    border: '1px solid rgba(255,255,255,0.07)', borderRadius: 9, cursor: 'pointer',
  },
  sectionTitle: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
    color: '#3d4250', textTransform: 'uppercase' as const,
    marginBottom: 12,
  },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  error: {
    padding: '10px 14px', fontSize: 12, color: '#f87171',
    backgroundColor: 'rgba(248,81,73,0.09)',
    border: '1px solid rgba(248,81,73,0.2)', borderRadius: 8,
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   AddToolModal
═══════════════════════════════════════════════════════════════════════════ */

export function AddToolModal({ onClose, onCreated, tool }: Props) {
  const isEdit = !!tool;
  const hasIntegration = isEdit && !!tool?.integration;
  const provider = tool?.integration?.provider ?? null;

  /* ── form state ─────────────────────────────────────────────────────── */
  const [name,             setName]             = useState(tool?.name ?? '');
  const [vendor,           setVendor]           = useState(tool?.vendor ?? '');
  const [category,         setCategory]         = useState(tool?.category ?? 'AI_LLM');
  const [paymentKind,      setPaymentKind]      = useState(tool?.paymentKind ?? 'PREPAID');
  const [capAmount,        setCapAmount]        = useState(tool?.capAmount ? String(tool.capAmount) : '');
  const [monthlyAmount,    setMonthlyAmount]    = useState(tool?.monthlyAmount ? String(tool.monthlyAmount) : '');
  const [alertPct,         setAlertPct]         = useState(String(tool?.alertThresholdPct ?? 80));
  const [emailUser,        setEmailUser]        = useState(
    tool?.triggerEmail ? tool.triggerEmail.replace(/@life180labs\.com$/i, '') : ''
  );
  const [renewalDate,      setRenewalDate]      = useState(
    tool?.renewalDate ? new Date(tool.renewalDate).toISOString().split('T')[0] : ''
  );

  /* ── add-mode setup ─────────────────────────────────────────────────── */
  const [mode,          setMode]          = useState<'api' | 'manual'>('api');
  const [apiKey,        setApiKey]        = useState('');
  const [fetchStatus,   setFetchStatus]   = useState<'idle' | 'loading' | 'ok' | 'err'>('idle');
  const [fetchError,    setFetchError]    = useState('');
  const [limits,        setLimits]        = useState<Limits | null>(null);

  /* ── edit-mode refresh ──────────────────────────────────────────────── */
  const [refreshing,    setRefreshing]    = useState(false);
  const [refreshErr,    setRefreshErr]    = useState('');
  const [refreshed,     setRefreshed]     = useState<Limits | null>(null);

  /* ── submit ─────────────────────────────────────────────────────────── */
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [depts,   setDepts]   = useState<{ id: string }[]>([]);

  useEffect(() => { api.get<any[]>('/departments').then(setDepts).catch(() => {}); }, []);

  /* ── fetch limits preview (add mode) ─────────────────────────────────── */
  async function fetchLimits() {
    const key = apiKey.trim();
    if (!key) return;
    setFetchStatus('loading'); setFetchError('');
    try {
      const res = await api.post<Limits | null>('/integrations/preview-limits', {
        provider: 'RAILWAY',
        config: { apiToken: key },
      });
      if (res) {
        setLimits(res);
        setFetchStatus('ok');
      } else {
        setFetchStatus('err');
        setFetchError('No limits returned — make sure your Railway account has usage limits set.');
      }
    } catch (e: any) {
      setFetchStatus('err');
      setFetchError(e.message || 'Could not reach provider. Check the API key and try again.');
    }
  }

  /* ── edit-mode refresh from stored integration ───────────────────────── */
  async function refreshLimits() {
    if (!tool?.id) return;
    setRefreshing(true); setRefreshErr('');
    try {
      const res = await api.get<Limits | null>(`/integrations/${tool.id}/limits`);
      if (res) {
        setRefreshed(res);
        setCapAmount(String(res.computeHardLimitUSD));
        setAlertPct(String(res.alertThresholdPct));
      } else {
        setRefreshErr('Could not pull limits from provider.');
      }
    } catch { setRefreshErr('Refresh failed.'); }
    finally { setRefreshing(false); }
  }

  /* ── submit handler ──────────────────────────────────────────────────── */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const needsEmail = paymentKind !== 'NOBUDGET';

    if (isEdit) {
      if (needsEmail && !emailUser.trim()) { setError('Notification email is required'); return; }
      setError(''); setLoading(true);
      try {
        await api.patch<any>(`/tools/${tool!.id}`, {
          category,
          triggerEmail: needsEmail ? `${emailUser.trim()}@life180labs.com` : undefined,
          renewalDate: renewalDate ? new Date(renewalDate).toISOString() : undefined,
        });
        onCreated({ ...tool, category, triggerEmail: needsEmail ? `${emailUser.trim()}@life180labs.com` : undefined, renewalDate });
      } catch (err: any) {
        setError(err.message || 'Something went wrong. Please try again.');
      } finally { setLoading(false); }
      return;
    }

    if (!name.trim())   { setError('Tool name is required'); return; }
    if (!vendor.trim()) { setError('Vendor is required'); return; }
    if (needsEmail && !emailUser.trim()) { setError('Notification email is required'); return; }
    if (paymentKind === 'PREPAID' && mode === 'api' && fetchStatus !== 'ok') {
      setError('Fetch limits from your provider before saving.'); return;
    }
    if (mode === 'manual' && paymentKind === 'PREPAID' && !capAmount) {
      setError('Budget cap is required.'); return;
    }
    if (paymentKind === 'MOSUB' && !monthlyAmount) {
      setError('Monthly amount is required.'); return;
    }

    setError(''); setLoading(true);
    try {
      const cap   = mode === 'api' && limits ? limits.computeHardLimitUSD : (capAmount ? Number(capAmount) : undefined);
      const alert = mode === 'api' && limits ? limits.alertThresholdPct   : (paymentKind === 'PREPAID' ? Number(alertPct) : undefined);

      const payload: any = {
        name: name.trim(), vendor: vendor.trim(), category, paymentKind,
        capAmount: cap,
        monthlyAmount: monthlyAmount ? Number(monthlyAmount) : undefined,
        alertThresholdPct: alert,
        triggerEmail: needsEmail ? `${emailUser.trim()}@life180labs.com` : undefined,
        renewalDate: renewalDate ? new Date(renewalDate).toISOString() : undefined,
      };

      const result = await api.post<any>('/tools', { ...payload, departmentId: depts[0]?.id });

      if (mode === 'api' && apiKey.trim()) {
        try {
          await api.put(`/integrations/${result.id}`, {
            provider: 'RAILWAY',
            config: { apiToken: apiKey.trim() },
          });
        } catch { /* best-effort */ }
      }

      onCreated(result);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally { setLoading(false); }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════════════════ */
  return (
    <div style={S.overlay}>
      <div style={S.modal}>

        {/* Header */}
        <div style={S.header}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#E8EAF0' }}>
            {isEdit ? `Edit — ${tool!.name}` : 'Add Tool'}
          </span>
          <button onClick={onClose} type="button"
            style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>
            ×
          </button>
        </div>

        {/* Scrollable body — everything is one <form> */}
        <form id="tool-form-inner" onSubmit={handleSubmit} style={S.body} noValidate>

          {/* ── Alert banner (edit only) ─────────────────────────────── */}
          {isEdit && tool?.alert && (
            <div style={{ padding: '10px 14px', backgroundColor: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.22)', borderRadius: 9 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#F85149', marginBottom: 3 }}>Alert Active</div>
              <div style={{ fontSize: 12, color: '#b06060' }}>
                Threshold of {tool.alertThresholdPct}% has been breached — currently at {tool.barPct}% used.
              </div>
            </div>
          )}

          {/* error */}
          {error && <div style={S.error}>{error}</div>}

          {/* ══════════════════════════════════════════════════════════
              1. TOOL DETAILS — always first
          ══════════════════════════════════════════════════════════ */}
          <div>
            <div style={S.sectionTitle}>Tool details</div>
            <div style={{ ...S.row2, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Name</label>
                {isEdit ? (
                  <div style={S.lockedInput}>{name}</div>
                ) : (
                  <input value={name} onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. ChatGPT" required style={S.input} />
                )}
              </div>
              <div>
                <label style={S.label}>Vendor</label>
                {isEdit ? (
                  <div style={S.lockedInput}>{vendor}</div>
                ) : (
                  <input value={vendor} onChange={(e) => setVendor(e.target.value)}
                    placeholder="e.g. OpenAI" required style={S.input} />
                )}
              </div>
            </div>
            <div style={S.row2}>
              <div>
                <label style={S.label}>Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={S.select}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Payment type</label>
                {isEdit ? (
                  <div style={S.lockedInput}>
                    {paymentKind === 'PREPAID' ? 'Pre-paid (usage-based)' : paymentKind === 'MOSUB' ? 'Subscription' : 'No budget'}
                  </div>
                ) : (
                  <select value={paymentKind} onChange={(e) => { setPaymentKind(e.target.value); setFetchStatus('idle'); setLimits(null); }} style={S.select}>
                    <option value="PREPAID">Pre-paid (usage-based)</option>
                    <option value="MOSUB">Subscription</option>
                    <option value="NOBUDGET">No budget</option>
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* ══════════════════════════════════════════════════════════
              2. BUDGET SETUP — second, depends on payment type
          ══════════════════════════════════════════════════════════ */}

          {/* ADD mode — prepaid: show connect/manual toggle */}
          {!isEdit && paymentKind === 'PREPAID' && (
            <>
              <div>
                <div style={S.sectionTitle}>Budget setup</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {(['api', 'manual'] as const).map((m) => {
                    const on = mode === m;
                    return (
                      <button key={m} type="button" onClick={() => { setMode(m); setFetchStatus('idle'); setLimits(null); }}
                        style={{
                          padding: '11px 14px', textAlign: 'left',
                          backgroundColor: on ? 'rgba(94,106,210,0.13)' : '#161921',
                          border: on ? '1.5px solid rgba(94,106,210,0.55)' : '1.5px solid rgba(255,255,255,0.07)',
                          borderRadius: 10, cursor: 'pointer',
                        }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: on ? '#9aa2ef' : '#7a8090', marginBottom: 3 }}>
                          {m === 'api' ? 'Connect account' : 'Manual setup'}
                        </div>
                        <div style={{ fontSize: 11, color: on ? '#5b6280' : '#3d4250' }}>
                          {m === 'api' ? 'API key or service account' : 'Enter budget & limits yourself'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Connect account panel */}
              {mode === 'api' && (
                <div style={{ backgroundColor: '#0f1116', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '16px 16px 14px' }}>
                  <label style={S.label}>API key / service account token</label>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setFetchStatus('idle'); setLimits(null); }}
                    placeholder="Paste your API key here"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...S.input, marginBottom: 10, fontFamily: 'monospace', letterSpacing: '0.03em' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button type="button" onClick={fetchLimits}
                      disabled={!apiKey.trim() || fetchStatus === 'loading'}
                      style={{
                        padding: '8px 16px', fontSize: 12, fontWeight: 600,
                        color: fetchStatus === 'ok' ? '#3FB950' : '#fff',
                        backgroundColor: fetchStatus === 'ok' ? 'rgba(63,185,80,0.12)' : '#5E6AD2',
                        border: fetchStatus === 'ok' ? '1px solid rgba(63,185,80,0.35)' : 'none',
                        borderRadius: 7, cursor: (!apiKey.trim() || fetchStatus === 'loading') ? 'not-allowed' : 'pointer',
                        opacity: !apiKey.trim() ? 0.5 : 1,
                      }}>
                      {fetchStatus === 'loading' ? 'Fetching…' : fetchStatus === 'ok' ? '✓ Connected' : 'Fetch limits'}
                    </button>
                    <span style={{ fontSize: 11, color: '#333740' }}>
                      Find in your provider's account → API Tokens
                    </span>
                  </div>
                  {fetchStatus === 'err' && (
                    <div style={{ marginTop: 10, fontSize: 12, color: '#f87171', padding: '8px 10px', backgroundColor: 'rgba(248,81,73,0.07)', borderRadius: 7 }}>
                      {fetchError}
                    </div>
                  )}
                  {fetchStatus === 'ok' && limits && (
                    <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <LimitTile label="Budget cap" main={`$${limits.computeHardLimitUSD.toLocaleString('en-US')}`} sub="hard limit" />
                      <LimitTile label="Alert at" main={`${limits.alertThresholdPct}% of cap`} sub={`$${limits.computeSoftLimitUSD.toLocaleString('en-US')}`} />
                    </div>
                  )}
                </div>
              )}

              {/* Manual budget fields */}
              {mode === 'manual' && (
                <div style={{ ...S.row2 }}>
                  <div>
                    <label style={S.label}>Budget cap ($) *</label>
                    <input type="number" min={1} value={capAmount} onChange={(e) => setCapAmount(e.target.value)}
                      placeholder="e.g. 1000" style={S.input} />
                  </div>
                  <div>
                    <label style={S.label}>Alert at (%)</label>
                    <input type="number" min={1} max={100} value={alertPct} onChange={(e) => setAlertPct(e.target.value)}
                      style={S.input} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* EDIT mode — prepaid: read-only budget display */}
          {isEdit && paymentKind === 'PREPAID' && (
            <div>
              <div style={S.sectionTitle}>Budget & limits</div>
              {hasIntegration && (
                <div style={{ backgroundColor: '#0d130e', border: '1px solid rgba(63,185,80,0.18)', borderRadius: 10, padding: '12px 16px', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#3FB950', display: 'inline-block' }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#5fba6f' }}>Connected to {provider}</span>
                    </div>
                    <button type="button" onClick={refreshLimits} disabled={refreshing}
                      style={{ fontSize: 11, color: '#4a5060', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      {refreshing ? 'Refreshing…' : '↻ Refresh limits'}
                    </button>
                  </div>
                  {refreshErr && <div style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>{refreshErr}</div>}
                  {refreshed && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                      <LimitTile label="Budget cap" main={`$${refreshed.computeHardLimitUSD.toLocaleString('en-US')}`} sub="hard limit" />
                      <LimitTile label="Alert at" main={`${refreshed.alertThresholdPct}%`} sub={`$${refreshed.computeSoftLimitUSD.toLocaleString('en-US')}`} />
                    </div>
                  )}
                </div>
              )}
              <div style={S.row2}>
                <div>
                  <label style={S.label}>Budget cap ($)</label>
                  <div style={S.lockedInput}>${Number(capAmount).toLocaleString('en-US')}</div>
                </div>
                <div>
                  <label style={S.label}>Alert threshold</label>
                  <div style={S.lockedInput}>{alertPct}%</div>
                </div>
              </div>
            </div>
          )}

          {/* Subscription monthly amount */}
          {paymentKind === 'MOSUB' && (
            <div>
              <div style={S.sectionTitle}>Budget</div>
              <label style={S.label}>Monthly amount ($)</label>
              {isEdit ? (
                <div style={S.lockedInput}>${Number(monthlyAmount).toLocaleString('en-US')}</div>
              ) : (
                <input type="number" min={1} value={monthlyAmount} onChange={(e) => setMonthlyAmount(e.target.value)}
                  placeholder="e.g. 100" style={S.input} />
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              3. NOTIFICATIONS
          ══════════════════════════════════════════════════════════ */}
          {paymentKind !== 'NOBUDGET' && (
            <div>
              <div style={S.sectionTitle}>Notifications</div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>
                  {paymentKind === 'MOSUB' ? 'Renewal reminder email' : 'Alert email'}
                  {!isEdit && ' *'}
                </label>
                <div style={{ display: 'flex', alignItems: 'stretch' }}>
                  <input
                    type="text"
                    value={emailUser}
                    onChange={(e) => setEmailUser(e.target.value.replace(/[@\s]/g, ''))}
                    placeholder="admin"
                    autoComplete="off"
                    style={{ ...S.input, borderRadius: '8px 0 0 8px', borderRight: 'none', flex: 1, minWidth: 0 }}
                  />
                  <div style={{
                    padding: '9px 12px', fontSize: 13, color: '#5E6AD2', fontWeight: 500,
                    backgroundColor: '#13161D', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0 8px 8px 0', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center',
                  }}>
                    @life180labs.com
                  </div>
                </div>
              </div>
              <div>
                <label style={S.label}>Renewal date</label>
                <input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)}
                  style={{ ...S.input, colorScheme: 'dark' }} />
              </div>
            </div>
          )}

          <div style={{ height: 4 }} />
        </form>

        {/* Footer — outside the form, buttons use form= attribute */}
        <div style={S.footer}>
          <button type="button" onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button type="submit" form="tool-form-inner" disabled={loading}
            style={{ ...S.btnPrimary, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Saving…'
              : isEdit ? 'Save changes'
              : mode === 'api' ? 'Add & connect'
              : 'Add tool'}
          </button>
        </div>

      </div>
    </div>
  );
}

/* ─── LimitTile sub-component ────────────────────────────────────────────── */
function LimitTile({ label, main, sub }: { label: string; main: string; sub: string }) {
  return (
    <div style={{ padding: '10px 12px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: '#44495a', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#a8c890' }}>{main}</div>
      <div style={{ fontSize: 11, color: '#3d4555', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
