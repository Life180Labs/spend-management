import { HeyGenProvider } from './heygen.provider';

function mockFetchOk(remainingBalance: number) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { wallet: { currency: 'usd', remaining_balance: remainingBalance } } }),
  });
}

describe('HeyGenProvider', () => {
  let provider: HeyGenProvider;

  beforeEach(() => {
    provider = new HeyGenProvider();
    jest.restoreAllMocks();
  });

  it('throws if apiKey is missing, before ever calling fetch', async () => {
    const fetchSpy = jest.fn();
    (global as any).fetch = fetchSpy;
    await expect(provider.fetchSpendUSD({})).rejects.toThrow('HeyGen config missing apiKey');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('first sync ever (no stored baseline): spend starts at 0, providerState is populated', async () => {
    mockFetchOk(42.5);
    const result = await provider.fetchSpendUSD({ apiKey: 'key1' });

    expect(result.amountUSD).toBe(0);
    expect(result.remainingBalanceUSD).toBe(42.5);
    expect(result.providerState).toEqual({
      heygenLastBalance: 42.5,
      heygenPeriodSpend: 0,
      heygenPeriodMonthKey: new Date().toISOString().slice(0, 7),
    });
  });

  it('a pure spend delta (balance drops) increases the accumulator by exactly the drop', async () => {
    const currentMonthKey = new Date().toISOString().slice(0, 7);
    mockFetchOk(35); // was 50, now 35 -> $15 spent
    const result = await provider.fetchSpendUSD({
      apiKey: 'key1',
      heygenLastBalance: 50,
      heygenPeriodSpend: 10, // already $10 accumulated earlier this month
      heygenPeriodMonthKey: currentMonthKey,
    });

    expect(result.amountUSD).toBe(25); // 10 + 15
    expect(result.remainingBalanceUSD).toBe(35);
    expect(result.providerState).toEqual({
      heygenLastBalance: 35,
      heygenPeriodSpend: 25,
      heygenPeriodMonthKey: currentMonthKey,
    });
  });

  it('a top-up (balance rises) does NOT reduce the accumulator, but still updates the baseline balance', async () => {
    const currentMonthKey = new Date().toISOString().slice(0, 7);
    mockFetchOk(100); // was 10, topped up to 100
    const result = await provider.fetchSpendUSD({
      apiKey: 'key1',
      heygenLastBalance: 10,
      heygenPeriodSpend: 40,
      heygenPeriodMonthKey: currentMonthKey,
    });

    expect(result.amountUSD).toBe(40); // unchanged - the rise is a top-up, not spend
    expect(result.remainingBalanceUSD).toBe(100);
    expect(result.providerState).toEqual({
      heygenLastBalance: 100, // new baseline for the NEXT delta calc
      heygenPeriodSpend: 40,
      heygenPeriodMonthKey: currentMonthKey,
    });
  });

  it('an unchanged balance leaves the accumulator exactly as-is', async () => {
    const currentMonthKey = new Date().toISOString().slice(0, 7);
    mockFetchOk(20);
    const result = await provider.fetchSpendUSD({
      apiKey: 'key1',
      heygenLastBalance: 20,
      heygenPeriodSpend: 5,
      heygenPeriodMonthKey: currentMonthKey,
    });

    expect(result.amountUSD).toBe(5);
    expect(result.remainingBalanceUSD).toBe(20);
  });

  it('a new calendar month resets the accumulator to 0, even with a stored balance from last month', async () => {
    mockFetchOk(80);
    const result = await provider.fetchSpendUSD({
      apiKey: 'key1',
      heygenLastBalance: 90,
      heygenPeriodSpend: 55, // last month's total - no longer applies
      heygenPeriodMonthKey: '2020-01', // clearly a past month
    });

    expect(result.amountUSD).toBe(0);
    expect(result.remainingBalanceUSD).toBe(80);
    expect(result.providerState).toEqual({
      heygenLastBalance: 80,
      heygenPeriodSpend: 0,
      heygenPeriodMonthKey: new Date().toISOString().slice(0, 7),
    });
  });

  it('a malformed response (missing wallet.remaining_balance) throws instead of reporting $0 spend', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { wallet: {} } }),
    });
    await expect(provider.fetchSpendUSD({ apiKey: 'key1' })).rejects.toThrow(/remaining_balance/);
  });

  it('a non-ok HTTP response throws with the API-provided error message', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid API key' }),
    });
    await expect(provider.fetchSpendUSD({ apiKey: 'bad-key' })).rejects.toThrow('Invalid API key');
  });

  it('has no fetchLimitsUSD or fetchHistoricalSpendUSD - HeyGen exposes neither via API', () => {
    expect((provider as any).fetchLimitsUSD).toBeUndefined();
    expect((provider as any).fetchHistoricalSpendUSD).toBeUndefined();
  });
});
