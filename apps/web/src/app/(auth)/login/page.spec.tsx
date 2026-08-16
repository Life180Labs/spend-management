import { render, screen, waitFor } from '@testing-library/react';
import LoginPage from './page';

const mockReplace = jest.fn();
let mockSearchParams: URLSearchParams;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/api', () => ({
  api: { get: jest.fn() },
}));

jest.mock('@/lib/auth', () => ({
  storeUser: jest.fn(),
}));

import { api } from '@/lib/api';

describe('LoginPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockSearchParams = new URLSearchParams();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the normal "Continue with Google" button when there is no pending/error param', () => {
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
    expect(screen.queryByText('Finishing sign-in…')).not.toBeInTheDocument();
  });

  it('shows an error banner (not the pending state) when only an error param is present', () => {
    mockSearchParams = new URLSearchParams({ error: 'Something went wrong' });
    render(<LoginPage />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
  });

  it('shows "Finishing sign-in…" (never an error) when a pending token is present, and polls the complete endpoint', async () => {
    mockSearchParams = new URLSearchParams({ pending: 'pending-token-abc' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ready: false }),
    });

    render(<LoginPage />);

    expect(screen.getByText('Finishing sign-in…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with Google/i })).not.toBeInTheDocument();

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/google/complete'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'pending-token-abc' }),
      }),
    ));
    // Still showing the friendly waiting state - not redirected, not an error.
    expect(screen.getByText('Finishing sign-in…')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('keeps polling every 3s while the server returns { ready: false }, without ever showing an error', async () => {
    jest.useFakeTimers({ legacyFakeTimers: false });
    mockSearchParams = new URLSearchParams({ pending: 'pending-token-abc' });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ready: false }) });

    render(<LoginPage />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    await jest.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    await jest.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));

    expect(screen.getByText('Finishing sign-in…')).toBeInTheDocument();
  });

  it('stores tokens and redirects to /dashboard once the server returns { ready: true }', async () => {
    mockSearchParams = new URLSearchParams({ pending: 'pending-token-abc' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true, accessToken: 'at-123', refreshToken: 'rt-456' }),
    });
    (api.get as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A', initials: 'A', orgId: 'org1' });

    render(<LoginPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
    expect(localStorage.getItem('spm_access_token')).toBe('at-123');
    expect(localStorage.getItem('spm_refresh_token')).toBe('rt-456');
  });

  it('still redirects to /dashboard even if fetching /users/me fails after a successful sign-in', async () => {
    mockSearchParams = new URLSearchParams({ pending: 'pending-token-abc' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true, accessToken: 'at-123', refreshToken: 'rt-456' }),
    });
    (api.get as jest.Mock).mockRejectedValue(new Error('network blip'));

    render(<LoginPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
  });

  it('breaks out of the pending state into a real error banner only for a genuinely fatal response (e.g. expired token)', async () => {
    mockSearchParams = new URLSearchParams({ pending: 'expired-token' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ message: 'This sign-in attempt has expired - please try signing in again.' }),
    });

    render(<LoginPage />);

    await waitFor(() => expect(screen.getByText('This sign-in attempt has expired - please try signing in again.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('treats a network error while polling as transient, not fatal - keeps waiting rather than showing an error', async () => {
    mockSearchParams = new URLSearchParams({ pending: 'pending-token-abc' });
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Failed to fetch'));

    render(<LoginPage />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Finishing sign-in…')).toBeInTheDocument();
  });
});
