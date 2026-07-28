export interface IntegrationProviderMeta {
  value: string;
  label: string;
  /** Vendor name to auto-fill on the tool when this integration is selected (e.g. "Anthropic" for the "Claude (Anthropic)" integration). */
  vendor: string;
  tokenKey: string;
  tokenLabel: string;
  placeholder: string;
  helpText: string;
  /** Whether this provider can report a spend limit/hard cap via API (see fetchLimitsUSD on the backend). */
  hasLimits: boolean;
}

// Single source of truth for which integrations are supported, shared by the
// Add Tool modal and the Configure Integration modal so the two never drift.
export const INTEGRATION_PROVIDERS: IntegrationProviderMeta[] = [
  {
    value: 'RAILWAY',
    label: 'Railway',
    vendor: 'Railway',
    tokenKey: 'apiToken',
    tokenLabel: 'API Token',
    placeholder: 'Paste your Railway API token',
    helpText: 'railway.com → Account Settings → API Tokens',
    hasLimits: true,
  },
  {
    value: 'CLAUDE',
    label: 'Claude (Anthropic)',
    vendor: 'Anthropic',
    tokenKey: 'adminApiKey',
    tokenLabel: 'Admin API Key',
    placeholder: 'Paste your Anthropic Admin API key (sk-ant-admin01-...)',
    helpText: 'console.anthropic.com → Settings → Admin Keys',
    hasLimits: false,
  },
];
