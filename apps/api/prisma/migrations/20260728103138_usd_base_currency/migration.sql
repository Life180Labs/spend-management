-- USD becomes the base currency for all stored monetary amounts across the app.
-- Only `tools` and `tool_integrations` had non-null money data at the time of this
-- migration; both rows are corrected below using the real USD figures already
-- confirmed against Railway's own API (no lossy division needed). Every other
-- money-bearing table (budgets, spend_requests, billing_records, ...) was empty.

-- Drop the now-redundant USD companion columns — usedAmount/capAmount ARE USD now.
ALTER TABLE "tools" DROP COLUMN "usedAmountUSD";
ALTER TABLE "tools" DROP COLUMN "capAmountUSD";

-- Rename the INR sync-amount column to reflect the new USD base.
ALTER TABLE "tool_integrations" RENAME COLUMN "lastSyncAmountINR" TO "lastSyncAmountUSD";

-- Flip default currency for new orgs / spend requests to USD.
ALTER TABLE "organizations" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "spend_requests" ALTER COLUMN "currency" SET DEFAULT 'USD';

-- Existing org and tool data: convert the only two tools that carry real data.
-- Railway tool 2a6c18c0: confirmed live via Railway's API — hard limit $18,
-- estimated spend $16.11 at time of writing.
UPDATE "tools" SET "usedAmount" = 16.11, "capAmount" = 18
  WHERE id = '2a6c18c0-abb0-4723-bfeb-442395257443';
UPDATE "tool_integrations" SET "lastSyncAmountUSD" = 16.11
  WHERE "toolId" = '2a6c18c0-abb0-4723-bfeb-442395257443';

-- Railway tool dc2401d6: broken/misconfigured integration (bad token, never
-- synced successfully) — its stored figures were stale INR test data. Convert
-- at the FX rate already used as this app's fallback constant (94.4) since
-- there's no live authoritative USD figure to fall back on.
UPDATE "tools" SET "usedAmount" = ROUND(("usedAmount" / 94.4)::numeric, 2)::float,
                    "capAmount" = ROUND(("capAmount" / 94.4)::numeric, 2)::float
  WHERE id = 'dc2401d6-28f1-475e-bb74-d4ff4310c866';
UPDATE "tool_integrations" SET "lastSyncAmountUSD" = ROUND(("lastSyncAmountUSD" / 94.4)::numeric, 2)::float
  WHERE "toolId" = 'dc2401d6-28f1-475e-bb74-d4ff4310c866';

-- Existing org: was INR, is now considered USD-denominated going forward.
UPDATE "organizations" SET "currency" = 'USD';
