import { Logger } from '@nestjs/common';
import { IntegrationProvider, ProjectBreakdownItem, SpendResult, UsageBreakdownItem } from '../provider.interface';

// Railway GraphQL API v2 - https://docs.railway.com/reference/public-api
// Rate limits: 1000 RPH / 10 RPS (Hobby) · 10000 RPH / 50 RPS (Pro)
// Internal limit: ~16-19 concurrent usage queries per client
//
// Key insight: a workspace-wide `usage` query fans out internally to (N_projects ×
// N_measurements) concurrent metric queries. We query workspace-wide (so deleted
// projects are included) but ONE measurement at a time, keeping concurrency at
// N_projects - well under the limit for realistic workspaces.
const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

// Path A - direct dollar total; requires workspace owner / billing scope.
// No internal metric queries triggered - always try this first.
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

// Path B - find the token's workspace. A deleted project can't be looked up by
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

// Path C - workspace-wide resource usage, converted to USD.
// value is in resource-unit-minutes (vCPU-min, GB-min) - NOT dollars.
// Apply Railway's per-minute rates to get cost:
//   CPU:  $20/vCPU/month  → / (30×24×60)
//   MEM:  $10/GB/month    → / (30×24×60)
//   DISK: $0.15/GB/month  → / (30×24×60)
//   NET:  $0.05/GB egress → flat per GB (not per-minute)
const MINUTES_PER_MONTH = 30 * 24 * 60; // 43 200
const RATES: Record<string, number> = {
  CPU_USAGE: 20 / MINUTES_PER_MONTH,
  MEMORY_USAGE_GB: 10 / MINUTES_PER_MONTH,
  DISK_USAGE_GB: 0.15 / MINUTES_PER_MONTH,
  NETWORK_TX_GB: 0.05,   // $/GB flat - already total GB, not per-minute
};

// The hard/soft limit we compare against (fetchLimitsUSD's usageLimit.hardLimit) is
// Railway's "Compute Usage Limit" specifically - CPU + memory only. Disk and network
// egress are billed separately and don't count against it. Summing all four measurements
// here would overstate spend relative to that limit, so only compute goes into the total.
const MEASUREMENTS = ['CPU_USAGE', 'MEMORY_USAGE_GB'];

// Deliberately NOT using Railway's `estimatedUsage` field (their opaque "current billing
// period," anchored to whatever date Railway's own cycle resets on — not the calendar
// month). Both the live sync and the Usage History page query this same `usage(startDate,
// endDate)` field with an explicit calendar-month window, so "current month" always means
// the same thing and the two screens can never disagree about what "now" covers.
//
// includeDeleted: true - a deleted project still owes for usage it incurred earlier
// in the period, and Railway's own usage dashboard counts it; without this flag it just
// vanishes from the total.
//
// One call per measurement, not one call for all four: Railway fans a workspace-wide
// usage query out internally to (N_projects × N_measurements) concurrent metric queries,
// and that blows past the ~16–19 concurrent-query limit fast once a workspace has more
// than a handful of projects. Restricting each call to a single measurement keeps
// concurrency at N_projects, which is what stays under the limit.
const USAGE_QUERY = (workspaceId: string, measurement: string, startDate: string, endDate: string) => `
  query {
    usage(
      workspaceId: "${workspaceId}"
      startDate: "${startDate}"
      endDate: "${endDate}"
      includeDeleted: true
      measurements: [${measurement}]
    ) {
      measurement
      value
      tags {
        projectId
      }
    }
  }
`;

// Project names for the per-project breakdown — the usage query only ever returns a
// projectId, never a name, so this is a separate lookup. Paginated: Railway's `projects`
// connection returns one page by default and silently truncates past it otherwise.
const PROJECT_NAMES_QUERY = `
  query($after: String) {
    projects(after: $after, includeDeleted: true) {
      edges {
        node {
          id
          name
          deletedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
const MAX_PROJECT_PAGES = 20; // safety cap — well beyond any real workspace

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

export type HistoricalBreakdownItem = UsageBreakdownItem;

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
      computeHardLimitUSD: first.hardLimit ?? 0,
      computeSoftLimitUSD: first.softLimit ?? 0,
      agentHardLimitUSD: (first.agentHardLimitCents ?? 0) / 100,
      agentSoftLimitUSD: (first.agentSoftLimitCents ?? 0) / 100,
    };
  }

  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    const { apiToken } = config;
    if (!apiToken) throw new Error('Railway config missing apiToken');

    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    };

    // ── Path A: direct billing (workspace owner tokens) ───────────────────────
    // Only a single opaque dollar total — no per-measurement breakdown available here.
    const billingJson = await this.gql(h, BILLING_QUERY);
    const billingErr = this.firstError(billingJson);

    if (!billingErr) {
      const workspaces: any[] = billingJson?.data?.me?.workspaces ?? [];
      const amountUSD = workspaces.reduce(
        (sum: number, ws: any) => sum + (ws?.customer?.currentUsage ?? 0),
        0,
      );
      return { amountUSD };
    }

    if (!NOT_AUTHORIZED_RE.test(billingErr)) {
      throw new Error(billingErr);
    }

    this.logger.log('customer.currentUsage not authorized - switching to calendar-month usage query');

    // ── Path B: resolve the workspace ──────────────────────────────────────────
    const workspaceId = await this.fetchWorkspaceId(h);
    if (!workspaceId) {
      throw new Error(
        'Railway API token does not have permission to read projects or billing data. ' +
        'Use a personal API token from railway.com → Account Settings → API Tokens.',
      );
    }

    // ── Path C: usage from the 1st of this calendar month through now — same query
    // Usage History uses for "Current Month," so the dashboard and that page can never
    // show two different numbers for the same period.
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const { amountUSD, breakdown, byProject, succeeded } = await this.computeUsageForRange(h, workspaceId, startOfMonth, now);

    // If every single measurement failed (e.g. rate-limited), `amountUSD` is not "true
    // zero usage" - it's "we learned nothing this cycle." Reporting it as $0 would
    // overwrite the last known-good spend with a false "fully paid down" state.
    // Fail the sync instead so the previous value is left untouched.
    if (!succeeded) {
      throw new Error('Railway usage query failed for every measurement this cycle - leaving last known spend as-is.');
    }

    return { amountUSD, breakdown, byProject };
  }

  /**
   * Same underlying query as fetchSpendUSD, but for a caller-supplied window instead of
   * always "this calendar month" — used by the Usage History page for Last Month / a
   * custom range.
   *
   * Returns a per-measurement breakdown (not just the total) - the same CPU/memory
   * split we already compute internally, surfaced so the UI can show where the
   * spend actually came from instead of just a single number.
   */
  async fetchHistoricalSpendUSD(
    config: Record<string, any>,
    range: { startDate: Date; endDate: Date },
  ): Promise<{ amountUSD: number; breakdown: HistoricalBreakdownItem[]; byProject: ProjectBreakdownItem[] }> {
    const { apiToken } = config;
    if (!apiToken) throw new Error('Railway config missing apiToken');

    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` };

    const workspaceId = await this.fetchWorkspaceId(h);
    if (!workspaceId) {
      throw new Error(
        'Railway API token does not have permission to read projects or billing data. ' +
        'Use a personal API token from railway.com → Account Settings → API Tokens.',
      );
    }

    const { amountUSD, breakdown, byProject, succeeded } = await this.computeUsageForRange(h, workspaceId, range.startDate, range.endDate);

    if (!succeeded) {
      throw new Error(
        `Railway usage history failed for every measurement (${range.startDate.toISOString()} to ${range.endDate.toISOString()}) - try again shortly.`,
      );
    }

    return { amountUSD, breakdown, byProject };
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

  /** Shared by fetchSpendUSD (this month) and fetchHistoricalSpendUSD (any range) — same query, different dates. */
  private async computeUsageForRange(
    h: Record<string, string>,
    workspaceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{ amountUSD: number; breakdown: HistoricalBreakdownItem[]; byProject: ProjectBreakdownItem[]; succeeded: boolean }> {
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();

    let total = 0;
    let succeeded = 0;
    const breakdown: HistoricalBreakdownItem[] = [];
    // USD per project, summed across measurements (each with its own rate) as we go.
    const projectTotals = new Map<string, number>();

    for (const measurement of MEASUREMENTS) {
      const query = USAGE_QUERY(workspaceId, measurement, startISO, endISO);
      const result = await this.runMeasurementQuery(h, query, measurement);
      if (result.ok) succeeded += 1;
      total += result.amount;
      breakdown.push({ measurement, amountUSD: result.amount, rawValue: result.rawTotal });

      const rate = RATES[measurement] ?? 0;
      for (const [projectId, rawValue] of result.byProject) {
        projectTotals.set(projectId, (projectTotals.get(projectId) ?? 0) + rawValue * rate);
      }
    }

    let byProject: ProjectBreakdownItem[] = [];
    if (projectTotals.size > 0) {
      const names = await this.fetchProjectNames(h);
      byProject = Array.from(projectTotals.entries())
        .map(([projectId, amountUSD]) => ({
          projectId,
          projectName: names.get(projectId) ?? `Project ${projectId.slice(0, 8)}`,
          amountUSD,
        }))
        .sort((a, b) => b.amountUSD - a.amountUSD);
    }

    return { amountUSD: total, breakdown, byProject, succeeded: succeeded > 0 };
  }

  /** Maps every projectId the token can see to its name, active or deleted alike — paginated. */
  private async fetchProjectNames(h: Record<string, string>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let after: string | null = null;
    let page = 0;

    do {
      const json = await this.gql(h, PROJECT_NAMES_QUERY, { after });
      if (this.firstError(json)) break; // best-effort — fall back to short IDs for any project we can't name

      const projects = json?.data?.projects;
      const edges: any[] = projects?.edges ?? [];
      for (const e of edges) {
        const id = e?.node?.id;
        const name = e?.node?.name;
        if (id && name) names.set(id, name);
      }

      const pageInfo = projects?.pageInfo;
      after = pageInfo?.hasNextPage ? pageInfo.endCursor ?? null : null;
      page += 1;
    } while (after && page < MAX_PROJECT_PAGES);

    return names;
  }

  /** Retry/rate-limit handling for the workspace-wide usage query. */
  private async runMeasurementQuery(
    h: Record<string, string>,
    query: string,
    measurement: string,
    attempt = 1,
  ): Promise<{ ok: boolean; amount: number; rawTotal: number; byProject: Map<string, number> }> {
    const resp = await fetch(RAILWAY_GQL, { method: 'POST', headers: h, body: JSON.stringify({ query }) });

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
          `Railway rate limit on ${measurement} (attempt ${attempt}) - retrying in ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        return this.runMeasurementQuery(h, query, measurement, 2);
      }

      if (RATE_LIMIT_RE.test(errMsg)) {
        // Still rate-limited after retry - skip this measurement, don't fail the whole call
        this.logger.warn(
          `Railway rate limit persists for ${measurement} - skipping`,
        );
        return { ok: false, amount: 0, rawTotal: 0, byProject: new Map() };
      }

      // Any other error on a single measurement - log and skip rather than failing everything
      this.logger.error(`Railway usage error for ${measurement}: ${errMsg}`);
      return { ok: false, amount: 0, rawTotal: 0, byProject: new Map() };
    }

    const items: any[] = json?.data?.usage ?? [];
    const rate = RATES[measurement] ?? 0;

    const byProject = new Map<string, number>();
    let rawTotal = 0;
    for (const item of items) {
      const value = item.value ?? 0;
      rawTotal += value;
      const projectId = item?.tags?.projectId;
      if (projectId) byProject.set(projectId, (byProject.get(projectId) ?? 0) + value);
    }

    const subtotal = rawTotal * rate;
    this.logger.log(`Railway ${measurement}: ${items.length} row(s) (incl. deleted), $${subtotal.toFixed(4)} USD`);
    return { ok: true, amount: subtotal, rawTotal, byProject };
  }

  private async gql(h: Record<string, string>, query: string, variables?: Record<string, any>): Promise<any> {
    const resp = await fetch(RAILWAY_GQL, { method: 'POST', headers: h, body: JSON.stringify({ query, variables }) });
    return resp.json();
  }

  private firstError(json: any): string | null {
    return json?.errors?.[0]?.message ?? null;
  }
}
