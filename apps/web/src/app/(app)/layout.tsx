'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('spm_access_token');
    if (!token) router.replace('/login');
  }, [router]);

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--c-0d0f14)' }}>
      <Sidebar />
      <main className="flex-1 min-h-screen" style={{ marginLeft: 224, background: 'var(--c-080a0e)' }}>
        {children}
      </main>
    </div>
  );
}
