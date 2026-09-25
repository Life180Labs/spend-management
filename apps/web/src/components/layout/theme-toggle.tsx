'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [hover, setHover] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* private mode - theme just won't persist */ }
  }

  const isLight = theme === 'light';
  return (
    <button
      onClick={toggle}
      title={isLight ? 'Switch to night mode' : 'Switch to day mode'}
      aria-label={isLight ? 'Switch to night mode' : 'Switch to day mode'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Matches the sidebar nav items it sits under (sidebar.tsx) - same
      // padding, radius, font and hover background.
      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', marginBottom: 6, borderRadius: 9, fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', border: 'none', textAlign: 'left', background: hover ? 'var(--c-16181f)' : 'transparent', color: hover ? 'var(--c-e6e8ec)' : 'var(--c-9aa0ab)' }}
    >
      {isLight ? <Moon size={15} /> : <Sun size={15} />}
      {isLight ? 'Night mode' : 'Day mode'}
    </button>
  );
}
