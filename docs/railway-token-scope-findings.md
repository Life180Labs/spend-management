# Railway API token scope — tested findings

**Use a token scoped to the workspace (e.g. "life180labs's Projects"), not
"No workspace."** This is the opposite of the general "prefer an account-level
token" advice given for other providers (HeyGen) — Railway's permission model
is inverted from that assumption.

## What was tested

Ran the real `RailwayProvider` methods (`fetchSpendUSD`, `fetchLimitsUSD`,
`fetchHistoricalSpendUSD` — not raw GraphQL guesses) against two real tokens
from the same Railway account:

| Capability | Account-scoped ("No workspace") | Workspace-scoped |
|---|---|---|
| Live spend sync | ✓ works, but only a bare total (Railway's opaque `customer.currentUsage`, no CPU/Memory/project breakdown) | ✓ works, with full breakdown + per-project data |
| Budget cap / limits sync (`fetchLimitsUSD`) | ✗ always returns `null` | ✓ real hard/soft limits |
| Usage History — Last Month / Custom (`fetchHistoricalSpendUSD`) | ✗ fails: *"Railway API token does not have permission to read projects or billing data"* | ✓ works fully |

## Why

`me.workspaces.customer.currentUsage` (the account-level billing field) and
`projects` (used to resolve a workspace ID, which `fetchLimitsUSD` and
`fetchHistoricalSpendUSD` both require) are gated by *different* scopes on
Railway's side:

- An account-scoped token ("No workspace" at creation) can read `me...` but
  the `projects` query returns an empty list — not an authorization error,
  just zero results, which is why the earlier symptom looked like "the token
  has no permission" rather than "this query returns nothing for this token."
- A workspace-scoped token cannot read `me` at all (`"Not Authorized"`) but
  `projects` returns real data, because it's scoped to see that workspace's
  content specifically.

`RailwayProvider.fetchSpendUSD` already handles this correctly without any
code change: it tries the account-level path first, and falls back to the
project/workspace-based calendar-month reconstruction if that's not
authorized — so a workspace-scoped token still gets live sync working, just
via the fallback path (Path C) instead of the direct one (Path A).

## Practical takeaway

One workspace-scoped token is sufficient for every Railway feature this app
uses. There's no need for two tokens, and no code change was required —
this was purely a "which token do I paste in" problem, not an app bug.
