# GCP Cost Integration — Loop Engineering Prompt + Definition of Done

## Context (verified against current GCP docs, not recalled from training)

There is **no REST endpoint that returns "current GCP spend."** Confirmed two
separate things:

1. **No live cost API.** The Cloud Billing Budget API only manages
   budgets/alerts and pushes notifications via Pub/Sub when a threshold is
   crossed — it has no "read current spend against this budget" call.
2. **The only real path is BigQuery Billing Export**, and it is a batch
   export, not a query-on-demand API:
   - The billing account owner must **manually enable it in the GCP
     Console** (Billing → Billing export → BigQuery export) — this cannot be
     done via API, it's a one-time human step.
   - Google then writes daily cost rows into a BigQuery dataset/table
     (`gcp_billing_export_v1_<BILLING_ACCOUNT_ID>` or the newer FOCUS-format
     table).
   - **Latency: a few hours to start seeing data, up to 5 days to fully
     catch up.** "This month's spend" from this table is therefore always
     somewhat stale for the last few days — never a live, real-time figure.
   - Reading it requires running a **BigQuery SQL query** (via the BigQuery
     REST API or client library), not a single simple "get spend" call —
     architecturally closer to "run a report" than "check a balance."

This makes GCP a **third, distinct integration shape** on top of the three
already built this session:
- Railway/Claude: direct REST "give me spend for this date range."
- HeyGen: REST "give me current balance," spend derived via delta-tracking.
- **GCP: SQL query against a batch-exported table, with an inherent multi-day
  lag, authenticated via a Google service account (JWT-based OAuth2), not a
  simple bearer-token header the way every other provider in this app uses.**

That last point matters concretely: `apps/api` has never needed
Google-service-account JWT auth before. This will need a new dependency
(`google-auth-library` and/or `@google-cloud/bigquery`) — nothing else in
this codebase does OAuth2 JWT signing today.

---

## What's needed from you before this can be built at all

Nothing below is something I can generate or discover — all of it requires
action in the GCP Console by whoever administers your billing account.

1. **Enable BigQuery Billing Export**, if not already on:
   GCP Console → Billing → your billing account → **Billing export** →
   **BigQuery export** → enable **"Standard usage cost" only — do NOT enable
   "Detailed usage cost."** Standard is per-SKU/project/day and stays
   comfortably inside BigQuery's always-free tier (10 GB storage + 1 TiB
   queries/month, no time limit); Detailed adds resource-level line items
   (individual VMs/disks), which is meaningfully larger for no benefit this
   integration needs — cost-relevant choice, confirmed with the user, not a
   default to reconsider later. Pick or create a GCP project to host the
   export dataset.
2. **The Billing Account ID** (format `XXXXXX-XXXXXX-XXXXXX`) — needed to
   confirm which export table we're reading, and to label the tool correctly
   if you have more than one billing account.
3. **The GCP Project ID** that hosts the BigQuery dataset the export writes
   to (often a dedicated "billing" or "ops" project, not necessarily the
   project whose spend you're tracking).
4. **The Dataset ID and table name** Google created for the export (visible
   in BigQuery console under that project once export is enabled — usually
   named `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>` or similar for FOCUS
   exports).
5. **A service account** (create one in IAM & Admin → Service Accounts) with:
   - `roles/bigquery.dataViewer` scoped to that specific dataset (not
     project-wide, if you want to keep this tightly scoped — least-privilege)
   - `roles/bigquery.jobUser` on the hosting project (needed to *run* a query
     job, separate from being able to *read* the data)
   - `roles/billing.viewer` on the billing account (optional — only needed if
     you want the app to auto-read your configured GCP Budget amount/threshold
     instead of entering the cap manually; a separate, narrower role from the
     two above since it's a different API, billingbudgets.googleapis.com, not
     BigQuery. Skip this if you don't have a GCP Budget set up — the app falls
     back to manual entry gracefully either way.)
   - A **JSON key** downloaded for that service account (or, if you'd rather
     avoid long-lived keys, Workload Identity Federation — bigger setup, only
     worth it if you specifically want to avoid a static key file).

Without all five of the above, there's nothing to build against — this is
squarely a "you configure GCP, then I build the integration" order of
operations, same as generating an API key was for every other provider, just
with more steps because GCP's cost data model has more moving parts.

---

## Loop Engineering Prompt

```
GOAL
Add GCP as a manually-configured, batch-lagged IntegrationProvider that reads
cost data from a BigQuery Billing Export table via a service-account-
authenticated SQL query - NOT a simple bearer-token REST call like every
other provider in this codebase.

STEP 0 - ALREADY CONFIRMED, DO NOT RE-INVESTIGATE
- No live GCP cost API exists. The Cloud Billing Budget API is alert-only
  (Pub/Sub push), not a pollable "current spend" endpoint.
- BigQuery Billing Export is the only path, and it is inherently 3-5 days
  behind for full accuracy, hours behind at best. Do not build or imply a
  "live sync every 15 min" expectation for GCP the way Railway/Claude/HeyGen
  have - the UI must make this lag explicit, not silently show a stale
  number as if it were current.
- Export must already be enabled by the user in the GCP Console before any
  code runs - if the configured dataset/table doesn't exist yet, fail with a
  clear "enable BigQuery Billing Export in the GCP Console first" error, not
  a generic query failure.

STEP 1 - NEW AUTH MECHANISM (genuinely new to this codebase)
Add `google-auth-library` (and either raw BigQuery REST calls via
`googleapis`/`google-auth-library`'s authorized fetch, or `@google-cloud/
bigquery` for a higher-level query API - prefer the official
`@google-cloud/bigquery` client, it handles job polling/pagination that a
raw REST implementation would otherwise have to hand-roll).
The service account JSON key becomes the provider's config - store the
whole key JSON (or its essential fields: client_email, private_key,
project_id) in ToolIntegration.config, same as every other provider stores
its credential there. Treat it with the same masking care integrations.
service.ts's maskConfig() already gives long string config values - verify
a multi-line PEM private key masks sensibly (it will not look like a normal
token, don't assume the existing masking logic degrades gracefully without
checking).

STEP 2 - PROVIDER
New file: apps/api/src/integrations/providers/gcp.provider.ts
class GCPProvider implements IntegrationProvider {
  fetchSpendUSD/fetchHistoricalSpendUSD both run essentially the same
  parameterized SQL query against the configured dataset.table, filtered by
  usage_start_time/usage_end_time (or export's actual date column - confirm
  exact column name against the real exported schema once the user's export
  is live, do not assume the column name from documentation alone), summing
  cost + SUM(credits.amount) per the standard GCP billing export schema
  (cost and credits are separate; net spend = cost + credits, credits are
  negative).
  No fetchLimitsUSD - no live limit-reading API exists (see Step 0).
}

STEP 3 - FRONTEND
File: apps/web/src/lib/integration-providers.ts
Add a GCP preset: hasApi: true, hasLimits: false, defaultPaymentKind:
'PREPAID'. Token entry needs to accept the service account JSON (a textarea
for pasting the whole key file, not a single-line input like every other
provider's tokenKey - this is a real UI difference, confirm with the user
before assuming a single-line field is fine for a multi-KB JSON blob).

STEP 4 - MAKE THE LAG VISIBLE IN THE UI
Wherever GCP's synced amount is displayed (dashboard tools table, Usage
History), it must be visually distinguishable from a live-synced provider -
e.g. "as of <export date>, may be a few days behind" - do not let it sit
next to Railway's "Live" badge implying the same freshness. This is a
requirement, not a nice-to-have: showing a stale number with no lag
indicator is actively misleading for a budget-tracking tool.

STEP 5 - TESTS
- gcp.provider.spec.ts: mock the BigQuery client/auth, verify the SQL
  query shape (date filtering, cost+credits summation), verify a
  dataset-not-found / export-not-enabled error produces the clear
  actionable message from Step 0, not a generic failure.
- Verify service-account JSON parsing handles a malformed/incomplete key
  file gracefully (missing client_email/private_key) rather than a cryptic
  auth-library stack trace reaching the user.

CONSTRAINTS
- Do not claim or imply real-time sync for GCP anywhere in the UI copy.
- Do not build this without the 5 pieces of user-provided config listed
  above - there is nothing to test against otherwise, unlike Railway/Claude/
  HeyGen where the app's own token-entry flow is enough to get started.
- Full regression pass (tsc --noEmit both apps, full Jest suite) required
  after - this touches a new dependency and the shared provider interface
  path, higher blast-radius risk than a same-shape provider addition.
```

---

## Definition of Done

1. **Config collected first**: billing account ID, GCP project ID, dataset/table name, and a working service account JSON key with the two roles above — confirmed present before implementation starts, not assumed.
2. **New dependency added deliberately**: `@google-cloud/bigquery` (or equivalent), justified in the same way `google-auth-library` is here — not silently pulled in.
3. **Query correctness verified against the real exported schema** (not just documentation) — the actual column names in your specific export table, confirmed by a real query run once your export is live, before the provider ships.
4. **Lag is visible in the UI**, not hidden — anywhere GCP's number appears, it's visually distinct from a live-synced tool and states roughly how stale it might be.
5. **No `fetchLimitsUSD`** — budget cap stays manual, same precedent as Claude/HeyGen, because no live-limit-reading API exists.
6. **Full regression pass green** on both apps.

## Learnings carried over from every prior integration this session

1. **Don't claim real-time accuracy a provider's API can't back up** — same principle as HeyGen's "no historical endpoint" honesty, applied here to GCP's multi-day export lag.
2. **Verify against the real, live account once configured** — GCP's own docs give the general schema, but the exact column names and export cadence should be confirmed against your actual dataset before the query logic is considered done, the same way HeyGen's delta math was checked against a real wallet balance, not just a mocked response.
3. **Don't build ahead of available configuration.** Every other integration this session could be scaffolded and unit-tested before a real credential existed. GCP genuinely can't — there's no dataset to query until you've done the Console setup, so implementation shouldn't start until the 5 items above exist.
