# HeyGen Remaining Balance + Low-Balance Indicator — Loop Engineering Prompt + Definition of Done

## Context

HeyGen's wallet model is fundamentally different from every payment kind this
app already models: Railway/PREPAID climbs *usage toward a cap*; HeyGen's
truly meaningful number is the *inverse* — a balance draining toward zero,
and the thing a user actually needs to know is "am I about to run out,"
not "have I crossed a cap I made up." The provider already reads and tracks
this balance internally (`heygenLastBalance` in `ToolIntegration.config`,
used for the spend-delta math) but it's never surfaced to the UI or the API
response today — this task exposes it and adds a lightweight low-balance
indicator.

**Explicitly decided in scoping, not to be revisited without asking:**
- **No new `PaymentKind`.** HeyGen stays `PREPAID`. Adding a new enum value
  means touching every `paymentKind`-check call site across the codebase —
  the team already avoided this once (`billingCycle` was added as an
  orthogonal field instead of a new kind for exactly this reason).
- **No new schema field on `Tool`.** The balance belongs to the
  *integration*, not the tool - add it to `ToolIntegration`, parallel to
  `lastSyncAmountUSD`/`lastSyncBreakdown`/`lastSyncByProject`.
- **Fixed $5 low-balance threshold, not a new configurable field.** A
  per-tool configurable "alert me below $X" setting is a reasonable future
  ask, but nobody has asked for it - inventing it now is exactly the kind
  of speculative scope this project has deliberately avoided all session
  (see: the Google Workspace per-seat calculator that was flagged, not
  built, until requested). $5 is a defensible, simple, universal default.
- **Does NOT plug into the existing budget-alert system** (barPct/
  alertThresholdPct, the `checkThresholdAlerts` email cron, the dashboard's
  "Active Threshold Alerts" KPI count, the Alerts page's "Threshold
  Breaches" section). That system means "spend crossed a cap you set" -
  conflating "wallet is low" into the same count/email would blur two
  different, unrelated signals under one meaning. This pass adds a purely
  visual, inline indicator only. Wiring it into alerts/email is a
  reasonable follow-up but a separate, explicit ask - flag it as optional,
  do not build it speculatively.

---

## Loop Engineering Prompt

```
GOAL
Surface HeyGen's (and any future wallet-style provider's) remaining balance
in the Dashboard tools table, with a low-balance visual indicator - without
touching PaymentKind, without a new configurable threshold field, and without
wiring into the existing spend-vs-cap alert system.

STEP 1 — SCHEMA
File: apps/api/prisma/schema.prisma
Add one nullable field to ToolIntegration, next to the other lastSync* fields:
  lastSyncRemainingBalanceUSD Float?  // wallet-style providers only (e.g. HeyGen) - null for every other provider
Generate and apply a migration. This is the ONLY schema change - do not touch
Tool.

STEP 2 — PROVIDER INTERFACE
File: apps/api/src/integrations/provider.interface.ts
Add one optional field to SpendResult, parallel to breakdown/byProject:
  remainingBalanceUSD?: number;
Document it as: the provider's current account balance, for wallet-style
providers where that's a meaningful concept (most providers - Railway,
Claude - have no such number and simply never return this field).

STEP 3 — PROVIDER
File: apps/api/src/integrations/providers/heygen.provider.ts
fetchSpendUSD already computes `currentBalance` - just add it to the
returned SpendResult:
  return { amountUSD: periodSpend, remainingBalanceUSD: currentBalance, providerState: {...} };
No other logic changes.

STEP 4 — PERSIST IT
File: apps/api/src/integrations/integration-runner.service.ts, runOne()
Destructure remainingBalanceUSD from the fetchSpendUSD result and write it to
tx.toolIntegration.update's data as lastSyncRemainingBalanceUSD: remainingBalanceUSD
?? null - so a provider that never returns it (Railway, Claude) explicitly
stores null, not "leaves whatever was there before" (Prisma writes null when
you pass null, unlike the providerState/config-merge pattern which uses
undefined to mean "don't touch"). This is a plain scalar field, not a merge -
verify a provider that stops reporting a balance (e.g. an API error before
this field is read) doesn't leave a stale number behind. Confirm by test:
Railway/Claude syncs write lastSyncRemainingBalanceUSD: null every time.

STEP 5 — EXPOSE IT IN THE TOOLS API
File: apps/api/src/tools/tools.service.ts
The `integration` select in list()/findOne() already picks specific fields
(provider, lastSyncAt, lastSyncAmountUSD, lastSyncBreakdown, lastSyncByProject,
isActive, lastError) - add lastSyncRemainingBalanceUSD to that select list.

STEP 6 — FRONTEND: SHOW THE BALANCE
File: apps/web/src/app/(app)/dashboard/page.tsx
Interface Tool's `integration` type: add lastSyncRemainingBalanceUSD: number | null.
In ToolRow's Budget Status column, for a tool with
tool.integration?.lastSyncRemainingBalanceUSD != null, render a small
secondary line under the existing status (same visual weight/placement as
the existing "synced Xm ago" line): "$X.XX left". Color it normally
(existing muted gray) UNLESS balance < 5, in which case color it amber/red
(reuse the existing alert color tokens already in the file - #F5A623 amber,
#F85149 red - do not invent new hex values) and prefix with a small warning
glyph consistent with the file's existing inline-SVG warning icon style.
Below $1, use the red tone; between $1 and $5, amber. This is a purely
presentational threshold in the component - no new prop plumbing beyond the
one new field, no new state.

STEP 7 — TESTS
- Extend integration-runner.service.spec.ts: a HeyGen-style provider
  returning remainingBalanceUSD writes it to lastSyncRemainingBalanceUSD;
  Railway/Claude (never returning it) write lastSyncRemainingBalanceUSD: null
  explicitly - both asserted, not assumed.
- Extend heygen.provider.spec.ts: every existing test case's returned
  SpendResult now also includes the correct remainingBalanceUSD (equal to
  the mocked currentBalance) - update assertions, don't just add one new
  test that duplicates coverage.
- No frontend test suite currently covers dashboard/page.tsx's ToolRow
  rendering directly (only add-tool-modal.tsx has a component test) - a new
  ToolRow-focused test is optional, not required, given the existing
  precedent; if skipped, verify by reading the rendered output logic
  carefully and note in the report that this specific visual wasn't
  automatically tested.

CONSTRAINTS
- Do not add a new PaymentKind, a new Tool schema field, or a new
  configurable per-tool threshold - see "Explicitly decided" in the context
  above.
- Do not wire this into checkThresholdAlerts, the dashboard's Active
  Threshold Alerts KPI, or the Alerts page - purely a Dashboard tools-table
  visual, this pass.
- Do not touch Railway/Claude/Namecheap/Google Workspace behavior - full
  regression pass (tsc --noEmit both apps, full Jest suite) required after.
```

---

## Definition of Done

1. **Schema**: `ToolIntegration.lastSyncRemainingBalanceUSD` exists, nullable, migrated cleanly on local (and documented as needing the same migration run on prod before this ships there - same `prisma migrate deploy` step already wired into `apps/api/railway.json`'s `preDeployCommand`, no new deploy step needed).
2. **HeyGen syncs populate it**: a real (or mocked) HeyGen sync writes the current balance to `lastSyncRemainingBalanceUSD`; verified via test, not just inspection.
3. **Railway/Claude explicitly write `null`**, not left untouched — verified via test, distinguishing this from the separate `providerState`/`config`-merge mechanism which *does* mean "don't touch."
4. **Dashboard shows "$X.XX left"** under a HeyGen-integrated tool's Budget Status, colored normally above $5, amber $1–5, red below $1 — using existing color tokens, no new ones invented.
5. **No other tool's row changes** — Railway/Claude/Namecheap/Google Workspace rows render identically to before this change.
6. **Not built (explicitly, not silently skipped)**: no new PaymentKind, no configurable threshold, no wiring into the email-alert cron or the Alerts page/KPI count — confirmed absent, flagged as available future work if wanted.
7. **Full regression pass**: `tsc --noEmit` clean on both apps, full Jest suite green on both apps.

## Learnings carried over from every prior integration this session (apply here, don't repeat)

1. **Don't invent schema/enum sprawl when an orthogonal field will do** — same reasoning as `billingCycle`, applied here to keep `PaymentKind` untouched.
2. **Don't build speculative scope** — no configurable threshold, no email/alert-cron wiring, until asked. State clearly what was deliberately left out, not silently.
3. **`undefined` (don't touch) and `null` (explicitly clear) are different signals in a Prisma update** — the `providerState`/`config` merge pattern uses `undefined` for "provider didn't say anything about this"; this new plain scalar field uses `null` for "this provider has no balance to report," and that distinction must be tested, not assumed identical.
4. **Verify empirically, every time** — real test coverage for the delta/persistence logic, not just "should work by inspection," matching the standard every other provider and endpoint in this session was held to.
5. **`tsc --noEmit` + full regression pass after every change**, not just the new code in isolation.
