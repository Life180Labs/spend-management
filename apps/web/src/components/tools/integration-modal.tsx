'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Loader2, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface Integration {
  id: string;
  toolId: string;
  provider: string;
  config: Record<string, any>;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncAmountUSD: number | null;
  lastError: string | null;
  syncEveryMinutes: number;
}

interface RailwayLimits {
  computeHardLimitUSD: number;
  computeSoftLimitUSD: number;
  alertThresholdPct: number;
}

interface Props {
  toolId: string;
  toolName: string;
  onClose: () => void;
  onSynced: () => void;
}

const PROVIDERS = [{ value: 'RAILWAY', label: 'Railway' }];

export function IntegrationModal({ toolId, toolName, onClose, onSynced }: Props) {
  const [integration, setIntegration] = useState<Integration | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [formError, setFormError] = useState('');
  const [provider, setProvider] = useState('RAILWAY');
  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [appliedLimits, setAppliedLimits] = useState<RailwayLimits | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchIntegration() {
    try {
      const data = await api.get<Integration | null>(`/integrations/${toolId}`);
      setIntegration(data);
      if (data) setProvider(data.provider);
    } catch {
      setIntegration(null);
    }
  }

  useEffect(() => {
    fetchIntegration();
    intervalRef.current = setInterval(fetchIntegration, 15_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [toolId]);

  async function handleSave() {
    if (!apiToken.trim()) { setFormError('API token is required'); return; }
    setFormError(''); setSaving(true);
    try {
      await api.put(`/integrations/${toolId}`, { provider, config: { apiToken: apiToken.trim() } });
      setApiToken('');

      // Fetch usage limits from the provider and auto-apply to the tool
      if (provider === 'RAILWAY') {
        try {
          const limits = await api.get<RailwayLimits | null>(`/integrations/${toolId}/limits`);
          if (limits) {
            await api.patch(`/tools/${toolId}`, {
              capAmount: limits.computeHardLimitUSD,
              alertThresholdPct: limits.alertThresholdPct,
            });
            setAppliedLimits(limits);
          }
        } catch {
          // Limits fetch is best-effort - don't fail the whole connect flow
        }
      }

      await fetchIntegration();
      onSynced();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncNow() {
    setSyncing(true); setFormError('');
    try {
      await api.post(`/integrations/${toolId}/sync`);
      await fetchIntegration();
      onSynced();
    } catch (err: any) {
      setFormError(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    setRemoving(true); setFormError('');
    try {
      await api.delete(`/integrations/${toolId}`);
      setIntegration(null);
      setApiToken('');
      onSynced();
    } catch (err: any) {
      setFormError(err.message || 'Failed to disconnect');
    } finally {
      setRemoving(false);
    }
  }

  function friendlyError(raw: string): string {
    if (/failed for every measurement this cycle/i.test(raw)) {
      return "Railway is temporarily rate-limiting our requests - this will resolve itself on the next sync.";
    }
    if (/does not have permission to read projects or billing data/i.test(raw)) {
      return "This API token can't read usage data. Use a personal API token from railway.com → Account Settings → API Tokens.";
    }
    if (/rate limit/i.test(raw)) {
      return "Railway is rate-limiting our requests - this will resolve itself on the next sync.";
    }
    return raw;
  }

  function fmtSyncTime(iso: string) {
    const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  const loading = integration === undefined;
  const isConnected = !!integration;
  const S: React.CSSProperties = { background: '#1B1E26', border: '1px solid rgba(255,255,255,0.08)', color: '#F0F0F0', outline: 'none' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.65)' }}>
      <div style={{ width: '100%', maxWidth: 440, borderRadius: 20, padding: 24, background: '#13161D', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 64px rgba(0,0,0,.6)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(94,106,210,.14)', color: '#9aa2ef' }}>
              <PlugIcon />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 650, color: '#F0F0F0' }}>Configure Integration</div>
              <div style={{ fontSize: 11.5, color: '#6b707b' }}>{toolName}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b707b', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
            <Loader2 size={20} color="#5E6AD2" className="animate-spin" />
          </div>
        ) : (
          <>
            {/* Status banner */}
            {isConnected ? (
              <div style={{ borderRadius: 12, padding: '12px 14px', background: 'rgba(63,185,80,.07)', border: '1px solid rgba(63,185,80,.22)', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <CheckCircle2 size={13} color="#3FB950" />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3FB950' }}>
                      Connected · {PROVIDERS.find((p) => p.value === integration.provider)?.label}
                    </span>
                  </div>
                  {integration.lastSyncAt && (
                    <span style={{ fontSize: 11, color: '#4a7a4a' }}>Synced {fmtSyncTime(integration.lastSyncAt)}</span>
                  )}
                </div>
                {integration.lastSyncAmountUSD != null && (
                  <div style={{ marginTop: 5, fontSize: 12, color: '#5d9a5d' }}>
                    Last fetched: <span style={{ fontWeight: 650, color: '#8fcf8f' }}>${Number(integration.lastSyncAmountUSD).toLocaleString('en-US')}</span>
                  </div>
                )}
                {integration.lastError && (
                  <div
                    style={{ marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, color: '#F85149' }}
                    title={integration.lastError}
                  >
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>{friendlyError(integration.lastError)}</span>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ borderRadius: 12, padding: '10px 14px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)', marginBottom: 16, fontSize: 12, color: '#6b707b' }}>
                Not connected. Enter your API credentials below to start syncing spend data automatically.
              </div>
            )}

            {/* Auto-applied limits banner */}
            {appliedLimits && (
              <div style={{ borderRadius: 12, padding: '12px 14px', background: 'rgba(94,106,210,.08)', border: '1px solid rgba(94,106,210,.28)', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#9aa2ef" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L6 9l-3-3" /></svg>
                  <span style={{ fontSize: 12, fontWeight: 650, color: '#9aa2ef' }}>Budget synced from Railway</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                  <LimitRow label="Budget cap" usd={appliedLimits.computeHardLimitUSD} />
                  <LimitRow label="Alert threshold" usd={appliedLimits.computeSoftLimitUSD} pct={appliedLimits.alertThresholdPct} />
                </div>
                <div style={{ marginTop: 8, fontSize: 10.5, color: '#5e6480' }}>
                  Based on your Railway compute hard limit
                </div>
              </div>
            )}

            {/* Form error */}
            {formError && (
              <div style={{ borderRadius: 10, padding: '9px 13px', background: 'rgba(248,81,73,.1)', border: '1px solid rgba(248,81,73,.28)', fontSize: 12, color: '#F85149', marginBottom: 14 }}>
                {formError}
              </div>
            )}

            {/* Provider */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={{ ...S, width: '100%', padding: '9px 12px', borderRadius: 10, fontSize: 13 }}
              >
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>

            {/* API Token */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                API Token
                {isConnected && <span style={{ color: '#4a4f59', marginLeft: 6 }}>(re-enter to update)</span>}
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showToken ? 'text' : 'password'}
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                  placeholder={isConnected ? 'Enter new token to update' : 'Paste your Railway API token'}
                  style={{ ...S, width: '100%', padding: '9px 40px 9px 12px', borderRadius: 10, fontSize: 13, boxSizing: 'border-box' }}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#5e636e', cursor: 'pointer', padding: 2 }}
                >
                  {showToken ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              {provider === 'RAILWAY' && (
                <p style={{ fontSize: 11, color: '#4a4f59', marginTop: 6 }}>
                  railway.com → Account Settings → API Tokens
                </p>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isConnected && (
                <button
                  onClick={handleSyncNow}
                  disabled={syncing}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, background: 'rgba(94,106,210,.12)', border: '1px solid rgba(94,106,210,.22)', color: '#9aa2ef', fontSize: 12.5, fontWeight: 550, cursor: syncing ? 'not-allowed' : 'pointer', opacity: syncing ? 0.7 : 1, flexShrink: 0 }}
                >
                  {syncing
                    ? <Loader2 size={13} className="animate-spin" />
                    : <RefreshCw size={13} />}
                  Sync now
                </button>
              )}

              <div style={{ flex: 1 }} />

              {isConnected && (
                <button
                  onClick={handleDisconnect}
                  disabled={removing}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, background: 'rgba(248,81,73,.08)', border: '1px solid rgba(248,81,73,.18)', color: '#F85149', fontSize: 12.5, fontWeight: 550, cursor: removing ? 'not-allowed' : 'pointer', opacity: removing ? 0.7 : 1, flexShrink: 0 }}
                >
                  {removing ? <Loader2 size={13} className="animate-spin" /> : <UnplugIcon />}
                  Disconnect
                </button>
              )}

              <button
                onClick={handleSave}
                disabled={saving || !apiToken.trim()}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 10, background: '#5E6AD2', border: 'none', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: (saving || !apiToken.trim()) ? 'not-allowed' : 'pointer', opacity: (saving || !apiToken.trim()) ? 0.5 : 1, flexShrink: 0 }}
              >
                {saving && <Loader2 size={13} className="animate-spin" />}
                {isConnected ? 'Update' : 'Connect'}
              </button>
            </div>

            {isConnected && (
              <div style={{ marginTop: 14, fontSize: 11, color: '#3a3f4a', textAlign: 'center' }}>
                Auto-syncs every {integration.syncEveryMinutes} min · data flows directly into the spend bar
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LimitRow({ label, usd, pct }: { label: string; usd: number; pct?: number }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: '#5e6480', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 650, color: '#c2c6cf' }}>
        ${usd.toLocaleString('en-US')}
        {pct !== undefined && <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9aa2ef', marginLeft: 6 }}>at {pct}%</span>}
      </div>
    </div>
  );
}

function PlugIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 1v3M10 1v3" /><rect x="3" y="4" width="10" height="5" rx="2" />
      <path d="M8 9v3" /><path d="M6 12h4" />
    </svg>
  );
}

function UnplugIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 1v3M10.5 1v3" /><path d="M3 4h10v4a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V4Z" />
      <path d="M8 12v3" /><path d="M2 2l12 12" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" /><circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 13.5 2.5 2.5" /><path d="M6.4 6.5A2 2 0 0 0 9.5 9.6" />
      <path d="M4 4.6C2.3 5.7 1 8 1 8s2.5 5 7 5c1.4 0 2.7-.4 3.8-1.1" />
      <path d="M13 11.5C14.3 10.3 15 8 15 8s-2.5-5-7-5c-.6 0-1.2.1-1.8.2" />
    </svg>
  );
}
