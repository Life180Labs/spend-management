import { Logger } from '@nestjs/common';
import { BigQuery } from '@google-cloud/bigquery';
import { GoogleAuth } from 'google-auth-library';
import { IntegrationProvider, SpendResult, UsageBreakdownItem, ProjectBreakdownItem } from '../provider.interface';

// GCP has no live "current spend" API at all - the Cloud Billing Budget API only
// manages alerts (Pub/Sub push notifications), it has no pollable read endpoint
// for SPEND. The only programmatic path to cost data is BigQuery Billing Export:
// a DAILY BATCH table the billing account owner enables in the GCP Console (cannot
// be automated), with a few-hours-to-5-days lag before data fully settles. This
// provider queries that exported table via SQL - there is no simpler "get spend"
// call to make. See docs/gcp-billing-integration-loop-prompt.md for the full
// research and setup steps.
//
// fetchLimitsUSD below reads the BUDGET's CONFIGURATION (not spend) via the
// separate Cloud Billing Budget REST API (billingbudgets.googleapis.com), which
// DOES support a plain read (GetBudget/ListBudgets) distinct from its alerting
// mechanism - requires the service account to additionally hold roles/billing.viewer
// on the billing account (narrower than the bigquery.dataViewer/jobUser roles used
// for cost data) and the billingbudgets.googleapis.com API enabled on the project.
//
// Deliberately NOT returning a per-project/per-SKU breakdown in v1 - the exported
// schema's nested field shapes (project.id, sku.description, etc.) are documented
// by Google but have not been verified against a real live export table yet (no
// GCP credentials were available at implementation time - see the Definition of
// Done in the loop-engineering doc, which explicitly calls out schema verification
// against a real table as a required follow-up before this is considered fully
// shipped). Keeping the query to a single SUM() minimizes the surface area of
// unverified-schema code; breakdown can be added once the real table is queryable.

// Local YYYY-MM-DD for log readability only - toISOString() converts to UTC first,
// which in a timezone ahead of UTC (e.g. IST) can shift the displayed calendar day
// backward by one. The actual query params always use the full ISO timestamp, so
// this only affects what a human reads in the log, not query correctness.
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface GCPConfig {
  serviceAccountJson: string; // the full JSON key file contents, pasted as text
  gcpProjectId: string;       // project hosting the BigQuery dataset
  datasetId: string;
  tableName: string;
  billingAccountId: string;
}

export class GCPProvider implements IntegrationProvider {
  private readonly logger = new Logger(GCPProvider.name);

  async fetchSpendUSD(config: Record<string, any>): Promise<SpendResult> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const amountUSD = await this.queryCost(config, startOfMonth, now);
    return { amountUSD };
  }

  async fetchHistoricalSpendUSD(
    config: Record<string, any>,
    range: { startDate: Date; endDate: Date },
  ): Promise<{ amountUSD: number; breakdown: UsageBreakdownItem[]; byProject: ProjectBreakdownItem[] }> {
    const amountUSD = await this.queryCost(config, range.startDate, range.endDate);
    return { amountUSD, breakdown: [], byProject: [] };
  }

  // Reads the CONFIGURED budget (amount + alert threshold) from the Cloud
  // Billing Budget API - a completely different endpoint from the BigQuery
  // export used for spend, requiring the service account to additionally hold
  // roles/billing.viewer on the billing account. Returns null (never throws)
  // whenever it can't determine a budget - a missing/misconfigured budget
  // lookup should never block connecting the integration, since the manual
  // capAmount fallback covers that case. Shape matches Railway's fetchLimitsUSD
  // (computeHardLimitUSD/computeSoftLimitUSD/alertThresholdPct) so the same
  // frontend "Connect account" flow works unmodified for both providers.
  async fetchLimitsUSD(config: Record<string, any>): Promise<Record<string, any> | null> {
    const { billingAccountId } = config as GCPConfig;
    if (!billingAccountId) return null;

    let credentials: { client_email: string; private_key: string };
    try {
      credentials = this.parseCredentials(config);
    } catch {
      return null;
    }

    try {
      const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-billing'] });
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      if (!token) return null;

      const res = await fetch(`https://billingbudgets.googleapis.com/v1/billingAccounts/${billingAccountId}/budgets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        this.logger.warn(`GCP budget lookup failed (${res.status}): ${await res.text()}`);
        return null;
      }

      const data: any = await res.json();
      const budget = data?.budgets?.[0];
      const specifiedAmount = budget?.amount?.specifiedAmount;
      if (!specifiedAmount) return null; // no budget configured, or it's based on last-period spend rather than a fixed amount

      let computeHardLimitUSD = Number(specifiedAmount.units ?? 0) + (specifiedAmount.nanos ?? 0) / 1e9;

      // The Budget API's amount is in the billing account's own currency (e.g. a
      // budget of 1000 on an INR-native account is ₹1,000, not $1,000) - the API
      // itself carries no exchange rate, unlike the BigQuery export. Reuse the
      // export's own currency_conversion_rate (the same Google-set rate the spend
      // query converts with - see queryCost) so both numbers stay consistent with
      // each other, rather than pulling in a different/unrelated rate source.
      const currencyCode: string | undefined = specifiedAmount.currencyCode;
      if (currencyCode && currencyCode !== 'USD') {
        const rate = await this.getLatestConversionRate(config);
        if (!rate) {
          this.logger.warn(
            `GCP budget is in ${currencyCode} but no currency_conversion_rate found in the billing export to convert it to USD - falling back to manual cap entry`,
          );
          return null;
        }
        computeHardLimitUSD = computeHardLimitUSD / rate;
      }

      // Prefer a CURRENT_SPEND-basis rule (vs FORECASTED_SPEND) since that's what
      // this app's own usedAmount tracks; fall back to whichever rule exists, or
      // GCP Console's own default alert threshold (90%) if none is configured.
      const rules = budget.thresholdRules ?? [];
      const rule = rules.find((r: any) => r.spendBasis === 'CURRENT_SPEND') ?? rules[0];
      const thresholdFraction = rule?.thresholdPercent ?? 0.9;

      return {
        computeHardLimitUSD,
        computeSoftLimitUSD: computeHardLimitUSD * thresholdFraction,
        alertThresholdPct: Math.round(thresholdFraction * 100),
      };
    } catch (err: any) {
      this.logger.warn(`GCP budget lookup failed: ${err.message}`);
      return null;
    }
  }

  // Most recent currency_conversion_rate for this billing account from the
  // BigQuery export - used to convert a non-USD Budget amount (see
  // fetchLimitsUSD) to USD using the same Google-set rate the spend query
  // itself converts with. Never throws - a failure here just means the budget
  // lookup falls back to manual cap entry, same as any other missing budget.
  private async getLatestConversionRate(config: Record<string, any>): Promise<number | null> {
    const { datasetId, tableName, billingAccountId, gcpProjectId } = config as GCPConfig;
    if (!datasetId || !tableName || !gcpProjectId) return null;

    try {
      const bigquery = this.buildClient(config);
      const [rows] = await bigquery.query({
        query: `
          SELECT currency_conversion_rate
          FROM \`${gcpProjectId}.${datasetId}.${tableName}\`
          WHERE billing_account_id = @billingAccountId AND currency_conversion_rate IS NOT NULL
          ORDER BY usage_start_time DESC
          LIMIT 1
        `,
        params: { billingAccountId },
      });
      const rate = rows?.[0]?.currency_conversion_rate;
      return typeof rate === 'number' && rate > 0 ? rate : null;
    } catch (err: any) {
      this.logger.warn(`Could not look up currency_conversion_rate for GCP budget conversion: ${err.message}`);
      return null;
    }
  }

  private parseCredentials(config: Record<string, any>): { client_email: string; private_key: string } {
    const { serviceAccountJson } = config as GCPConfig;
    if (!serviceAccountJson) throw new Error('GCP config missing serviceAccountJson');
    try {
      const parsed = JSON.parse(serviceAccountJson);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('missing client_email or private_key');
      }
      return { client_email: parsed.client_email, private_key: parsed.private_key };
    } catch (err: any) {
      throw new Error(`GCP service account JSON is invalid or incomplete: ${err.message}`);
    }
  }

  private buildClient(config: Record<string, any>): BigQuery {
    const { gcpProjectId } = config as GCPConfig;
    if (!gcpProjectId) throw new Error('GCP config missing gcpProjectId');
    const credentials = this.parseCredentials(config);
    return new BigQuery({ projectId: gcpProjectId, credentials });
  }

  private async queryCost(config: Record<string, any>, startDate: Date, endDate: Date): Promise<number> {
    const { datasetId, tableName, billingAccountId } = config as GCPConfig;
    if (!datasetId) throw new Error('GCP config missing datasetId');
    if (!tableName) throw new Error('GCP config missing tableName');
    if (!billingAccountId) throw new Error('GCP config missing billingAccountId');

    const bigquery = this.buildClient(config);
    const { gcpProjectId } = config as GCPConfig;

    // Net spend = cost minus credits (credits are stored as an array of negative
    // amounts in the standard billing export schema) - a straight SUM(cost) alone
    // overstates spend whenever a credit (e.g. a committed-use discount) applies.
    //
    // `cost` (and `credits.amount`) are in the billing account's NATIVE currency
    // (per `currency`), not USD - e.g. a billing account set to INR exports costs
    // in rupees, not dollars. `currency_conversion_rate` is the USD-to-local-currency
    // rate, so USD = cost / currency_conversion_rate. Converting PER ROW (not after
    // summing) because the rate is a daily snapshot and can drift slightly day to
    // day. Guarded against div-by-zero/null for USD-native accounts, where the rate
    // is typically absent or 1.
    const query = `
      SELECT
        SUM(
          (cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0))
          / IF(currency IS NULL OR currency = 'USD' OR currency_conversion_rate IS NULL OR currency_conversion_rate = 0, 1, currency_conversion_rate)
        ) AS net_cost
      FROM \`${gcpProjectId}.${datasetId}.${tableName}\`
      WHERE billing_account_id = @billingAccountId
        AND usage_start_time >= @startDate
        AND usage_start_time < @endDate
    `;

    try {
      const [rows] = await bigquery.query({
        query,
        params: { billingAccountId, startDate: startDate.toISOString(), endDate: endDate.toISOString() },
      });
      const netCost = rows?.[0]?.net_cost;
      const amountUSD = typeof netCost === 'number' ? netCost : 0;
      this.logger.log(`GCP billing export: $${amountUSD.toFixed(2)} for ${toLocalDateStr(startDate)} to ${toLocalDateStr(endDate)}`);
      return amountUSD;
    } catch (err: any) {
      const msg: string = err.message || '';
      if (/not found/i.test(msg)) {
        throw new Error(
          `BigQuery table not found (${gcpProjectId}.${datasetId}.${tableName}). Check that BigQuery Billing Export ` +
          `("Standard usage cost") is enabled in the GCP Console and allow a few hours - up to 5 days - for data to appear.`,
        );
      }
      throw new Error(`GCP billing query failed: ${msg}`);
    }
  }
}
