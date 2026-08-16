'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { storeUser } from '@/lib/auth';
import { api } from '@/lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';
const POLL_INTERVAL_MS = 3000;

function GoogleMark() {
  return (
    <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 12.5, fontWeight: 800, color: '#4285F4', letterSpacing: '-.02em', fontFamily: 'Arial,sans-serif' }}>G</span>
  );
}

function Spinner() {
  return <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid #5E6AD2', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />;
}

// Shown while completeGoogleSignIn() is polled after the callback found
// Postgres unreachable - deliberately has no error state of its own, since the
// whole point is that a transient DB gap during sign-in is invisible to the
// user, not surfaced as a failure. Only a genuinely expired/invalid pending
// token (a real, final error - see auth.service.ts) breaks out of this into
// the normal error banner below.
function FinishingSignIn({ token, onFatalError }: { token: string; onFatalError: (msg: string) => void }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${API_URL}/auth/google/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          onFatalError(body.message || 'Sign-in failed. Please try again.');
          return;
        }

        const data = await res.json();
        if (data.ready) {
          localStorage.setItem('spm_access_token', data.accessToken);
          localStorage.setItem('spm_refresh_token', data.refreshToken);
          try {
            const user = await api.get<any>('/users/me');
            storeUser(user);
          } catch { /* dashboard still loads without a cached user */ }
          router.replace('/dashboard');
          return;
        }
      } catch {
        // A network hiccup mid-poll isn't a fatal error either - just try again.
      }
      if (!cancelled) setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();
    return () => { cancelled = true; };
  }, [token, router, onFatalError]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '30px 0' }}>
      <Spinner />
      <div style={{ fontSize: 13.5, color: '#9aa0ab' }}>Finishing sign-in…</div>
      <div style={{ fontSize: 11.5, color: '#5e636e', textAlign: 'center', maxWidth: 300 }}>
        This can take a little longer than usual right after a period of inactivity. Hang tight - it'll complete automatically.
      </div>
    </div>
  );
}

function LoginCard() {
  const params = useSearchParams();
  const pendingToken = params.get('pending');
  const [fatalError, setFatalError] = useState<string | null>(params.get('error'));

  function handleGoogleSSO() {
    window.location.href = `${API_URL}/auth/google`;
  }

  if (pendingToken && !fatalError) {
    return (
      <div style={{ width: 440, maxWidth: 'calc(100vw - 32px)', background: '#0F1116', border: '1px solid #1E212A', borderRadius: 18, padding: '38px 40px', boxShadow: '0 24px 64px rgba(0,0,0,.5)' }}>
        <div style={{ marginBottom: 4 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#F2F3F5', letterSpacing: '-.02em', margin: '0 0 7px' }}>Welcome back</h1>
          <p style={{ fontSize: 13.5, color: '#767b86', margin: 0 }}>Sign in with your company Google account.</p>
        </div>
        <FinishingSignIn token={pendingToken} onFatalError={setFatalError} />
      </div>
    );
  }

  return (
    <div style={{ width: 440, maxWidth: 'calc(100vw - 32px)', background: '#0F1116', border: '1px solid #1E212A', borderRadius: 18, padding: '38px 40px', boxShadow: '0 24px 64px rgba(0,0,0,.5)' }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#F2F3F5', letterSpacing: '-.02em', margin: '0 0 7px' }}>Welcome back</h1>
        <p style={{ fontSize: 13.5, color: '#767b86', margin: 0 }}>Sign in with your company Google account.</p>
      </div>

      {fatalError && (
        <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 9, background: 'rgba(248,81,73,.1)', border: '1px solid rgba(248,81,73,.25)', fontSize: 13, color: '#F85149' }}>
          {fatalError === 'oauth_failed' ? 'Sign-in failed. Please try again.' : fatalError}
        </div>
      )}

      <button
        onClick={handleGoogleSSO}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, width: '100%', background: 'linear-gradient(140deg,#5E6AD2,#4a5bc8)', border: 'none', borderRadius: 11, padding: '14px 16px', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, color: '#fff', cursor: 'pointer', marginBottom: 28, boxShadow: '0 3px 16px rgba(94,106,210,.4)', transition: 'all .15s' }}
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div style={{ textAlign: 'center', fontSize: 12, color: '#5e636e', lineHeight: 1.5 }}>
        By continuing, you agree to your organization's access policy.<br />
        <span style={{ color: '#4a5169' }}>SSO configured for Life180 Labs</span>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0A0B0E', flexDirection: 'column', gap: 24 }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#5E6AD2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="6.5" width="3" height="8" rx="1.2" fill="#fff"/><rect x="6.5" y="2.5" width="3" height="12" rx="1.2" fill="#fff" opacity=".82"/><rect x="11.5" y="9" width="3" height="5.5" rx="1.2" fill="#fff" opacity=".64"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 680, color: '#F2F3F5', letterSpacing: '-.01em' }}>Spend Management</div>
          <div style={{ fontSize: 11, color: '#5E6AD2', fontWeight: 500 }}>Life180 Labs</div>
        </div>
      </div>

      <Suspense fallback={
        <div style={{ width: 440, maxWidth: 'calc(100vw - 32px)', background: '#0F1116', border: '1px solid #1E212A', borderRadius: 18, padding: '38px 40px' }}>
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid #5E6AD2', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
          </div>
        </div>
      }>
        <LoginCard />
      </Suspense>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
