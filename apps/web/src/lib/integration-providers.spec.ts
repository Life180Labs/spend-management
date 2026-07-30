import { INTEGRATION_PROVIDERS, matchProviderByVendor } from './integration-providers';

describe('matchProviderByVendor', () => {
  it('returns undefined for an empty/null/undefined vendor', () => {
    expect(matchProviderByVendor(undefined)).toBeUndefined();
    expect(matchProviderByVendor(null)).toBeUndefined();
    expect(matchProviderByVendor('')).toBeUndefined();
    expect(matchProviderByVendor('   ')).toBeUndefined();
  });

  it('matches an exact vendor name case-insensitively', () => {
    expect(matchProviderByVendor('anthropic')).toBe(INTEGRATION_PROVIDERS.find((p) => p.value === 'CLAUDE'));
    expect(matchProviderByVendor('ANTHROPIC')).toBe(INTEGRATION_PROVIDERS.find((p) => p.value === 'CLAUDE'));
  });

  it('matches "Railway.com" to the Railway provider via substring tolerance (the drift bug this function fixed)', () => {
    const result = matchProviderByVendor('Railway.com');
    expect(result?.value).toBe('RAILWAY');
  });

  it('matches Namecheap and Google Workspace (non-API vendors) the same way as API vendors', () => {
    expect(matchProviderByVendor('Namecheap')?.value).toBe('NAMECHEAP');
    expect(matchProviderByVendor('Google Workspace')?.value).toBe('GOOGLE_WORKSPACE');
  });

  it('returns undefined for a vendor that does not match any known provider', () => {
    expect(matchProviderByVendor('Figma Inc.')).toBeUndefined();
  });
});

describe('INTEGRATION_PROVIDERS', () => {
  it('has a unique `value` for every entry (dropdown keys must not collide)', () => {
    const values = INTEGRATION_PROVIDERS.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('marks Namecheap and Google Workspace as hasApi: false (no live sync implied)', () => {
    const namecheap = INTEGRATION_PROVIDERS.find((p) => p.value === 'NAMECHEAP')!;
    const gws = INTEGRATION_PROVIDERS.find((p) => p.value === 'GOOGLE_WORKSPACE')!;
    expect(namecheap.hasApi).toBe(false);
    expect(gws.hasApi).toBe(false);
  });

  it('marks Railway and Claude as hasApi: true', () => {
    const railway = INTEGRATION_PROVIDERS.find((p) => p.value === 'RAILWAY')!;
    const claude = INTEGRATION_PROVIDERS.find((p) => p.value === 'CLAUDE')!;
    expect(railway.hasApi).toBe(true);
    expect(claude.hasApi).toBe(true);
  });

  it('gives Namecheap a YEARLY default billing cycle and Google Workspace a MONTHLY one', () => {
    const namecheap = INTEGRATION_PROVIDERS.find((p) => p.value === 'NAMECHEAP')!;
    const gws = INTEGRATION_PROVIDERS.find((p) => p.value === 'GOOGLE_WORKSPACE')!;
    expect(namecheap.defaultBillingCycle).toBe('YEARLY');
    expect(gws.defaultBillingCycle).toBe('MONTHLY');
  });
});
