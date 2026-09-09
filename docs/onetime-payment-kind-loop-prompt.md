# One-Time Payment Kind — Loop Engineering Prompt + Definition of Done

## Context

Discovered via the Hostinger workaround this session: a real one-time purchase
(paid once, not recurring) has no correct home in the current `PaymentKind`
model (`PREPAID` / `MOSUB` / `CAPSUB` / `NOBUDGET`). The workaround —
`NOBUDGET` + a manually backfilled `billing_records` row — produces correct
*numbers* but a misleading *label* ("No budget configured" for a tool that
was, in fact, budgeted and paid). This adds a genuine `ONETIME` kind.

## Design decisions (made during scoping, not re-litigated per file)

1. **`renewalDate` stays null for ONETIME, always.** The alternative (reusing
   `renewalDate` to mean "date paid") would require adding a payment-kind
   filter to `checkRenewalRemindersImpl` (which today has NO such filter -
   the exact bug that would have emailed a false "renewing soon" notice for
   Hostinger). Leaving it null sidesteps that class of bug entirely - both
   `checkRenewalRemindersImpl` and `rollForwardRenewalDatesImpl` already
   ignore tools with no renewal date / wrong payment kind, so **neither
   needs to change**.
2. **The one-time amount + date is captured at creation time as a real
   `billing_records` row**, via the existing `BillingService.recordCompletedCycle`
   - not a new field, not new backfill tooling. `monthlyAmount` is reused to
   store the one-time amount (matching how `CAPSUB` already reuses it for a
   different meaning) - no new Tool column.
3. **Historical accuracy without special-casing Reports/Billing History.**
   `closedMonthTotal(ByTool)` already aggregates `billing_records` without
   checking the tool's *current* payment kind - so the one-time entry counts
   correctly in the month it happened with zero changes to reporting
   aggregation. Only the *live/current-month* contribution paths need to
   learn to treat `ONETIME` like `NOBUDGET` (contributes nothing ongoing).
4. **`ONETIME` is NOT folded into the "needs budget setup" nudge.** Unlike
   `NOBUDGET`, a one-time tool already has a real amount attached - it
   shouldn't be flagged as needing configuration.
5. **No new Dashboard tab.** Visible under "All"; not added to
   Usage-based/Subscription/Needs Budget, none of which fit it.
6. **Do NOT touch `checkRenewalRemindersImpl` or `rollForwardRenewalDatesImpl`**
   - decision 1 makes this unnecessary; touching them anyway would be scope
   creep against a working, tested cron.

## Loop Engineering Prompt

```
GOAL
Add ONETIME as a fifth PaymentKind: a real one-time purchase, captured as a
single historical billing_records entry, excluded from all recurring/live
spend calculations and from "needs budget setup" nudges, with clear "One
Time" labeling everywhere PaymentKind is displayed.

STEP 1 — SCHEMA
apps/api/prisma/schema.prisma: add ONETIME to enum PaymentKind. Hand-written
migration.sql (this project's established pattern - `prisma migrate dev` is
interactive-only) + `migrate deploy`. No default change (NOBUDGET stays the
Tool default).

STEP 2 — BACKEND: CAPTURE THE ONE-TIME PAYMENT AT CREATION
apps/api/src/tools/dto/create-tool.dto.ts: add optional `oneTimePaidAt?: string`
(ISO date). apps/api/src/tools/tools.module.ts: import BillingModule, inject
BillingService into ToolsService. In ToolsService.create(), when
dto.paymentKind === 'ONETIME': after the tool is created, call
billing.recordCompletedCycle(orgId, tool.id, monthKeyOf(oneTimePaidAt ?? now),
dto.monthlyAmount ?? 0, oneTimePaidAt ?? now) once. Reuses the exact idempotent
method already used for every manual backfill this session - do not write a
second insert path.

STEP 3 — BACKEND: EXCLUDE FROM LIVE/RECURRING CALCULATIONS
- tools/spend-math.util.ts: monthlyEquivalentSpend returns 0 for ONETIME
  (its only contribution is the historical billing_records row from Step 2,
  picked up automatically by closedMonthTotal/closedMonthTotalByTool).
- tools/tools.service.ts enrichTool(): alert flag excludes ONETIME the same
  as NOBUDGET (`!['NOBUDGET','ONETIME'].includes(paymentKind)`); buildStatusSub
  gets a ONETIME branch ("one-time purchase," no bar%).
- reports.service.ts: audit every `paymentKind !== 'NOBUDGET'` /
  `paymentKind === 'NOBUDGET'` occurrence individually - do NOT blanket-widen.
  The live-contribution exclusions (currentMonthTotalByTool's skip, the
  dashboard-kpis alert-count query) should also exclude ONETIME. The "needs
  budget setup" tool COUNT must stay NOBUDGET-only (design decision 4) - a
  one-time tool is already configured, don't flag it.
- billing.service.ts / alert.engine.ts: same "needs budget" query stays
  NOBUDGET-only, same reasoning.
- scheduler.service.ts: confirm (don't just assume) that
  checkRenewalRemindersImpl and rollForwardRenewalDatesImpl naturally skip a
  ONETIME tool (null renewalDate / wrong paymentKind respectively) - add a
  regression test proving it, per design decision 6, rather than editing them.

STEP 4 — FRONTEND: ADD TOOL MODAL
apps/web/src/components/tools/add-tool-modal.tsx:
- Payment type dropdown: add "One Time" option.
- New ONETIME-only section (add mode): "Amount ($)" (reuses monthlyAmount
  state) + "Date Paid" (new state, defaults to today) - no billing cycle, no
  renewal date, no cap/alert threshold fields.
- Edit mode: show amount + date paid as locked/read-only (matches this
  modal's existing pattern for other immutable-after-creation fields).
- Validation: amount required for ONETIME, same as capAmount is required for
  PREPAID/CAPSUB today.
- Submit payload: include monthlyAmount + oneTimePaidAt when ONETIME.

STEP 5 — FRONTEND: DASHBOARD
apps/web/src/app/(app)/dashboard/page.tsx:
- Payment badge label + color for ONETIME ("One Time").
- Budget Status column (computeRow's statusMain): ONETIME shows the paid
  amount without a "/mo" or "/cap" suffix (e.g. "$4.23 · one-time"), no bar%.
- Confirm (test, don't assume) the existing renewMain/renewSub fallback
  ('-' default) already handles ONETIME correctly with no code change, since
  it has no renewalDate and isn't PREPAID.
- Tab filters: do NOT add a new tab (design decision 5) - confirm ONETIME
  tools appear under "All" and are correctly excluded from Usage-based/
  Subscription/Needs Budget.

STEP 6 — FRONTEND: OTHER SURFACES
- apps/web/src/lib/excel.ts: PAY_LABELS gets a ONETIME entry; the '% Used'
  column's `paymentKind !== 'NOBUDGET'` check widens to also show '-' for
  ONETIME (no bar% concept, same reasoning as Step 3's tools.service.ts change).
- apps/web/src/app/(app)/alerts/page.tsx: audit its 2 references individually
  before deciding whether to widen.
- apps/web/src/lib/integration-providers.ts: widen the defaultPaymentKind
  type to include ONETIME. Do NOT default any existing provider preset to it
  (Railway/Claude/HeyGen/GCP/Namecheap/Google Workspace/Hostinger all keep
  their current defaults) - this is a manually-chosen kind, not auto-applied.

CONSTRAINTS
- Do not add a `renewalDate`-repurposing path for ONETIME (design decision 1).
- Do not touch checkRenewalRemindersImpl/rollForwardRenewalDatesImpl (design
  decision 6) - prove they already skip ONETIME correctly with a test instead.
- Do not add a new Tool column for the one-time amount - reuse monthlyAmount.
- Do not add a new Dashboard tab.
- Follow existing code style: no comments explaining what code does, only why.
- tsc --noEmit clean on both apps after every meaningful change, not just at
  the end.
```

---

## Definition of Done

1. **Schema**: `PaymentKind.ONETIME` exists via a hand-written migration; existing tools of every other kind read back unchanged.
2. **Creation flow**: adding a tool with Payment type "One Time," an amount, and a date paid creates the tool AND a matching `billing_records` row for that month in one action - verified via `psql` against a real create, not just reasoning about the code.
3. **No recurrence, ever**: a ONETIME tool contributes $0 to every month's live/current total except the one real historical month it was paid - verified for "this month," "last month," "this quarter," and "year to date."
4. **Not flagged as needing budget setup**: the "Tools Needing Budget Setup" KPI count and the alert-engine nudge both exclude ONETIME tools, same as they already exclude tools that ARE configured.
5. **No false renewal reminder**: a ONETIME tool with today's date as "date paid" does NOT trigger `checkRenewalRemindersImpl` - proven with a test, not just inferred from the null renewalDate.
6. **Dashboard**: shows "One Time" as the Payment badge, a sensible Budget Status (paid amount, no bar%/cap), "-" for Next Renewal, and appears under "All" but none of Usage-based/Subscription/Needs Budget.
7. **Reports & Billing History**: the historical payment shows up correctly in the month it happened, with correct Month/Period/Start-End Date columns (reusing the renewal-cycle-date logic already built - a ONETIME tool has no renewalDate, so it correctly falls back to calendar-month boundaries for that one row, same as any other tool with no renewal date).
8. **Excel exports**: both `Download Spend Report`/`Download Billing History` (Month/Period/Amount/Status columns) and `Download Tools List` (Payment Type label, % Used showing "-") read correctly for a ONETIME tool.
9. **No regression**: full existing test suite (both apps) still passes; every other PaymentKind's behavior is byte-for-byte unchanged (verified by re-running, not just by not touching those code paths).
10. **Full regression pass documented**: `tsc --noEmit` clean on both apps, full Jest suite green on both, with the final test counts reported.
