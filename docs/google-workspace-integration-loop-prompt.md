# Google Workspace Subscription Integration — Loop Engineering Prompt + Definition of Done

## Context

Same conclusion as Namecheap: no live spend API is available (confirmed —
the only billing-adjacent Admin SDK surface, the Reseller API, explicitly
requires a signed Google reseller contract, which this org doesn't have).
This is manual-entry only.

The one thing that makes Google Workspace *different* from Namecheap/Claude
Pro: it bills **monthly**, not yearly — so it needs **zero new schema or
cron work**. `billingCycle: MONTHLY` is already the default, and the entire
rollover/billing-history pipeline already handles monthly subscriptions
correctly (proven via Claude Pro). This task is therefore much smaller than
the Namecheap one — it's essentially "add one more known-vendor preset," not
"build a new cadence."

The other difference worth flagging, not necessarily solving: Google
Workspace is **per-seat** (licenses × price/user), so the dollar amount can
drift whenever headcount changes — unlike Namecheap/Claude Pro's genuinely
flat fee. Scoped below as optional, not required.

---

## Loop Engineering Prompt

```
GOAL
Add "Google Workspace" as a known-vendor preset in the Add Tool Integration
dropdown, following the exact Namecheap pattern (manual-entry-only, no
IntegrationProvider) - not a new mechanism, an application of the existing one.

STEP 0 — ALREADY CONFIRMED, DO NOT RE-INVESTIGATE
No live billing API is available for a direct (non-reseller) Workspace
customer. The Admin SDK Reseller API requires "a fully executed and signed
reseller contract" per Google's own prerequisites page - this org doesn't
have one, and even with one, the API exposes plan/SKU/license metadata, not
the actual discounted bill amount. This was already researched and confirmed
in a prior turn; do not spend time re-verifying it or building a provider.

STEP 1 — ADD THE PRESET
File: apps/web/src/lib/integration-providers.ts
Add one entry to INTEGRATION_PROVIDERS:
  {
    value: 'GOOGLE_WORKSPACE',
    label: 'Google Workspace',
    vendor: 'Google Workspace',
    hasApi: false,
    tokenKey: '', tokenLabel: '', placeholder: '', helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'MONTHLY',
  }
That's the whole schema/data change. Because matchProviderByVendor() already
does substring-tolerant matching, verify "Google Workspace" as the vendor
string doesn't collide with anything else already in use (it won't - check
by grepping existing tool vendors, same diligence as the Railway.com case).

STEP 2 — VERIFY THE EXISTING MACHINERY JUST WORKS
Do NOT write new code for these - just confirm by testing (same method as
the Namecheap dropdown-flow test): picking "Google Workspace" from the
dropdown should auto-set Payment type -> Subscription, Billing cycle ->
Monthly, lock Vendor -> "Google Workspace", and skip straight to the
amount/renewal fields with no token step - identical mechanics to Namecheap,
just MONTHLY instead of YEARLY. If this doesn't happen automatically, that
means Step 1's entry is wrong, not that new logic is needed.

STEP 3 (OPTIONAL - CONFIRM WITH USER BEFORE BUILDING) — PER-SEAT CALCULATOR
Google Workspace's cost is licenses x price-per-user, which can drift as
headcount changes - unlike Namecheap/Claude Pro's genuinely flat fee. If
wanted, add an optional "Seats x price/seat" calculator inside the Add Tool
modal's Subscription amount section: two small inputs (seat count, price per
seat) that compute and fill the existing "Monthly amount" field client-side.
No schema change needed - only the computed total is persisted, exactly as
today. Do NOT build this unless explicitly requested - it changes the form
for every Subscription tool, not just Google Workspace, and adds a UI
decision (does a Namecheap-style flat tool now see an unwanted calculator
too?) that's the user's call, not an assumed requirement.

CONSTRAINTS
- No IntegrationProvider, no Configure Integration changes - Google Workspace
  never reaches that modal in a meaningful way, exactly like Namecheap.
- Do not touch scheduler.service.ts, billing.service.ts, or the schema at
  all - the monthly rollover/billing-history path is already correct and
  already tested; this task adds a preset, not a mechanism.
```

---

## Definition of Done

1. **Dropdown**: "Google Workspace" appears in the Add Tool Integration dropdown alongside Railway, Claude, Namecheap.
2. **Auto-defaults**: selecting it sets Payment type → Subscription, Billing cycle → Monthly, locks Vendor → "Google Workspace" — verified via the same real-`ToolsService.create()` test pattern used for Namecheap (create → assert fields → clean up, no fabricated real data left behind).
3. **Dedup**: once a Google Workspace tool exists, it's disabled in the dropdown for future adds (via the existing `matchProviderByVendor`/`connectedProviders` mechanism — no new code needed, just confirm it fires).
4. **Configure Integration guard**: opening it on a Google Workspace tool shows the same "doesn't have an API to connect to" message Namecheap gets — confirms the `noApiAvailable` guard generalizes without a special case.
5. **No regression**: Railway, Claude, Namecheap, and the pro-rated monthly-spend KPI all behave identically after the change.
6. **Schema untouched**: no migration, no scheduler change — if the implementer touches either file, that's a sign of scope creep, not a requirement.
7. **Per-seat calculator**: built only if explicitly opted into Step 3 — otherwise explicitly marked "not done, by design" rather than silently skipped.

## Learnings carried over from Claude + Namecheap (apply here, don't repeat)

1. **Single source of truth, no drift.** `matchProviderByVendor()` and `INTEGRATION_PROVIDERS` already generalize correctly — this task is a pure data addition to that one list, not new matching logic in a second place (the Add Tool dropdown / dashboard dedup / Configure Integration lock already all read from the same array).
2. **Check for vendor-string collisions before adding a preset** — Railway's stored vendor turned out to be "Railway.com" not "Railway"; confirm "Google Workspace" doesn't accidentally substring-match (or get substring-matched by) any existing tool's vendor text before assuming it's safe.
3. **Don't fabricate real data.** Verify via a real tool created through the actual service method, then delete it — never leave a placeholder "Google Workspace" tool with made-up numbers in the real dashboard.
4. **Don't build the optional stretch item speculatively.** Step 3 (per-seat calculator) is flagged, not built, unless the user asks — this is exactly the kind of unrequested scope expansion that had to be reverted once already this session (the manual billing-record UI).
5. **`tsc --noEmit` clean on every change, and a full regression pass afterward** — not just the new feature in isolation.
