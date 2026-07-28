import { Logger } from '@nestjs/common';
import { IntegrationProvider } from '../provider.interface';

// Railway GraphQL API v2 — https://docs.railway.com/reference/public-api
// Rate limits: 1000 RPH / 10 RPS (Hobby) · 10000 RPH / 50 RPS (Pro)
// Internal limit: ~16-19 concurrent usage queries per client
//
// Key insight: estimatedUsage fans out to (N_projects × N_measurements) concurrent
// internal queries, whether queried per-project or workspace-wide. We query
// workspace-wide (so deleted projects are included) but ONE measurement at a time,
// keeping concurrency at N_projects — well under the limit for realistic workspaces.
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

// Path A — direct dollar total; requires workspace owner / billing scope.
// No internal metric queries triggered — always try this first.
const BILLING_QUERY = `
  query {
    me {
      workspaces {
        customer {
          currentUsage
        }
      }
    }
  }
`;

// Path B — find the token's workspace. A deleted project can't be looked up by
// projectId directly (Railway returns "Project not found" even with includeDeleted),
// so we resolve a workspaceId instead and query usage at that scope in Path C.
// Deleted projects have `workspace: null`, so this walks the (non-deleted) list
// until it finds one that resolves.
const WORKSPACE_ID_QUERY = `
  query {
    projects {
      edges {
        node {
          workspace {
            id
          }
        }
      }
    }
  }
`;

// Path C — workspace-wide resource usage, converted to USD.
// estimatedValue is in resource-unit-minutes (vCPU-min, GB-min) — NOT dollars.
// Apply Railway's per-minute rates to get cost:
//   CPU:  $20/vCPU/month  → / (30×24×60)
//   MEM:  $10/GB/month    → / (30×24×60)
//   DISK: $0.15/GB/month  → / (30×24×60)
//   NET:  $0.05/GB egress → flat per GB (not per-minute)
const MINUTES_PER_MONTH = 30 * 24 * 60; // 43 200
const RATES: Record<string, number> = {
  CPU_USAGE:       20    / MINUTES_PER_MONTH,
  MEMORY_USAGE_GB: 10    / MINUTES_PER_MONTH,
  DISK_USAGE_GB:    0.15 / MINUTES_PER_MONTH,
  NETWORK_TX_GB:    0.05,   // $/GB flat — already total GB, not per-minute
};

// The hard/soft limit we compare against (fetchLimitsUSD's usageLimit.hardLimit) is
// Railway's "Compute Usage Limit" specifically — CPU + memory only. Disk and network
// egress are billed separately and don't count against it. Summing all four measurements
// here would overstate spend relative to that limit, so only compute goes into the total.
const MEASUREMENTS = ['CPU_USAGE', 'MEMORY_USAGE_GB'];

// includeDeleted: true — a deleted project still owes for usage it incurred earlier
// in the current billing period, and Railway's own usage dashboard counts it; without
// this flag it just vanishes from the total.
//
// One call per measurement, not one call for all four: Railway fans a workspace-wide
// estimatedUsage query out internally to (N_projects × N_measurements) concurrent
// metric queries, and that blows past the ~16–19 concurrent-query limit fast once a
// workspace has more than a handful of projects. Restricting each call to a single
// measurement keeps concurrency at N_projects, which is what stays under the limit.
const WORKSPACE_USAGE_QUERY = (workspaceId: string, measurement: string) => `
  query {
    estimatedUsage(
      workspaceId: "${workspaceId}"
      includeDeleted: true
      measurements: [${measurement}]
    ) {
      estimatedValue
      measurement
      projectId
    }
  }
`;

const RATE_LIMIT_RE = /too many (metric|usage) queries/i;
const NOT_AUTHORIZED_RE = /not authorized/i;

// Fetches compute & agent usage limits from the workspace the token belongs to.
// Returns null when the token is project-scoped and cannot read workspace billing.
const WORKSPACE_LIMITS_QUERY = `
  query {
    projects {
      edges {
        node {
          workspace {
            customer {
              usageLimit {
                hardLimit
                softLimit
                agentHardLimitCents
                agentSoftLimitCents
              }
            }
          }
        }
      }
    }
  }
`;

export interface RailwayUsageLimits {
  computeHardLimitUSD: number;  // hard limit on compute ($)
  computeSoftLimitUSD: number;  // email-alert threshold ($)
  agentHardLimitUSD: number;    // agent hard limit ($)
  agentSoftLimitUSD: number;    // agent alert threshold ($)
}

export class RailwayProvider implements IntegrationProvider {
  private readonly logger = new Logger(RailwayProvider.name);

  async fetchLimitsUSD(config: Record<string, any>): Promise<RailwayUsageLimits | null> {
    const { apiToken } = config;
    if (!apiToken) return null;

    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` };
    const json = await this.gql(h, WORKSPACE_LIMITS_QUERY);
    if (this.firstError(json)) return null;

    const first = json?.data?.projects?.edges?.[0]?.node?.workspace?.customer?.usageLimit;
    if (!first) return null;

    return {
      computeHardLimitUSD:  first.hardLimit  ?? 0,
      computeSoftLimitUSD:  first.softLimit   ?? 0,
      agentHardLimitUSD:    (first.agentHardLimitCents ?? 0) / 100,
      agentSoftLimitUSD:    (first.agentSoftLimitCents ?? 0) / 100,
    };
  }

  async fetchSpendUSD(config: Record<string, any>): Promise<number> {
    const { apiToken } = config;
    if (!apiToken) throw new Error('Railway config missing apiToken');

    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    };

    // ── Path A: direct billing (workspace owner tokens) ───────────────────────
    const billingJson = await this.gql(h, BILLING_QUERY);
    const billingErr = this.firstError(billingJson);

    if (!billingErr) {
      const workspaces: any[] = billingJson?.data?.me?.workspaces ?? [];
      return workspaces.reduce(
        (sum: number, ws: any) => sum + (ws?.customer?.currentUsage ?? 0),
        0,
      );
    }

    if (!NOT_AUTHORIZED_RE.test(billingErr)) {
      throw new Error(billingErr);
    }

    this.logger.log('customer.currentUsage not authorized — switching to workspace-wide estimatedUsage');

    // ── Path B: resolve the workspace ──────────────────────────────────────────
    const workspaceId = await this.fetchWorkspaceId(h);
    if (!workspaceId) {
      throw new Error(
        'Railway API token does not have permission to read projects or billing data. ' +
          'Use a personal API token from railway.com → Account Settings → API Tokens.',
      );
    }

    // ── Path C: usage per measurement, across every project (incl. deleted) ────
    let total = 0;
    let succeeded = 0;
    for (const measurement of MEASUREMENTS) {
      const result = await this.measurementUsage(h, workspaceId, measurement);
      if (result.ok) succeeded += 1;
      total += result.amount;
    }

    // If every single measurement failed (e.g. rate-limited), `total` is not "true
    // zero usage" — it's "we learned nothing this cycle." Reporting it as $0 would
    // overwrite the last known-good spend with a false "fully paid down" state.
    // Fail the sync instead so the previous value is left untouched.
    if (succeeded === 0) {
      throw new Error('Railway estimatedUsage failed for every measurement this cycle — leaving last known spend as-is.');
    }

    return total;
  }

  /** Deleted projects resolve `workspace: null`, so this walks the list for the first hit. */
  private async fetchWorkspaceId(h: Record<string, string>): Promise<string | null> {
    const json = await this.gql(h, WORKSPACE_ID_QUERY);
    if (this.firstError(json)) return null;

    const edges: any[] = json?.data?.projects?.edges ?? [];
    for (const e of edges) {
      const id = e?.node?.workspace?.id;
      if (id) return id;
    }
    return null;
  }

  private async measurementUsage(
    h: Record<string, string>,
    workspaceId: string,
    measurement: string,
    attempt = 1,
  ): Promise<{ ok: boolean; amount: number }> {
    const resp = await fetch(RAILWAY_GQL, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ query: WORKSPACE_USAGE_QUERY(workspaceId, measurement) }),
    });

    const retryAfterHeader = resp.headers.get('Retry-After');
    const json = (await resp.json()) as any;
    const errMsg = this.firstError(json);

    if (errMsg) {
      if (RATE_LIMIT_RE.test(errMsg) && attempt === 1) {
        // Railway reports its retry window; wait the minimum of that or 8 s
        const waitMs = retryAfterHeader
          ? Math.min(Number(retryAfterHeader) * 1000, 8_000)
          : 6_000;
        this.logger.warn(
          `Railway rate limit on ${measurement} (attempt ${attempt}) — retrying in ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        return this.measurementUsage(h, workspaceId, measurement, 2);
      }

      if (RATE_LIMIT_RE.test(errMsg)) {
        // Still rate-limited after retry — skip this measurement, don't fail the whole sync
        this.logger.warn(
          `Railway rate limit persists for ${measurement} — skipping, will catch on next sync`,
        );
        return { ok: false, amount: 0 };
      }

      // Any other error on a single measurement — log and skip rather than failing everything
      this.logger.error(`Railway estimatedUsage error for ${measurement}: ${errMsg}`);
      return { ok: false, amount: 0 };
    }

    const items: any[] = json?.data?.estimatedUsage ?? [];
    const rate = RATES[measurement] ?? 0;
    const subtotal = items.reduce((sum: number, item: any) => sum + (item.estimatedValue ?? 0) * rate, 0);
    this.logger.log(`Railway ${measurement}: ${items.length} project(s) (incl. deleted), $${subtotal.toFixed(4)} USD`);
    return { ok: true, amount: subtotal };
  }

  private async gql(h: Record<string, string>, query: string, variables?: Record<string, any>): Promise<any> {
    const resp = await fetch(RAILWAY_GQL, { method: 'POST', headers: h, body: JSON.stringify({ query, variables }) });
    return resp.json();
  }

  private firstError(json: any): string | null {
    return json?.errors?.[0]?.message ?? null;
  }
}
