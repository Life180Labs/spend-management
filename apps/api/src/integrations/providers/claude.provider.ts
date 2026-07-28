import { Logger } from '@nestjs/common';
import { IntegrationProvider, ProjectBreakdownItem, SpendResult, UsageBreakdownItem } from '../provider.interface';

// Anthropic Admin API - Cost Report - https://platform.claude.com/docs/en/api/usage-cost-api
// Requires an Admin API key (sk-ant-admin01-...), distinct from a regular ANTHROPIC_API_KEY.
// This reports Anthropic's own record of the org's Claude API spend - it never calls the
// Messages API itself.
const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const ANTHROPIC_VERSION = '2023-06-01';

// Daily buckets are the only granularity the cost endpoint supports (bucket_width=1d).
// group_by=description is what populates the `model` field per result - without it,
// model is always null - and group_by=workspace_id is what populates workspace_id
// (Anthropic's equivalent of Railway's "project"). Both together give us both breakdowns
// in a single paginated query, mirroring how Railway's computeUsageForRange produces
// its measurement breakdown and byProject breakdown from one query shape.
const MAX_PAGES = 50; // safety cap - well beyond any realistic date range's page count

interface CostReportResultItem {
  amount: string;
  currency: string;
  description: string | null;
  model: string | null;
  workspace_id: string | null;
}

interface CostReportResponse {
  data: { starting_at: string; ending_at: string; results: CostReportResultItem[] }[];
  has_more: boolean;
  next_page: string | null;
}

export class ClaudeProvider implements IntegrationProvider {
  private readonly logger = new Logger(ClaudeProvider.name);

  // Anthropic's cost API has no exposed spend-limit/budget endpoint (org spend limits are
  // configured in the Console, not readable via the Admin API as of this writing) - so
  // this is intentionally omitted rather than stubbed. Tool.capAmount stays whatever the
  // user configures manually, same as any tool with no fetchLimitsUSD.

  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Same query shape as fetchHistoricalSpendUSD, just a different date range - so
    // "current month" always means the same thing on the dashboard and Usage History,
    // for the same reason Railway's provider unifies these two call sites.
    const { amountUSD, breakdown, byProject, succeeded } = await this.computeCostForRange(config, startOfMonth, now);

    if (!succeeded) {
      throw new Error('Anthropic cost report query failed - leaving last known spend as-is.');
    }

    return { amountUSD, breakdown, byProject };
  }

  async fetchHistoricalSpendUSD(
    config: Record<string, any>,
    range: { startDate: Date; endDate: Date },
  ): Promise<{ amountUSD: number; breakdown: UsageBreakdownItem[]; byProject: ProjectBreakdownItem[] }> {
    const { amountUSD, breakdown, byProject, succeeded } = await this.computeCostForRange(config, range.startDate, range.endDate);

    if (!succeeded) {
      throw new Error(
        `Anthropic cost report failed (${range.startDate.toISOString()} to ${range.endDate.toISOString()}) - try again shortly.`,
      );
    }

    return { amountUSD, breakdown, byProject };
  }

  private async computeCostForRange(
    config: Record<string, any>,
    startDate: Date,
    endDate: Date,
  ): Promise<{ amountUSD: number; breakdown: UsageBreakdownItem[]; byProject: ProjectBreakdownItem[]; succeeded: boolean }> {
    const { adminApiKey } = config;
    if (!adminApiKey) throw new Error('Claude config missing adminApiKey');

    const headers = {
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': adminApiKey,
    };

    const params = new URLSearchParams({
      starting_at: startDate.toISOString(),
      ending_at: endDate.toISOString(),
      bucket_width: '1d',
      limit: '31',
    });
    params.append('group_by[]', 'description');
    params.append('group_by[]', 'workspace_id');

    let total = 0;
    // amountUSD per model, summed across daily buckets/pages as we page through.
    const modelTotals = new Map<string, number>();
    // amountUSD per workspace ("project" in this app's terms), summed the same way.
    const workspaceTotals = new Map<string, number>();
    let succeeded = false;
    let page: string | null = null;
    let pageCount = 0;

    do {
      const query = new URLSearchParams(params);
      if (page) query.set('page', page);

      let json: CostReportResponse;
      try {
        json = await this.fetchPage(headers, query);
      } catch (err: any) {
        if (succeeded) break; // partial data from earlier pages is still usable
        this.logger.error(`Anthropic cost report request failed: ${err.message}`);
        throw err;
      }

      succeeded = true;
      for (const bucket of json.data ?? []) {
        for (const result of bucket.results ?? []) {
          const amountUSD = Number(result.amount) / 100; // amount is in cents (decimal string)
          total += amountUSD;

          const modelKey = result.model ?? 'unattributed';
          modelTotals.set(modelKey, (modelTotals.get(modelKey) ?? 0) + amountUSD);

          const workspaceKey = result.workspace_id ?? 'default';
          workspaceTotals.set(workspaceKey, (workspaceTotals.get(workspaceKey) ?? 0) + amountUSD);
        }
      }

      page = json.has_more ? json.next_page : null;
      pageCount += 1;
    } while (page && pageCount < MAX_PAGES);

    const breakdown: UsageBreakdownItem[] = Array.from(modelTotals.entries())
      .map(([measurement, amountUSD]) => ({ measurement, amountUSD, rawValue: amountUSD }))
      .sort((a, b) => b.amountUSD - a.amountUSD);

    const byProject: ProjectBreakdownItem[] = Array.from(workspaceTotals.entries())
      .map(([workspaceId, amountUSD]) => ({
        projectId: workspaceId,
        projectName: workspaceId === 'default' ? 'Default workspace' : workspaceId,
        amountUSD,
      }))
      .sort((a, b) => b.amountUSD - a.amountUSD);

    this.logger.log(`Anthropic cost report: $${total.toFixed(4)} USD across ${modelTotals.size} model(s), ${pageCount} page(s)`);

    return { amountUSD: total, breakdown, byProject, succeeded };
  }

  private async fetchPage(headers: Record<string, string>, query: URLSearchParams): Promise<CostReportResponse> {
    const resp = await fetch(`${COST_REPORT_URL}?${query.toString()}`, { headers });
    const json = (await resp.json()) as any;

    if (!resp.ok) {
      const message = json?.error?.message ?? `HTTP ${resp.status}`;
      throw new Error(message);
    }

    return json as CostReportResponse;
  }
}
