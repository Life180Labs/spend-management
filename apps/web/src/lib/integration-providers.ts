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
  /** True when connecting needs more than one credential field (e.g. GCP needs a
   * service account JSON key plus project/dataset/table/billing-account IDs, not
   * a single token) - the Add Tool and Configure Integration modals render a
   * provider-specific field set instead of the generic single tokenKey input. */
  multiField?: boolean;
  /** True when the provider's data is inherently batch/delayed rather than live
   * (e.g. GCP's BigQuery Billing Export, hours-to-days behind) - anywhere this
   * provider's synced amount is shown, it must read as "delayed," never "Live",
   * so it's never confused with a truly real-time sync. */
  hasLag?: boolean;
  /** Only meaningful when hasLimits is true. For most hasLimits providers (e.g.
   * Railway) a null fetchLimitsUSD result means something's actually broken
   * (bad token, wrong scope) - Connect should block until it succeeds. For a
   * provider whose limit-reading depends on a genuinely optional resource the
   * account may just not have set up yet (e.g. GCP's Budget - a separate,
   * optional Console resource, unlike Railway's near-universal usage limits),
   * a null result is a normal, expected state, not an error - Connect should
   * fall back to manual cap entry instead of hard-blocking. */
  limitsOptional?: boolean;
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
    // Counterintuitively, an Account-scoped token ("No workspace") CANNOT read budget
    // limits or usage history for this app - only a token scoped TO the workspace can
    // (verified empirically: Account-scoped only gets a bare current-spend number,
    // Workspace-scoped gets spend + limits + history). Pick the workspace, not "No workspace".
    helpText: 'railway.com → Account Settings → API Tokens → pick your workspace (not "No workspace")',
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
  {
    // No IntegrationProvider - Hostinger's Billing API reports subscription
    // status/renewal metadata, not a verified per-subscription cost figure
    // (see docs/hostinger-integration-loop-prompt.md Step 0). Manual entry
    // only, same as Namecheap/Google Workspace.
    value: 'HOSTINGER',
    label: 'Hostinger',
    vendor: 'Hostinger',
    hasApi: false,
    tokenKey: '',
    tokenLabel: '',
    placeholder: '',
    helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'MONTHLY',
  },
  {
    value: 'GOOGLE_WORKSPACE',
    label: 'Google Workspace',
    vendor: 'Google Workspace',
    hasApi: false,
    tokenKey: '',
    tokenLabel: '',
    placeholder: '',
    helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'MONTHLY',
  },
  {
    value: 'HEYGEN',
    label: 'HeyGen',
    vendor: 'HeyGen',
    hasApi: true,
    tokenKey: 'apiKey',
    tokenLabel: 'API Key',
    placeholder: 'Paste your HeyGen API key',
    helpText: 'app.heygen.com → Settings → API Keys',
    // No spend-limit endpoint (same as Claude) - budget cap is always entered
    // manually, even in "Connect account" mode.
    hasLimits: false,
    defaultPaymentKind: 'PREPAID',
  },
  {
    value: 'GCP',
    label: 'Google Cloud Platform',
    vendor: 'Google Cloud',
    hasApi: true,
    // Not a single token - see multiField below. tokenKey still matches the config
    // field the backend reads, kept for consistency with the generic shape.
    tokenKey: 'serviceAccountJson',
    tokenLabel: 'Service Account JSON Key',
    placeholder: '',
    helpText: 'GCP Console → BigQuery Billing Export must be enabled first, and the service account needs roles/billing.viewer on the billing account to read the configured budget - see docs/gcp-billing-integration-loop-prompt.md',
    // Reads the configured budget (amount + alert threshold) from the Cloud
    // Billing Budget API - a different endpoint from the BigQuery export used
    // for spend, requiring the extra roles/billing.viewer role.
    hasLimits: true,
    // Unlike Railway, a GCP Budget is a separate, optional Console resource -
    // plenty of real accounts won't have one configured. A null result here
    // must fall back to manual cap entry, not block connecting entirely.
    limitsOptional: true,
    defaultPaymentKind: 'PREPAID',
    multiField: true,
    // BigQuery Billing Export is a daily batch, hours-to-5-days behind - never
    // "Live" the way Railway/Claude/HeyGen's syncs are.
    hasLag: true,
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
