'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Loader2 } from 'lucide-react';

interface User { id: string; name: string; email: string; initials: string; }

export default function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [toast, setToast] = useState('');
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState({ thresholds: true, renewals: true, missing: true });

  useEffect(() => { api.get<User>('/users/me').then((u) => { setUser(u); setName(u.name); }); }, []);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2600); }

  async function saveName() {
    setSaving(true);
    try { await api.patch('/users/me', { name }); showToast('Profile saved'); }
    catch { showToast('Failed to save'); }
    finally { setSaving(false); }
  }

  if (!user) return <div style={{ padding: 24, fontSize: 13, color: 'var(--c-9aa0ab)' }}>Loading…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ marginBottom: 4 }}>
        <h1 style={{ fontSize: 18, fontWeight: 660, color: 'var(--c-f2f3f5)', letterSpacing: '-.02em', margin: '0 0 4px' }}>Settings</h1>
        <p style={{ fontSize: 12, color: 'var(--c-767b86)', margin: 0 }}>Manage your profile and workspace preferences.</p>
      </div>

      {/* Profile card */}
      <div style={{ background: 'var(--c-0e1014)', border: '1px solid var(--c-1a1d24)', borderRadius: 14, padding: '22px 24px' }}>
        <h3 style={{ fontSize: 13, fontWeight: 650, color: 'var(--c-e6e8ec)', margin: '0 0 18px' }}>Profile</h3>

        {/* Avatar + info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <div style={{ width: 58, height: 58, borderRadius: '50%', background: 'linear-gradient(140deg,#5E6AD2,#8B5CF6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: '#fff', flexShrink: 0, boxShadow: '0 2px 12px rgba(94,106,210,.4)' }}>
            {user.initials}
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 650, color: 'var(--c-f2f3f5)' }}>{user.name}</div>
            <div style={{ fontSize: 13, color: 'var(--c-878c96)' }}>{user.email}</div>
            <span style={{ display: 'inline-flex', marginTop: 6, fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20, background: 'rgba(94,106,210,.14)', color: 'var(--c-9aa2ef)' }}>Admin · Owner</span>
          </div>
        </div>

        {/* Form */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--c-9aa0ab)', marginBottom: 7 }}>Display name</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', background: 'var(--c-121419)', border: '1.5px solid var(--c-1e212a)', borderRadius: 9, padding: '10px 13px', fontFamily: 'inherit', fontSize: 13.5, color: 'var(--c-e6e8ec)', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--c-9aa0ab)', marginBottom: 7 }}>Email address</label>
            <input
              type="email" value={user.email} disabled
              style={{ width: '100%', background: 'var(--c-121419)', border: '1.5px solid var(--c-1e212a)', borderRadius: 9, padding: '10px 13px', fontFamily: 'inherit', fontSize: 13.5, color: 'var(--c-5e636e)', outline: 'none', boxSizing: 'border-box', cursor: 'not-allowed' }}
            />
          </div>
        </div>

        <button
          onClick={saveName} disabled={saving}
          style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 9, background: '#5E6AD2', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.75 : 1, fontFamily: 'inherit' }}
        >
          {saving && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
          Save changes
        </button>
      </div>

      {/* Notification preferences card */}
      <div style={{ background: 'var(--c-0e1014)', border: '1px solid var(--c-1a1d24)', borderRadius: 14, padding: '22px 24px' }}>
        <h3 style={{ fontSize: 13, fontWeight: 650, color: 'var(--c-e6e8ec)', margin: '0 0 14px' }}>Alert Preferences</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {([
            { key: 'thresholds', label: 'Threshold breaches', sub: 'Email when a tool exceeds its alert threshold' },
            { key: 'renewals', label: 'Upcoming renewals', sub: 'Email 7 days before a subscription renews' },
            { key: 'missing', label: 'Missing budgets', sub: 'Weekly digest of tools without budget caps' },
          ] as const).map(({ key, label, sub }) => {
            const on = prefs[key];
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 550, color: 'var(--c-c2c6cf)' }}>{label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--c-6b707b)', marginTop: 2 }}>{sub}</div>
                </div>
                <button
                  role="switch"
                  aria-checked={on}
                  onClick={() => { setPrefs((p) => ({ ...p, [key]: !p[key] })); showToast(`${label} ${on ? 'disabled' : 'enabled'}`); }}
                  style={{ width: 36, height: 20, borderRadius: 999, background: on ? '#5E6AD2' : 'var(--c-2a2e38)', border: 'none', padding: 0, position: 'relative', cursor: 'pointer', flexShrink: 0, transition: 'background .15s' }}
                >
                  <span style={{ position: 'absolute', top: 3, left: on ? 19 : 3, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', padding: '8px 16px', borderRadius: 10, background: 'var(--c-1b1e26)', border: '1px solid rgba(var(--fg-rgb),0.1)', color: 'var(--c-f0f0f0)', fontSize: 13, fontWeight: 500, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60 }}>
          {toast}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
