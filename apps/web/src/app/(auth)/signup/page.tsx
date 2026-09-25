'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signup, storeUser } from '@/lib/auth';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', orgName: '', password: '', confirm: '' });
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) { setError('Passwords do not match'); return; }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setError(''); setLoading(true);
    try {
      const user = await signup(form.name, form.email, form.password, form.orgName);
      storeUser(user);
      router.replace('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--c-0d0f14)' }}>
      <div
        className="w-full max-w-sm rounded-2xl p-8"
        style={{ background: 'var(--c-13161d)', border: '1px solid rgba(var(--fg-rgb),0.07)' }}
      >
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold" style={{ background: '#5E6AD2' }}>SM</div>
          <span className="font-semibold text-[var(--c-f0f0f0)]">Spend Management</span>
        </div>

        <h1 className="text-xl font-semibold text-[var(--c-f0f0f0)] mb-1">Create account</h1>
        <p className="text-sm text-[var(--c-9aa0ab)] mb-6">Set up your workspace in seconds</p>

        {error && (
          <div className="mb-4 p-3 rounded-lg text-sm text-[var(--c-f85149)]" style={{ background: 'rgba(248,81,73,0.1)' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {[
            { label: 'Full name', key: 'name', type: 'text', placeholder: 'Jane Smith' },
            { label: 'Work email', key: 'email', type: 'email', placeholder: 'jane@company.com' },
            { label: 'Company name', key: 'orgName', type: 'text', placeholder: 'Acme Corp (optional)' },
          ].map(({ label, key, type, placeholder }) => (
            <div key={key}>
              <label className="block text-xs text-[var(--c-9aa0ab)] mb-1.5 font-medium">{label}</label>
              <input
                type={type}
                value={form[key as keyof typeof form]}
                onChange={set(key as keyof typeof form)}
                className="w-full px-3 py-2.5 text-sm rounded-lg"
                style={{ background: 'var(--c-1b1e26)', border: '1px solid rgba(var(--fg-rgb),0.08)', color: 'var(--c-f0f0f0)' }}
                placeholder={placeholder}
                required={key !== 'orgName'}
              />
            </div>
          ))}

          <div>
            <label className="block text-xs text-[var(--c-9aa0ab)] mb-1.5 font-medium">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={form.password}
                onChange={set('password')}
                className="w-full px-3 py-2.5 text-sm rounded-lg pr-10"
                style={{ background: 'var(--c-1b1e26)', border: '1px solid rgba(var(--fg-rgb),0.08)', color: 'var(--c-f0f0f0)' }}
                placeholder="Min 8 characters"
                required
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--c-9aa0ab)]">
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-[var(--c-9aa0ab)] mb-1.5 font-medium">Confirm password</label>
            <input
              type="password"
              value={form.confirm}
              onChange={set('confirm')}
              className="w-full px-3 py-2.5 text-sm rounded-lg"
              style={{ background: 'var(--c-1b1e26)', border: '1px solid rgba(var(--fg-rgb),0.08)', color: 'var(--c-f0f0f0)' }}
              placeholder="Repeat password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
            style={{ background: '#5E6AD2', color: '#fff', opacity: loading ? 0.7 : 1 }}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Creating workspace…' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-xs text-[var(--c-9aa0ab)] mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-[var(--c-9aa2ef)] hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
