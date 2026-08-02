# HeyGen Integration — Loop Engineering Prompt + Definition of Done

## Context

Researched and confirmed (prior turn): HeyGen has a real, documented REST API
— `GET https://api.heygen.com/v3/users/me`, authenticated via an `X-Api-Key`
header — that returns `data.wallet.remaining_balance` (a live USD figure).
This is genuinely closer to Railway/Claude (real API, `hasApi: true`) than to
Namecheap/Google Workspace (manual-only).

**But it is architecturally different from every provider built so far.**
Railway and Claude both expose a query-a-date-range endpoint that returns an
authoritative "total spend in this window" — the provider can always
recompute "this calendar month's spend" from scratch on every sync. HeyGen's
wallet is **prepaid and declining**: the API only ever tells you *how much
money is left*, never *how much was spent in a given period*. There is no
documented transaction log or historical-usage endpoint.

This means "spend this month" cannot be queried — it must be **derived by
tracking balance deltas across syncs**:
- Balance dropped since the last sync → that drop is spend; accumulate it.
- Balance rose since the last sync → that's a manual top-up, not spend; do
  **not** subtract it from the accumulator, just record the new balance as
  the new baseline.
- A new calendar month has started since the last sync → the accumulator
  represents last month's spend now; reset to 0 and start fresh (mirrors how
  Railway/Claude's calendar-month total naturally resets every month).
- First sync ever (no prior baseline stored) → spend is unknowable before
  this point; start the accumulator at 0 rather than guessing.

This requires the provider to persist state across syncs (last-seen balance,
running accumulator, the month it belongs to) — something no existing
provider does. `IntegrationProvider.fetchSpendUSD` today returns only
`{ amountUSD, breakdown?, byProject? }`, with nowhere to say "please save
this extra state for next time." That's the one real architecture extension
this task needs; everything else (dropdown, dedup, Configure Integration,
Usage History's "not available" fallback) already generalizes for free.

---

## Loop Engineering Prompt

```
GOAL
Add HeyGen as a real (hasApi: true) IntegrationProvider using PREPAID-style
live balance tracking, deriving "spend this month" from wallet-balance deltas
across syncs rather than a queryable date-range total (which HeyGen's API
does not offer).

STEP 0 — ALREADY CONFIRMED, DO NOT RE-INVESTIGATE
- Real endpoint: GET https://api.heygen.com/v3/users/me, header `X-Api-Key`.
- Response shape: { data: { wallet: { currency: "usd", remaining_balance:
  <number>, auto_reload: {...} }, billing_type, ... } }.
- No historical/transaction-log endpoint exists - fetchHistoricalSpendUSD
  must NOT be implemented (leave it undefined, exactly like Claude). This is
  already handled generically everywhere it matters: Usage History's
  getUsageHistory() already throws "Usage history is not available for this
  provider yet" when a provider lacks the method, and the Configure
  Integration modal already hides the feature - do not add a special case.
- No spend-limit/budget endpoint exists either - fetchLimitsUSD must NOT be
  implemented either (same reasoning, same precedent as Claude). capAmount
  stays whatever the user configures manually.

STEP 1 — EXTEND THE PROVIDER INTERFACE (small, backward-compatible)
File: apps/api/src/integrations/provider.interface.ts
Add one optional field to SpendResult:
  providerState?: Record<string, any>;
Document it clearly: an optional bag of arbitrary provider-specific state to
merge into ToolIntegration.config after a successful sync, for providers that
need to remember something across calls (e.g. a last-seen balance for delta
tracking). Providers that don't return it (Railway, Claude) are completely
unaffected - this must be verified, not assumed.

STEP 2 — PERSIST providerState IN THE RUNNER
File: apps/api/src/integrations/integration-runner.service.ts, runOne()
After calling provider.fetchSpendUSD(config), if the result includes
providerState, merge it into the config written back to tool_integrations:
  data: {
    ...,
    config: result.providerState ? { ...config, ...result.providerState } : undefined,
  }
Prisma ignores `undefined` fields in an update - passing undefined when there
is no providerState must leave the stored config completely untouched. Verify
this explicitly (a test or script that syncs Railway/Claude and confirms
their config is byte-for-byte identical before/after).

STEP 3 — BUILD THE PROVIDER
New file: apps/api/src/integrations/providers/heygen.provider.ts
class HeyGenProvider implements IntegrationProvider {
  async fetchSpendUSD(config) {
    - Read config.apiKey; throw if missing (same pattern as Railway/Claude's
      missing-token check).
    - GET https://api.heygen.com/v3/users/me with X-Api-Key header.
    - Extract data.wallet.remaining_balance. Throw a clear error if the
      response doesn't have it (bad key, wrong billing_type, API shape
      changed) - never silently treat a malformed response as "$0 spent,"
      same "fail loud instead of overwriting good data with a false number"
      principle Railway's provider already documents for its own rate-limit
      case.
    - Read config.heygenLastBalance, config.heygenPeriodSpend,
      config.heygenPeriodMonthKey (all may be undefined on first sync).
    - Compute currentMonthKey = today's "YYYY-MM".
    - If no stored baseline OR storedMonthKey !== currentMonthKey: start
      fresh, periodSpend = 0.
    - Else: delta = storedBalance - currentBalance. If delta > 0 (balance
      dropped = spend), periodSpend = storedSpend + delta. If delta <= 0
      (balance rose or unchanged = top-up or no-op), periodSpend =
      storedSpend unchanged - do NOT let a top-up reduce the accumulator.
    - Return { amountUSD: periodSpend, providerState: { heygenLastBalance:
      currentBalance, heygenPeriodSpend: periodSpend, heygenPeriodMonthKey:
      currentMonthKey } }.
  }
  // fetchLimitsUSD and fetchHistoricalSpendUSD deliberately omitted - see Step 0.
}

STEP 4 — REGISTER THE PROVIDER
File: apps/api/src/integrations/integration-runner.service.ts
Add HEYGEN: new HeyGenProvider() to the PROVIDERS map. One line - this is the
"no other file needs to change" extensibility point the comment already
documents.

STEP 5 — ADD THE FRONTEND PRESET
File: apps/web/src/lib/integration-providers.ts
Add to INTEGRATION_PROVIDERS:
  {
    value: 'HEYGEN', label: 'HeyGen', vendor: 'HeyGen',
    hasApi: true, tokenKey: 'apiKey', tokenLabel: 'API Key',
    placeholder: 'Paste your HeyGen API key',
    helpText: 'app.heygen.com → Settings → API Keys',
    hasLimits: false, defaultPaymentKind: 'PREPAID',
  }
hasLimits: false means the Add Tool modal already asks for a manual budget
cap even in "Connect account" mode - this is the exact same code path Claude
already exercises (hasApi: true, hasLimits: false). Verify by test, don't
assume - the lesson from every prior integration this session is that
"should generalize" and "does generalize" are different claims.
Before adding, grep existing tool vendor strings for a "HeyGen" collision
(same diligence as every previous integration - Railway.com nearly bit us
once already).

STEP 6 — TESTS
- apps/api/src/integrations/providers/heygen.provider.spec.ts (new): mock
  global.fetch, cover: first sync (no baseline, periodSpend=0, providerState
  populated correctly), a pure spend delta (balance drops, accumulator
  increases by exactly the delta), a top-up (balance rises, accumulator
  UNCHANGED, baseline balance still updates to the new higher value), a
  month-rollover (stored monthKey != current, resets to 0 even though a
  balance was stored), a malformed response (missing wallet.remaining_balance
  throws, doesn't return amountUSD: 0), and a missing apiKey (throws before
  any fetch call).
- Extend integration-runner.service.spec.ts: a provider returning
  providerState causes config to be merged into the persisted
  toolIntegration.config; a provider NOT returning it (existing Railway/Claude
  test cases) leaves config completely undefined in the update payload -
  regression-proof the "backward compatible" claim from Step 1/2, don't just
  assert it in a comment.
- Full apps/api suite must stay green - no changes to Railway/Claude
  behavior are permitted by this task.

CONSTRAINTS
- Do not implement fetchLimitsUSD or fetchHistoricalSpendUSD for HeyGen - see
  Step 0. If tempted, stop - that means inventing an endpoint HeyGen doesn't
  document, not implementing what's actually there.
- Do not add HeyGen-specific branches anywhere in scheduler.service.ts,
  reports.service.ts, tools.service.ts, or any frontend file outside the one
  preset entry in Step 5 - if it's a real IntegrationProvider dispatched
  generically like Railway/Claude, no other file should need a special case.
- Do not fabricate a real API key or pretend to have tested against a live
  HeyGen account - there is no real key available in this environment. All
  verification must be via mocked-fetch unit tests (fully sufficient to prove
  the delta math is correct) - be explicit in the final report about what was
  and wasn't verified against the real HeyGen API.
```

---

## Definition of Done

1. **Dropdown**: "HeyGen" appears in the Add Tool Integration dropdown, `hasApi: true`, defaults to Pre-paid payment type with a manual budget-cap field shown (same UX as Claude — no limits endpoint).
2. **Provider registered**: `PROVIDERS.HEYGEN` dispatches through the exact same generic paths `runAll()`/`runOne()`/`fetchLimits()`/`getUsageHistory()` already use for every other provider — no new `if (provider === 'HEYGEN')` branch anywhere.
3. **Delta math correct and tested**: first-sync-zero, pure-spend-delta, top-up-ignored, and month-rollover-reset all covered by real (non-fabricated) unit tests against a mocked `fetch`, all passing.
4. **State persistence verified**: a sync that returns `providerState` merges into `tool_integrations.config`; a sync that doesn't (Railway, Claude) leaves `config` provably untouched — both covered by tests, not assumed.
5. **No historical/limits claims**: `fetchHistoricalSpendUSD` and `fetchLimitsUSD` are not implemented for HeyGen; Usage History and Configure Integration already degrade gracefully for a provider missing them (confirmed via existing generic-dispatch tests, no new code).
6. **No regression**: full `apps/api` Jest suite green, `tsc --noEmit` clean on both apps, Railway/Claude/Namecheap/Google Workspace behavior provably unchanged.
7. **Honest verification report**: final report explicitly states this was verified via mocked unit tests only (no real HeyGen API key was available), not silently implied to have been tested end-to-end against a live account.

## Learnings carried over from every prior integration this session (apply here, don't repeat)

1. **Single source of truth, no drift.** `matchProviderByVendor()`/`INTEGRATION_PROVIDERS` already generalize — this is a data addition to that one list, same as Namecheap/Google Workspace, not new matching logic.
2. **Check for vendor-string collisions before adding a preset** — Railway's real stored vendor was "Railway.com," not "Railway"; verify "HeyGen" doesn't collide before assuming it's safe.
3. **Don't fabricate real data or a real test account.** No real HeyGen API key exists here — verify the logic with mocked `fetch`, and say so plainly rather than implying live verification that didn't happen.
4. **Don't build unrequested scope.** No `fetchLimitsUSD`, no `fetchHistoricalSpendUSD`, no new UI beyond the one preset entry — HeyGen's real API genuinely doesn't support those, and inventing behavior around a documented gap is worse than leaving it honestly absent (same principle as Namecheap/Claude Pro's "no live API" conclusion, applied to HeyGen's "no historical API" gap specifically).
5. **`tsc --noEmit` clean + full regression pass after every change**, not just the new code in isolation — this has caught real bugs (the pro-ration bug, the soft-delete leak, the vendor-matching drift, the `periodSpendByTool` current-month gap) every single time it's been skipped even briefly.
6. **Verify claims empirically, not by inspection alone.** Every "should work" in this project has needed a real script or real test to become "does work" — the HeyGen delta math especially, since it's genuinely new logic with real edge cases (top-ups, month boundaries) that are easy to get subtly wrong on the first pass.
