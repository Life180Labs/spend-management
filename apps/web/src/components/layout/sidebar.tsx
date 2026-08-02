'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '@/lib/auth';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmt } from '@/lib/utils';

interface KPIMin { alertCount: number; totalMonthlySpend: number; toolCount: number; renewalCount: number; noBudgetCount: number; }

const NAV = [
  {
    label: 'Dashboard', href: '/dashboard',
    icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.6" fill="currentColor"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.6" fill="currentColor" opacity=".5"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.6" fill="currentColor" opacity=".5"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.6" fill="currentColor"/></svg>,
  },
  {
    label: 'Alerts', href: '/alerts',
    icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2.5c-2 0-3.2 1.4-3.2 3.3 0 2.5-1 3.5-1.4 3.9-.1.2.1.4.4.4h8.4c.3 0 .5-.2.4-.4-.4-.4-1.4-1.4-1.4-3.9C11.2 3.9 10 2.5 8 2.5Z" strokeLinejoin="round"/><path d="M6.7 12.2a1.4 1.4 0 0 0 2.6 0" strokeLinecap="round"/></svg>,
  },
  {
    label: 'Usage History', href: '/usage-history',
    icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8.5" r="6"/><path d="M8 5.2v3.3l2.2 1.3"/><path d="M5.5 1.2h5"/></svg>,
  },
  {
    label: 'Reports', href: '/reports',
    icon: <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="1.5" width="12" height="13" rx="1.4"/><path d="M5 5.5h6M5 8h6M5 10.5h4"/></svg>,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [kpis, setKpis] = useState<KPIMin | null>(null);
  const [userMenu, setUserMenu] = useState(false);
  const [user, setUser] = useState<{ name: string; email: string; initials: string } | null>(null);
  const [currency, setCurrency] = useState<'INR' | 'USD'>('USD');
  const [fxRate, setFxRate] = useState(94.4);

  useEffect(() => {
    const saved = localStorage.getItem('spend_currency') as 'INR' | 'USD' | null;
    if (saved) setCurrency(saved);
    fetch('https://api.frankfurter.app/latest?from=USD&to=INR')
      .then((r) => r.json())
      .then((d: any) => { if (d?.rates?.INR) setFxRate(d.rates.INR); })
      .catch(() => {});

    const onCurrencyChange = (e: Event) => {
      setCurrency((e as CustomEvent<'INR' | 'USD'>).detail);
    };
    window.addEventListener('spend_currency_change', onCurrencyChange);
    return () => window.removeEventListener('spend_currency_change', onCurrencyChange);
  }, []);

  useEffect(() => {
    function loadKpis() {
      api.get<KPIMin>('/reports/dashboard-kpis').then(setKpis).catch(() => {});
    }
    loadKpis();
    api.get<{ name: string; email: string; initials: string }>('/users/me').then(setUser).catch(() => {});

    const interval = setInterval(loadKpis, 30_000);
    window.addEventListener('spend_data_changed', loadKpis);
    return () => {
      clearInterval(interval);
      window.removeEventListener('spend_data_changed', loadKpis);
    };
  }, []);

  const budgetPct = kpis ? Math.min(100, Math.round((kpis.totalMonthlySpend / 175000) * 100)) : 71;

  const fmtSpend = (amount: number) => {
    if (currency === 'USD') {
      return `$${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    }
    return `₹${(amount * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  };

  return (
    <aside style={{ position: 'fixed', left: 0, top: 0, height: '100%', width: 224, display: 'flex', flexDirection: 'column', background: '#0D0F14', borderRight: '1px solid rgba(255,255,255,0.05)', zIndex: 40 }}>

      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '22px 16px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#5E6AD2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="6.5" width="3" height="8" rx="1.2" fill="#fff"/><rect x="6.5" y="2.5" width="3" height="12" rx="1.2" fill="#fff" opacity=".82"/><rect x="11.5" y="9" width="3" height="5.5" rx="1.2" fill="#fff" opacity=".64"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.01em' }}>Spend Management</div>
          <div style={{ fontSize: 11, color: '#5E6AD2', fontWeight: 500 }}>Life180 Labs</div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
        {NAV.map(({ label, href, icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link key={href} href={href}
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', borderRadius: 9, fontSize: 13, fontWeight: active ? 550 : 500, cursor: 'pointer', textDecoration: 'none', background: active ? '#16181F' : 'transparent', color: active ? '#E6E8EC' : '#9aa0ab', boxShadow: active ? 'inset 2px 0 0 #5E6AD2' : 'none' }}
            >
              <span style={{ display: 'flex', color: active ? '#9aa2ef' : 'currentColor' }}>{icon}</span>
              {label}
              {(() => {
                if (label !== 'Alerts' || !kpis) return null;
                // Matches the 3 sections the Alerts page itself surfaces: threshold
                // breaches, missing budgets, and upcoming renewals (within the same
                // 5-day lookahead dashboardKpis already uses) - not just breaches.
                const attentionCount = kpis.alertCount + kpis.renewalCount + kpis.noBudgetCount;
                if (attentionCount === 0) return null;
                return (
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 650, color: '#F85149', background: 'rgba(248,81,73,.13)', padding: '1px 7px', borderRadius: 20 }}>{attentionCount}</span>
                );
              })()}
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div style={{ padding: '0 8px 10px', marginTop: 'auto' }}>
        <div style={{ height: 1, background: '#1A1D24', margin: '0 4px 6px' }} />

        {/* User row */}
        <div
          onClick={() => setUserMenu(!userMenu)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 9, cursor: 'pointer', position: 'relative' }}
        >
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(140deg,#5E6AD2,#8B5CF6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
            {user?.initials || 'U'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#c2c6cf', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name || 'User'}</div>
            <div style={{ fontSize: 10.5, color: '#5e636e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email || ''}</div>
          </div>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#5e636e" strokeWidth="1.5" strokeLinecap="round"><path d="M4 6l4 4 4-4"/></svg>
        </div>

        {/* User menu */}
        {userMenu && (
          <div style={{ background: '#14161D', border: '1px solid #232730', borderRadius: 12, marginTop: 6, overflow: 'hidden', boxShadow: '0 -12px 40px rgba(0,0,0,.5)' }}>
            <div style={{ padding: 6 }}>
              <Link href="/settings" onClick={() => setUserMenu(false)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 8, fontSize: 13, color: '#c2c6cf', cursor: 'pointer', textDecoration: 'none' }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" strokeLinecap="round"/></svg>
                Settings
              </Link>
              <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '3px 0' }} />
              <button onClick={() => { logout(); setUserMenu(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 13, color: '#F85149', cursor: 'pointer', background: 'none', border: 'none', fontFamily: 'inherit' }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/><path d="M11 11l3-3-3-3"/><line x1="14" y1="8" x2="6" y2="8"/></svg>
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
