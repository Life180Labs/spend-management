'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface User {
  id: string; name: string; email: string; initials: string; isActive: boolean;
  memberships: { role: string; departmentId: string; isPrimary: boolean }[];
  toolCount?: number;
}

const ROLE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  ADMIN:   { bg: 'rgba(94,106,210,.14)',  color: 'var(--c-9aa2ef)',  label: 'Admin' },
  FINANCE: { bg: 'rgba(63,185,80,.13)',   color: 'var(--c-3fb950)',  label: 'Finance' },
  MANAGER: { bg: 'rgba(245,166,35,.13)',  color: 'var(--c-d99e3e)',  label: 'Manager' },
  MEMBER:  { bg: 'rgba(var(--fg-rgb),.06)', color: 'var(--c-9aa0ab)',  label: 'Member' },
  VIEWER:  { bg: 'rgba(var(--fg-rgb),.04)', color: 'var(--c-6b7280)',  label: 'Viewer' },
};

const AVATAR_BG = [
  '#1A73E8', '#10A37F', '#FF9900', '#7C3AED', '#5E6AD2',
  'var(--c-f85149)', 'var(--c-3fb950)', 'var(--c-f5a623)', '#0EA5E9', '#E0529C',
];

export default function TeamPage() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => { api.get<User[]>('/users').then(setUsers); }, []);

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 660, color: 'var(--c-f2f3f5)', letterSpacing: '-.02em', margin: '0 0 4px' }}>Team</h1>
        <p style={{ fontSize: 12, color: 'var(--c-767b86)', margin: 0 }}>People with access to this workspace.</p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--c-878c96)' }}>{users.length} members with workspace access</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {users.map((u, i) => {
          const primaryRole = u.memberships.find((m) => m.isPrimary)?.role || u.memberships[0]?.role || 'MEMBER';
          const roleStyle = ROLE_STYLE[primaryRole] || ROLE_STYLE.MEMBER;
          const avatarBg = AVATAR_BG[i % AVATAR_BG.length];

          return (
            <div key={u.id} style={{ background: 'var(--c-0e1014)', border: '1px solid var(--c-1a1d24)', borderRadius: 14, padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', background: avatarBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                {u.initials}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-f2f3f5)' }}>{u.name}</div>
                <div style={{ fontSize: 12, color: 'var(--c-878c96)' }}>{roleStyle.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--c-5e636e)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, background: roleStyle.bg, color: roleStyle.color }}>
                  {roleStyle.label}
                </span>
                <div style={{ fontSize: 11, color: 'var(--c-6b707b)', marginTop: 8 }}>
                  {u.toolCount ?? 0} tools
                </div>
              </div>
            </div>
          );
        })}
        {users.length === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: '32px 20px', textAlign: 'center', fontSize: 13, color: 'var(--c-5e636e)', background: 'var(--c-0e1014)', border: '1px solid var(--c-1a1d24)', borderRadius: 14 }}>
            No team members found
          </div>
        )}
      </div>
    </div>
  );
}
