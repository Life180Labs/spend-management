import type { Metadata } from 'next';
import './globals.css';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Spend Management',
  description: 'Internal SaaS & API Spend Management Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
