'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/utils';

interface Tool {
  id: string; name: string; vendor: string; category: string;
  monoInitials: string; monoBgColor: string;
  barPct: number; alertThresholdPct: number; alert: boolean;
  paymentKind: string; triggerEmail: string | null;
  renewalDate: string | null; daysUntilRenewal: number | null;
}

const CAT_LABELS: Record<string, string> = {
  AI_LLM: 'AI / LLM', CLOUD_INFRA: 'Cloud Infra', COMMUNICATION: 'Communication',
  DEV_TOOLS: 'Dev Tools', DESIGN: 'Design', HOSTING: 'Hosting', MONITORING: 'Monitoring', OTHER: 'Other',
};

function renewColor(days: number | null) {
  if (days === null) return '#9aa0ab';
  if (days <= 3) return '#F85149';
  if (days <= 7) return '#F5A623';
  return '#cfd3da';
}

export default function AlertsPage() {
  const [tools, setTools] = useState<Tool[]>([]);

  useEffect(() => { api.get<Tool[]>('/tools').then(setTools); }, []);

  const thresholdBreaches = tools.filter((t) => t.alert);
  const noBudget = tools.filter((t) => t.paymentKind === 'NOBUDGET');
  const renewals = tools
    .filter((t) => t.renewalDate !== null)
    .sort((a, b) => (a.daysUntilRenewal ?? 999) - (b.daysUntilRenewal ?? 999));

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 900 }}>
      <div style={{ marginBottom: 4 }}>
        <h1 style={{ fontSize: 18, fontWeight: 660, color: '#F2F3F5', letterSpacing: '-.02em', margin: '0 0 4px' }}>Alerts</h1>
        <p style={{ fontSize: 12, color: '#767b86', margin: 0 }}>Threshold breaches, missing budgets and upcoming renewals.</p>
      </div>

      {/* Threshold Breaches */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#F85149', display: 'inline-block' }} />
          <h3 style={{ fontSize: 14, fontWeight: 650, color: '#E6E8EC', margin: 0 }}>Threshold Breaches</h3>
          <span style={{ fontSize: 11, color: '#6b707b' }}>{thresholdBreaches.length} active</span>
        </div>
        {thresholdBreaches.length === 0 ? (
          <div style={{ background: '#0E1014', border: '1px solid rgba(248,81,73,.12)', borderRadius: 13, padding: '18px 20px', fontSize: 13, color: '#5e636e' }}>No active threshold breaches</div>
        ) : thresholdBreaches.map((t) => (
          <Link key={t.id} href="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 14, background: 'linear-gradient(120deg,rgba(248,81,73,.07),#0E1014 70%)', border: '1px solid rgba(248,81,73,.28)', borderRadius: 13, padding: '15px 18px', cursor: 'pointer', marginBottom: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: t.monoBgColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 }}>{t.monoInitials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#F2F3F5' }}>{t.name}</div>
              <div style={{ fontSize: 12, color: '#c98a86', marginTop: 2 }}>At {t.barPct}% - breached {t.alertThresholdPct}% threshold</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: '#878c96' }}>Notifies</div>
              <div style={{ fontSize: 12, color: '#c2c6cf', fontWeight: 500 }}>{t.triggerEmail || '-'}</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#5e636e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M6 3.5L10.5 8L6 12.5" /></svg>
          </Link>
        ))}
      </div>

      {/* Missing Budgets */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#F5A623', display: 'inline-block' }} />
          <h3 style={{ fontSize: 14, fontWeight: 650, color: '#E6E8EC', margin: 0 }}>Missing Budgets</h3>
          <span style={{ fontSize: 11, color: '#6b707b' }}>{noBudget.length} tools</span>
        </div>
        {noBudget.length === 0 ? (
          <div style={{ background: '#0E1014', border: '1px solid rgba(245,166,35,.12)', borderRadius: 13, padding: '18px 20px', fontSize: 13, color: '#5e636e' }}>All tools have budgets configured</div>
        ) : noBudget.map((t) => (
          <Link key={t.id} href="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 14, background: '#0E1014', border: '1px solid rgba(245,166,35,.25)', borderRadius: 13, padding: '15px 18px', cursor: 'pointer', marginBottom: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: t.monoBgColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 }}>{t.monoInitials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#F2F3F5' }}>{t.name}</div>
              <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 2 }}>No budget configured - uncapped spend</div>
            </div>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#d99e3e', background: 'rgba(245,166,35,.1)', border: '1px solid rgba(245,166,35,.28)', padding: '5px 12px', borderRadius: 8, flexShrink: 0 }}>Set budget →</span>
          </Link>
        ))}
      </div>

      {/* Upcoming Renewals */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#5E6AD2', display: 'inline-block' }} />
          <h3 style={{ fontSize: 14, fontWeight: 650, color: '#E6E8EC', margin: 0 }}>Upcoming Renewals</h3>
        </div>
        <div style={{ background: '#0E1014', border: '1px solid #1A1D24', borderRadius: 13, overflow: 'hidden' }}>
          {renewals.length === 0 ? (
            <div style={{ padding: '18px 20px', fontSize: 13, color: '#5e636e' }}>No upcoming renewals</div>
          ) : renewals.map((t, i) => (
            <Link key={t.id} href="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderBottom: i < renewals.length - 1 ? '1px solid #15181E' : 'none', cursor: 'pointer' }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: t.monoBgColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{t.monoInitials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 550, color: '#E6E8EC' }}>{t.name}</div>
                <div style={{ fontSize: 11, color: '#6b707b' }}>{CAT_LABELS[t.category] || t.category}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: renewColor(t.daysUntilRenewal) }}>{t.renewalDate ? fmtDate(t.renewalDate) : '-'}</div>
                <div style={{ fontSize: 11, color: '#6b707b' }}>{t.daysUntilRenewal !== null ? `in ${t.daysUntilRenewal}d` : ''}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
