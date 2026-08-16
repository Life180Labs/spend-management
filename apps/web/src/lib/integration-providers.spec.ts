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

  it('matches Namecheap, Google Workspace, and Hostinger (non-API vendors) the same way as API vendors', () => {
    expect(matchProviderByVendor('Namecheap')?.value).toBe('NAMECHEAP');
    expect(matchProviderByVendor('Google Workspace')?.value).toBe('GOOGLE_WORKSPACE');
    expect(matchProviderByVendor('Hostinger')?.value).toBe('HOSTINGER');
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

  it('marks Namecheap, Google Workspace, and Hostinger as hasApi: false (no live sync implied)', () => {
    const namecheap = INTEGRATION_PROVIDERS.find((p) => p.value === 'NAMECHEAP')!;
    const gws = INTEGRATION_PROVIDERS.find((p) => p.value === 'GOOGLE_WORKSPACE')!;
    const hostinger = INTEGRATION_PROVIDERS.find((p) => p.value === 'HOSTINGER')!;
    expect(namecheap.hasApi).toBe(false);
    expect(gws.hasApi).toBe(false);
    expect(hostinger.hasApi).toBe(false);
  });

  it('marks Railway and Claude as hasApi: true', () => {
    const railway = INTEGRATION_PROVIDERS.find((p) => p.value === 'RAILWAY')!;
    const claude = INTEGRATION_PROVIDERS.find((p) => p.value === 'CLAUDE')!;
    expect(railway.hasApi).toBe(true);
    expect(claude.hasApi).toBe(true);
  });

  it('gives Namecheap a YEARLY default billing cycle, Google Workspace and Hostinger a MONTHLY one', () => {
    const namecheap = INTEGRATION_PROVIDERS.find((p) => p.value === 'NAMECHEAP')!;
    const gws = INTEGRATION_PROVIDERS.find((p) => p.value === 'GOOGLE_WORKSPACE')!;
    const hostinger = INTEGRATION_PROVIDERS.find((p) => p.value === 'HOSTINGER')!;
    expect(namecheap.defaultBillingCycle).toBe('YEARLY');
    expect(gws.defaultBillingCycle).toBe('MONTHLY');
    expect(hostinger.defaultBillingCycle).toBe('MONTHLY');
  });

  it('marks GCP as multiField (needs a service account JSON + several IDs, not one token) and hasLag (batch export, never "Live")', () => {
    const gcp = INTEGRATION_PROVIDERS.find((p) => p.value === 'GCP')!;
    expect(gcp.hasApi).toBe(true);
    expect(gcp.multiField).toBe(true);
    expect(gcp.hasLag).toBe(true);
  });

  it('marks GCP as hasLimits + limitsOptional - it CAN read its configured budget, but a missing one (no GCP Budget set up) must fall back to manual entry, not block Connect', () => {
    const gcp = INTEGRATION_PROVIDERS.find((p) => p.value === 'GCP')!;
    expect(gcp.hasLimits).toBe(true);
    expect(gcp.limitsOptional).toBe(true);
  });

  it('every other provider defaults multiField/hasLag/limitsOptional to falsy (only GCP opts in)', () => {
    const others = INTEGRATION_PROVIDERS.filter((p) => p.value !== 'GCP');
    others.forEach((p) => {
      expect(p.multiField).toBeFalsy();
      expect(p.hasLag).toBeFalsy();
      expect(p.limitsOptional).toBeFalsy();
    });
  });
});
