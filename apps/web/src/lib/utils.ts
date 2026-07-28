import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmt(n: number, currency = '$'): string {
  const locale = currency === '₹' ? 'en-IN' : 'en-US';
  return `${currency}${Number(n).toLocaleString(locale, { maximumFractionDigits: 2 })}`;
}

export function fmtDate(d: string | Date): string {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function initials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

export const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9aa0ab',
  SUBMITTED: '#0EA5E9',
  PENDING_APPROVAL: '#F5A623',
  APPROVED: '#3FB950',
  REJECTED: '#F85149',
  MORE_INFO_NEEDED: '#E0529C',
  CANCELLED: '#6B7280',
  CLOSED: '#3FB950',
  PENDING: '#F5A623',
  PAID: '#3FB950',
};
