# Namecheap Subscription Integration — Loop Engineering Prompt + Definition of Done

## Context

Namecheap here means the same thing Claude Pro did: a **flat-fee subscription
tracked manually**, not a live spend-metered API integration. Namecheap doesn't
expose a billing/invoice API worth building a provider around (its API is
domain/DNS management, not a cost report), so this isn't an `IntegrationProvider`
like Railway/Claude Console — it's an extension of the **manual subscription +
auto-renewal system** already built for Claude Pro.

The one real wrinkle: that system currently only understands **monthly**
cycles. `Tool.renewalDate` rolls forward by whole months
(`SchedulerService.rollForwardRenewalDates` → `advanceMonthlyUntilAfter`), and
`Tool.monthlyAmount` / the `MOSUB` payment kind both bake in a monthly
assumption. Namecheap renews **yearly**, so the cadence needs to become a
first-class, explicit concept rather than assumed.

---

## Loop Engineering Prompt

```
GOAL
Support yearly-cadence manual subscriptions (starting with a Namecheap domain/
hosting renewal), reusing the manual-subscription + auto-renewal infrastructure
built for Claude Pro, generalized to handle "every N months" instead of
hardcoding "every 1 month."

ARCHITECTURAL DECISION (do this, don't add a new PaymentKind)
Do NOT add a new PaymentKind enum value (e.g. "YEARSUB"). PaymentKind
(PREPAID/CAPSUB/MOSUB/NOBUDGET) already answers "how is this tool budgeted,"
and is checked in many scattered places (dashboard tab filters, tools.service.ts
buildStatusSub, billing.service.ts's usageBased check, add-tool-modal's payment
type selector, alert.engine.ts). Adding a fourth value means finding and
updating every one of those call sites - exactly the kind of hardcoding bug
this app has repeatedly had to fix this session (see: the Usage History
dropdown, the Add Tool Integration dropdown, the per-tool provider lock).
Instead, add an orthogonal field that only the (few) renewal-cadence-aware
call sites need to know about:

  Tool.billingCycle: enum { MONTHLY, YEARLY } @default(MONTHLY)

MOSUB/CAPSUB tools keep meaning "this is a subscription" exactly as today;
billingCycle only answers "how often does it renew." Every existing
PaymentKind check in the codebase is untouched and still correct.

STEP 0 — CONFIRM THIS TOOL IS MANUAL-ONLY (quick, but don't skip)
Namecheap's public API (api.namecheap.com) is domain/DNS management, not
billing/cost reporting, and requires IP-whitelisting for API access - it is
not a reasonable fit for an IntegrationProvider the way Railway/Claude
Console are. Confirm this assumption holds (a quick check of Namecheap's API
docs is enough) before writing any provider code. If it turns out Namecheap
does expose an accessible order/invoice history endpoint and the user
explicitly wants it wired up as a live integration instead of manual entry,
stop and treat that as a different, larger task - it would need its own
IntegrationProvider following the Railway/Claude pattern in
apps/api/src/integrations/providers/, not the manual-subscription path this
prompt covers.

STEP 1 — SCHEMA
Add to the Tool model in apps/api/prisma/schema.prisma:
  enum BillingCycle {
    MONTHLY
    YEARLY
  }
  ...
  billingCycle BillingCycle @default(MONTHLY)
Write the migration by hand (this project's established pattern - `prisma
migrate dev` is interactive-only and fails non-interactively; use a
hand-written migration.sql + `migrate deploy`, matching how the USD-base-
currency migration was done earlier). The DEFAULT MONTHLY clause means
every existing tool (Claude, Railway) backfills correctly with no data
migration needed beyond the column add.

STEP 2 — GENERALIZE THE ROLLOVER CRON
File: apps/api/src/scheduler/scheduler.service.ts
Rename/generalize the private helper:
  advanceMonthlyUntilAfter(date, untilAfter)
    → advancePeriodUntilAfter(date, untilAfter, cycle: 'MONTHLY' | 'YEARLY')
For MONTHLY, behavior is unchanged (add 1 month per step, clamp day to the
target month's length - e.g. Jan 31 → Feb 28).
For YEARLY, add 1 year per step, clamping Feb 29 → Feb 28 on non-leap years
(the equivalent day-length clamp, just at year granularity instead of month).
Update rollForwardRenewalDates():
  - Its query already filters `paymentKind: { in: ['MOSUB', 'CAPSUB'] }` -
    keep that, just also select `billingCycle` and pass it into
    advancePeriodUntilAfter per tool.
  - Each completedCycles entry still gets logged via
    billing.recordCompletedCycle() exactly as today - a yearly renewal
    produces ONE BillingRecord per year it steps past, not twelve. Verify
    this explicitly: a tool whose renewalDate is 14 months in the past should
    produce exactly 1 completed cycle (not "however many months have
    passed"), because completedCycles is built by the YEARLY-stepped loop,
    not a monthly one.

STEP 3 — RENEWAL REMINDER CRON
File: same file, checkRenewalReminders(). This already operates purely on
renewalDate + a fixed 5-day lookahead window - it doesn't know or care about
cycle length. Confirm it needs NO changes; if you find yourself editing it,
that's a sign billingCycle leaked somewhere it shouldn't have.

STEP 4 — FRONTEND: ADD TOOL MODAL
File: apps/web/src/components/tools/add-tool-modal.tsx
When Payment type = Subscription, add a "Billing cycle" selector (Monthly /
Yearly toggle, same visual pattern as the existing Connect account / Manual
setup toggle) next to the Monthly amount field. Relabel the amount field's
helper text dynamically ("per month" vs "per year") based on the selection -
do NOT rename the underlying `monthlyAmount` API field/column in this pass
(that's a larger, separately-scoped rename touching many files); just make
the UI honest about what the number represents for a yearly tool.
Submit payload adds `billingCycle` alongside the existing fields.
Since Namecheap has no IntegrationProvider, it is added purely via Manual
setup - it never appears in the Integration dropdown (INTEGRATION_PROVIDERS
in apps/web/src/lib/integration-providers.ts is untouched by this task).

STEP 5 — DISPLAY: DASHBOARD BUDGET STATUS LABEL
File: apps/web/src/app/(app)/dashboard/page.tsx and/or
apps/api/src/tools/tools.service.ts (buildStatusSub)
Wherever a subscription tool's amount is rendered with a hardcoded "/ mo"
suffix, branch on billingCycle to show "/ yr" for yearly tools. Find every
such hardcoded suffix - do not fix only the one you happen to spot first.

STEP 6 — BACKFILL (if the user wants Namecheap's past renewal history shown)
If there's a known prior renewal date/amount to seed, this is the same kind
of one-off as apps/api/scripts/backfill-billing.ts - reuse that pattern
(direct Prisma insert into billing_records via billing.recordCompletedCycle,
respecting the (orgId, toolId, monthKey) unique constraint) rather than
building new backfill tooling.

CONSTRAINTS
- Do not build an IntegrationProvider for Namecheap unless Step 0 concludes
  otherwise and the user explicitly asks for it.
- Do not add a new PaymentKind value - use billingCycle as specified.
- Preserve exact current behavior for MONTHLY tools (Claude Pro, and any
  future monthly subscription) - this is a pure generalization, not a
  rewrite of the monthly path.
- Follow existing code style: no comments explaining what code does, only
  why (matches this codebase's convention throughout scheduler.service.ts,
  the provider files, etc.).
```

---

## Definition of Done

1. **Schema**: `Tool.billingCycle` (`MONTHLY` | `YEARLY`, default `MONTHLY`) exists via a hand-written migration; existing Claude/Railway rows read back as `MONTHLY` with no manual data fix needed.
2. **Add Tool**: creating a Subscription-type tool lets you pick Monthly or Yearly billing cycle; Namecheap can be added with Vendor "Namecheap", Payment type Subscription, Billing cycle Yearly, an annual amount, and a renewal date — entirely through Manual setup, no integration/API key involved.
3. **Rollover correctness**: a yearly tool's `renewalDate` advances by exactly one year (not one month) once it passes, with Feb 29 clamped sensibly on non-leap years — verified with the same kind of date-math sanity check used for the monthly cron (Jan 31 → Feb 28 equivalent, at year granularity).
4. **No duplicate billing records**: a yearly renewal produces exactly **one** `BillingRecord` per elapsed year — not twelve monthly entries, not zero.
5. **Renewal reminder unaffected**: the 5-day-out reminder email fires correctly for a yearly tool exactly like it does for a monthly one — confirms `checkRenewalReminders` needed no changes.
6. **Dashboard label honesty**: a yearly tool's budget status shows "$X / yr", not "$X / mo" — every hardcoded "/ mo" suffix in the tool-row rendering path has been located and branched, not just one instance.
7. **Billing History**: once Namecheap's renewal cycle completes (or is backfilled), it shows up in Reports → Billing History like any other tool, correctly labeled by the month it renewed in.
8. **No regression**: Claude Pro's existing monthly rollover + billing-record logging still behaves identically post-change (re-verify manually, same as the provider-dispatch generalization was re-verified against Railway earlier).
9. **No live integration built** unless Step 0's Namecheap-API check turned up something real and the user explicitly asked for it — confirmed in the PR/change description, same as the Claude integration's Step 0 confirmation was documented.

---

## Learnings carried over from the Claude integration (apply here, don't repeat)

These are mistakes made and fixed during the Claude/Anthropic integration work
in this project. Explicitly checked against during Namecheap implementation:

1. **Hardcoded provider/kind checks leak.** `integrations.service.ts` originally
   hardcoded `provider !== 'RAILWAY'` in three places; had to be generalized to
   a `PROVIDERS` map lookup after Claude was added. Lesson applied here: use
   `billingCycle` as a generic field checked in the few cadence-aware places,
   not a new enum value that fans out across every `paymentKind` check.
2. **A dropdown/selector that lets you pick something invalid for the current
   context is a real bug, not a cosmetic one.** The Configure Integration
   modal originally let any tool pick any provider (Railway ↔ Claude),
   which would silently sync the wrong provider's spend into the wrong tool.
   Applied here: Namecheap must never appear in `INTEGRATION_PROVIDERS` /
   the Integration dropdown at all, since it has no provider - don't give the
   UI a way to imply otherwise.
3. **"Already exists" checks must key off real-world identity (vendor), not
   just technical state (active integration).** The Add Tool dropdown only
   blocked re-adding a provider with an *active integration*, missing tools
   added manually (Claude Pro). Applied here: this doesn't directly apply to
   Namecheap (no provider entry to dedup), but the same principle means: if
   the user later adds a second Namecheap-billed domain, don't assume "one
   Namecheap tool" the way the provider dedup assumes "one Railway tool" -
   Namecheap has no such uniqueness constraint, so no dedup logic should be
   added for it.
4. **Name things for what they'll become, not just what they are today.**
   `recordAutoRenewal` had to be renamed to `recordCompletedCycle` once it
   was reused for usage-based tools too. Applied here: the cron helper is
   named `advancePeriodUntilAfter` from the start (not
   `advanceMonthlyUntilAfter` with a yearly special-case bolted on later).
5. **Grep for every occurrence of a hardcoded assumption, don't fix the first
   one you find.** Applied here: Step 5 explicitly calls out finding every
   "/ mo" suffix, not just the one on the dashboard tool row.
6. **Verify with the actual DB, not just reasoning about the code.** The
   Railway backfill was checked against real `psql` queries before and after.
   Applied here: after implementation, the yearly-rollover logic should be
   validated with the same kind of direct date-math sanity script used for
   the Claude Pro rollover (`node -e "..."`), plus a real Namecheap tool row
   created and inspected via `psql` before shipping.
7. **`tsc --noEmit` after every change, both apps.** No exceptions.
