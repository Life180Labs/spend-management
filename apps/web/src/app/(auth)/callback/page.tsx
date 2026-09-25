'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { storeUser } from '@/lib/auth';
import { api } from '@/lib/api';

function Spinner() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-0a0b0e)', flexDirection: 'column', gap: 16 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: '#5E6AD2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="6.5" width="3" height="8" rx="1.2" fill="#fff"/><rect x="6.5" y="2.5" width="3" height="12" rx="1.2" fill="#fff" opacity=".82"/><rect x="11.5" y="9" width="3" height="5.5" rx="1.2" fill="#fff" opacity=".64"/></svg>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid #5E6AD2', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
        <span style={{ fontSize: 13, color: 'var(--c-878c96)' }}>Signing you in…</span>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function CallbackHandler() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken');

    if (!accessToken || !refreshToken) {
      router.replace('/login?error=oauth_failed');
      return;
    }

    localStorage.setItem('spm_access_token', accessToken);
    localStorage.setItem('spm_refresh_token', refreshToken);

    api.get<any>('/users/me')
      .then((user) => { storeUser(user); router.replace('/dashboard'); })
      .catch(() => { router.replace('/dashboard'); });
  }, [params, router]);

  return <Spinner />;
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CallbackHandler />
    </Suspense>
  );
}
