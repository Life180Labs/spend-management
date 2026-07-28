export interface IntegrationProviderMeta {
  value: string;
  label: string;
  /** Vendor name to auto-fill on the tool when this integration is selected (e.g. "Anthropic" for the "Claude (Anthropic)" integration). */
  vendor: string;
  /** Whether this provider has a real API to connect to. False for known vendors that are
   * tracked manually (e.g. Namecheap) - picking one just fills in Name/Vendor/Payment
   * defaults, it never shows a token field or implies a live sync. */
  hasApi: boolean;
  tokenKey: string;
  tokenLabel: string;
  placeholder: string;
  helpText: string;
  /** Whether this provider can report a spend limit/hard cap via API (see fetchLimitsUSD on the backend). Meaningless when hasApi is false. */
  hasLimits: boolean;
  /** Payment type this vendor is naturally tracked as - auto-applied when picked from the dropdown. */
  defaultPaymentKind: 'PREPAID' | 'MOSUB';
  /** Only meaningful for MOSUB vendors. */
  defaultBillingCycle?: 'MONTHLY' | 'YEARLY';
}

// Single source of truth for which integrations/known vendors are supported,
// shared by the Add Tool modal and the Configure Integration modal so the two
// never drift.
export const INTEGRATION_PROVIDERS: IntegrationProviderMeta[] = [
  {
    value: 'RAILWAY',
    label: 'Railway',
    vendor: 'Railway',
    hasApi: true,
    tokenKey: 'apiToken',
    tokenLabel: 'API Token',
    placeholder: 'Paste your Railway API token',
    helpText: 'railway.com → Account Settings → API Tokens',
    hasLimits: true,
    defaultPaymentKind: 'PREPAID',
  },
  {
    value: 'CLAUDE',
    label: 'Claude (Anthropic)',
    vendor: 'Anthropic',
    hasApi: true,
    tokenKey: 'adminApiKey',
    tokenLabel: 'Admin API Key',
    placeholder: 'Paste your Anthropic Admin API key (sk-ant-admin01-...)',
    helpText: 'console.anthropic.com → Settings → Admin Keys',
    hasLimits: false,
    defaultPaymentKind: 'PREPAID',
  },
  {
    value: 'NAMECHEAP',
    label: 'Namecheap',
    vendor: 'Namecheap',
    hasApi: false,
    tokenKey: '',
    tokenLabel: '',
    placeholder: '',
    helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'YEARLY',
  },
];

/**
 * Matches a tool's free-text vendor field to a supported integration, tolerating
 * the kind of variation real data has (e.g. "Railway.com" vs the provider's
 * canonical "Railway") via a substring check in either direction, not just an
 * exact match. Single source of truth - both the Add Tool dropdown's "already
 * exists" check and the Configure Integration provider lock must use this same
 * function, or the two can silently drift out of sync with each other.
 */
export function matchProviderByVendor(vendor: string | undefined | null): IntegrationProviderMeta | undefined {
  const toolVendor = vendor?.trim().toLowerCase();
  if (!toolVendor) return undefined;
  return INTEGRATION_PROVIDERS.find((p) => {
    const providerVendor = p.vendor.toLowerCase();
    return toolVendor === providerVendor || toolVendor.includes(providerVendor);
  });
}
