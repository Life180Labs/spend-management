# Claude/Anthropic Integration — Loop Engineering Prompt + Definition of Done

Modeled on the existing Railway integration architecture: `IntegrationProvider`
interface ([apps/api/src/integrations/provider.interface.ts](../apps/api/src/integrations/provider.interface.ts)),
reference implementation ([apps/api/src/integrations/providers/railway.provider.ts](../apps/api/src/integrations/providers/railway.provider.ts)),
provider registry ([apps/api/src/integrations/integration-runner.service.ts](../apps/api/src/integrations/integration-runner.service.ts)),
and the provider-dispatch logic in ([apps/api/src/integrations/integrations.service.ts](../apps/api/src/integrations/integrations.service.ts)).

## Context

This is **not** about calling Claude inside the app (no Messages API calls
needed). It's about pulling **Anthropic's own organization spend** — how much
the org has spent on the Claude API — the same way the Railway provider pulls
Railway's own billing usage. That data comes from Anthropic's **Admin API /
Usage & Cost Report** endpoints (organization-scoped, authenticated with an
**Admin API key**, distinct from a regular `ANTHROPIC_API_KEY`). The exact
response schema for that endpoint was not available in the reference material
used to write this prompt, so Step 0 below requires the implementer to verify
it against live docs before writing the provider — do not let it guess the
response schema.

The one existing wrinkle to fix, not just work around:
`integrations.service.ts` currently hardcodes `provider !== 'RAILWAY'` checks
in `fetchLimits`, `previewLimits`, and `getUsageHistory`. Adding Claude should
generalize that dispatch, not add a second hardcoded string next to the first.

---

## Loop Engineering Prompt

```
GOAL
Add a Claude/Anthropic integration to the spend-management app, following the
exact architectural pattern already established by the Railway integration.
When done, a user should be able to connect their Anthropic organization the
same way they connect Railway: add a Tool, configure the ANTHROPIC integration
with an Admin API key, see it sync spend into the dashboard budget bar, and
see it in Usage History (Current Month / Last Month / Custom Range) with the
same CPU/Memory-style breakdown adapted to Claude's own dimensions.

STEP 0 — VERIFY THE DATA SOURCE FIRST (do this before writing any code)
Anthropic exposes organization-level spend via its Admin API, authenticated
with a separate Admin API key (distinct from a normal ANTHROPIC_API_KEY used
to call Claude). WebFetch platform.claude.com/docs for the Admin API /
Usage & Cost Report endpoints and confirm:
  - The exact request path(s) for cost/usage reporting (there are separate
    "usage" and "cost" reports — usage is token/request counts, cost is
    actual USD spend; we want the cost report).
  - Auth header shape for Admin API keys (this is NOT the same as
    `x-api-key` with a regular key — confirm the exact header/scheme).
  - Whether it supports a date range query (start/end) the same way
    Railway's `usage(startDate, endDate)` does, and whether it returns
    a breakdown dimension (e.g. by model, by workspace, by API key) that
    can play the same role Railway's CPU/Memory breakdown plays.
  - Pagination behavior, rate limits, and whether historical data beyond
    the current billing period is available at all (if Anthropic's cost
    report only exposes a rolling window, say so explicitly rather than
    quietly limiting Last Month / Custom Range).
Do NOT write ClaudeProvider until this is confirmed. If the docs are
unreachable, stop and report exactly what's blocked rather than guessing
field names — a wrong schema here fails silently in production (bad totals
shown to the user), which is worse than a visible build error.

STEP 1 — CONFIG & SECRETS
- New integration config shape: { adminApiKey: string, organizationId?: string }
  (mirror Railway's config.apiToken pattern in shape, not literal fields).
- The Admin API key must be masked in integrations.service.ts's existing
  maskConfig() the same way Railway's token already is — verify the masking
  heuristic (mask any string >8 chars) already covers this; it should,
  but confirm rather than assume.
- Do NOT log the raw admin key anywhere (sync logs currently print
  `$${amount}` only — keep it that way).

STEP 2 — IMPLEMENT ClaudeProvider
File: apps/api/src/integrations/providers/claude.provider.ts
Implement `IntegrationProvider` (see provider.interface.ts):
  - fetchSpendUSD(config): current-period spend in USD. Follow the same
    "unify current and historical onto the same query shape" principle that
    RailwayProvider uses (computeUsageForRange) — the Railway integration
    had a real bug (dashboard vs Usage History mismatch) because it
    originally used two different API semantics for "now" vs "a range."
    Do not repeat that mistake here: fetchSpendUSD and
    fetchHistoricalSpendUSD should call the same underlying cost-report
    query with different date bounds, not two different endpoints/fields.
  - fetchHistoricalSpendUSD(config, {startDate, endDate}): same call,
    explicit range, returns { amountUSD, breakdown, byProject }.
    - `breakdown`: reuse the existing UsageBreakdownItem[] shape
      ({ measurement, amountUSD, rawValue }) — populate `measurement` with
      whatever dimension the cost report actually breaks down by (e.g.
      per-model: "claude-opus-5", "claude-sonnet-5", or input vs output
      tokens if that's what's reportable — confirmed in Step 0).
    - `byProject`: Anthropic's org structure uses "workspaces," not
      "projects" — map ProjectBreakdownItem.projectName to workspace name
      and projectId to workspace ID. If the API has no workspace dimension
      accessible with the given key scope, return an empty array rather
      than fabricating one row.
  - fetchLimitsUSD(config): only implement if Anthropic's API actually
    exposes a spend limit/budget for the org (some orgs configure spend
    limits in console). If there's no such endpoint, omit this method
    entirely (it's optional on the interface) rather than stubbing a
    fake limit — Tool.capAmount should then stay whatever the user
    configures manually, exactly like tools with no fetchLimitsUSD today.
  - Match RailwayProvider's resilience patterns: retry/backoff on
    rate-limit responses, and a "zero successes = throw, don't write a
    false $0" fail-safe (integration-runner.service.ts already implements
    the write-side of this fail-safe generically — just make sure
    ClaudeProvider throws on total failure instead of returning
    { amountUSD: 0 }).

STEP 3 — REGISTER THE PROVIDER
In integration-runner.service.ts, add to PROVIDERS:
  CLAUDE: new ClaudeProvider(),
No other change needed there — runOne() already branches purely on
provider.fetchLimitsUSD existing, which is provider-agnostic.

STEP 4 — GENERALIZE integrations.service.ts (this is the real risk spot)
Three methods currently hardcode `if (integration.provider !== 'RAILWAY')`:
fetchLimits, previewLimits, getUsageHistory. Replace the RAILWAY-specific
branch with a provider lookup that mirrors integration-runner's PROVIDERS
map — do NOT just add `|| provider === 'CLAUDE'` as a second hardcoded
string. Introduce a single shared provider registry (or import
integration-runner's PROVIDERS map / export a helper from it) so
integrations.service.ts asks "does this provider implement
fetchHistoricalSpendUSD / fetchLimitsUSD?" generically. This removes the
hardcoding permanently instead of doubling it, and means the *next*
integration after Claude doesn't need this file touched at all.

STEP 5 — FRONTEND
- add-tool-modal / integration-modal: add ANTHROPIC/CLAUDE as a selectable
  provider, with a config form for adminApiKey (masked input, same pattern
  as Railway's token field) and optional organizationId.
- Usage History page (apps/web/src/app/(app)/usage-history/page.tsx): no
  structural changes needed if breakdown/byProject shapes are honored —
  confirm the "Where it came from" segmented bar and "By project" list
  render sensibly with Claude's dimension labels (e.g. model names instead
  of CPU_USAGE/MEMORY_USAGE_GB) rather than assuming the existing labels fit.
- integration-modal's friendlyError() helper: add human-readable messages
  for Anthropic-specific error cases (invalid/expired admin key, insufficient
  admin-key permissions) alongside the existing rate-limit/permission cases.

STEP 6 — MIGRATION
No schema migration should be needed — ToolIntegration.provider is already
a free-form string, and lastSyncAmountUSD/lastSyncBreakdown/lastSyncByProject
are provider-agnostic JSON columns. If Step 0 reveals a field genuinely not
representable in the existing shape, stop and flag it before improvising a
schema change.

CONSTRAINTS
- USD only, everywhere (this app's base currency is USD post-migration —
  do not reintroduce any other currency into stored values).
- Do not call the Claude Messages API anywhere in this feature — this is
  spend *reporting*, not spend *generation*. If ClaudeProvider ends up
  importing `@anthropic-ai/sdk`'s messages client for anything other than
  hitting Admin endpoints, that's a sign of a wrong turn.
- Follow existing code style: no comments explaining what code does, only
  why (matches this codebase's existing provider files).
```

---

## Definition of Done

1. **Config**: A Tool can be configured with `provider: "CLAUDE"` and an Admin API key via the existing integration modal; the key is masked identically to Railway's token when read back.
2. **Sync**: The 15-minute integration-runner cron successfully calls `ClaudeProvider.fetchSpendUSD`, writes `usedAmount`, `barPct`, `lastSyncAmountUSD`, `lastSyncBreakdown`, `lastSyncByProject` to the DB — verified via at least one real sync cycle against a real (or sandboxed) Anthropic org, not just a mocked response.
3. **Dashboard**: The tool's budget bar reflects live USD spend and a "synced Xm ago" timestamp, exactly like Railway tools do today.
4. **Usage History — Current Month**: reads straight from the DB (no live call), consistent with the existing Railway current-month behavior — no separate "two different numbers" bug class introduced.
5. **Usage History — Last Month / Custom Range**: calls `fetchHistoricalSpendUSD` live, returns a breakdown and by-workspace split that render without layout breakage (dimension labels don't have to be CPU/Memory-shaped, but the UI must not show blank/garbled rows for Claude's actual dimensions).
6. **Provider dispatch is generic**: `integrations.service.ts` no longer has a second hardcoded `'RAILWAY'`/`'CLAUDE'` string check — adding a third provider later requires touching only its own provider file + the `PROVIDERS` map, per the architecture's original intent.
7. **Failure handling**: a total sync failure (bad key, Anthropic API down) leaves the last known-good `usedAmount` untouched and surfaces a human-readable error in the integration modal, matching Railway's fail-safe behavior.
8. **No plaintext secrets**: the Admin API key never appears in logs, audit entries, or unmasked API responses.
9. **Verified against real docs, not assumption**: the PR/change description states which Anthropic Admin API endpoint(s) were used and links or quotes the confirmed request/response shape — signaling Step 0 was actually done rather than skipped.
10. **No regression**: existing Railway integrations continue to sync and display correctly after the `integrations.service.ts` generalization (manually re-verify at least one Railway tool post-change).
