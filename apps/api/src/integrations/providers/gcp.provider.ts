import { Logger } from '@nestjs/common';
import { BigQuery } from '@google-cloud/bigquery';
import { IntegrationProvider, SpendResult, UsageBreakdownItem, ProjectBreakdownItem } from '../provider.interface';

// GCP has no live "current spend" API at all - the Cloud Billing Budget API only
// manages alerts (Pub/Sub push notifications), it has no pollable read endpoint.
// The only programmatic path to cost data is BigQuery Billing Export: a DAILY BATCH
// table the billing account owner enables in the GCP Console (cannot be automated),
// with a few-hours-to-5-days lag before data fully settles. This provider queries
// that exported table via SQL - there is no simpler "get spend" call to make.
// See docs/gcp-billing-integration-loop-prompt.md for the full research and setup steps.
//
// Deliberately NOT implementing fetchLimitsUSD - no live limit-reading API exists
// (same reasoning as Claude/HeyGen). Budget cap stays user-configured manually.
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

  private buildClient(config: Record<string, any>): BigQuery {
    const { serviceAccountJson, gcpProjectId } = config as GCPConfig;
    if (!serviceAccountJson) throw new Error('GCP config missing serviceAccountJson');
    if (!gcpProjectId) throw new Error('GCP config missing gcpProjectId');

    let credentials: { client_email: string; private_key: string };
    try {
      const parsed = JSON.parse(serviceAccountJson);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('missing client_email or private_key');
      }
      credentials = { client_email: parsed.client_email, private_key: parsed.private_key };
    } catch (err: any) {
      throw new Error(`GCP service account JSON is invalid or incomplete: ${err.message}`);
    }

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
    const query = `
      SELECT
        SUM(cost) + IFNULL(SUM((SELECT SUM(c.amount) FROM UNNEST(credits) AS c)), 0) AS net_cost
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
