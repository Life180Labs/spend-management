const mockQuery = jest.fn();

jest.mock('@google-cloud/bigquery', () => ({
  BigQuery: jest.fn().mockImplementation((opts: any) => ({
    __opts: opts,
    query: mockQuery,
  })),
}));

const mockGetAccessToken = jest.fn();
const mockGetClient = jest.fn();

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation((opts: any) => ({
    __opts: opts,
    getClient: mockGetClient,
  })),
}));

import { GCPProvider } from './gcp.provider';

const validKey = JSON.stringify({ client_email: 'sa@project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });

const validConfig = {
  serviceAccountJson: validKey,
  gcpProjectId: 'billing-host-project',
  datasetId: 'spend_management_dataset',
  tableName: 'gcp_billing_export_v1_014575_49CC35_F26E91',
  billingAccountId: '014575-49CC35-F26E91',
};

describe('GCPProvider', () => {
  let provider: GCPProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new GCPProvider();
    mockGetClient.mockResolvedValue({ getAccessToken: mockGetAccessToken });
    mockGetAccessToken.mockResolvedValue({ token: 'fake-access-token' });
    global.fetch = jest.fn();
  });

  describe('config validation - fails before any query', () => {
    it('throws if serviceAccountJson is missing', async () => {
      const { serviceAccountJson, ...rest } = validConfig;
      await expect(provider.fetchSpendUSD(rest)).rejects.toThrow('GCP config missing serviceAccountJson');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws if gcpProjectId is missing', async () => {
      const { gcpProjectId, ...rest } = validConfig;
      await expect(provider.fetchSpendUSD(rest)).rejects.toThrow('GCP config missing gcpProjectId');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws a clear error for malformed JSON, not a cryptic parse trace', async () => {
      await expect(provider.fetchSpendUSD({ ...validConfig, serviceAccountJson: '{not valid json' }))
        .rejects.toThrow('GCP service account JSON is invalid or incomplete');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws when the JSON is valid but missing client_email/private_key', async () => {
      await expect(provider.fetchSpendUSD({ ...validConfig, serviceAccountJson: JSON.stringify({ foo: 'bar' }) }))
        .rejects.toThrow('GCP service account JSON is invalid or incomplete');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws if datasetId is missing', async () => {
      const { datasetId, ...rest } = validConfig;
      await expect(provider.fetchSpendUSD(rest)).rejects.toThrow('GCP config missing datasetId');
    });

    it('throws if tableName is missing', async () => {
      const { tableName, ...rest } = validConfig;
      await expect(provider.fetchSpendUSD(rest)).rejects.toThrow('GCP config missing tableName');
    });

    it('throws if billingAccountId is missing', async () => {
      const { billingAccountId, ...rest } = validConfig;
      await expect(provider.fetchSpendUSD(rest)).rejects.toThrow('GCP config missing billingAccountId');
    });
  });

  describe('fetchSpendUSD', () => {
    it('sums cost and credits (net spend), querying the correct table with the correct params', async () => {
      mockQuery.mockResolvedValue([[{ net_cost: 42.5 }]]);

      const result = await provider.fetchSpendUSD(validConfig);

      expect(result.amountUSD).toBe(42.5);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArg = mockQuery.mock.calls[0][0];
      expect(callArg.query).toContain('`billing-host-project.spend_management_dataset.gcp_billing_export_v1_014575_49CC35_F26E91`');
      expect(callArg.query).toContain('SUM(');
      expect(callArg.query).toContain('cost');
      expect(callArg.query).toContain('UNNEST(credits)');
      expect(callArg.params.billingAccountId).toBe('014575-49CC35-F26E91');
      expect(typeof callArg.params.startDate).toBe('string');
      expect(typeof callArg.params.endDate).toBe('string');
    });

    it('converts cost from the billing account\'s native currency to USD per row, guarding against a missing/USD/zero conversion rate', async () => {
      // The export's `cost` is in the billing account's native currency (e.g. INR),
      // not USD - a bug this test locks in the fix for: a billing account set to a
      // non-USD currency was previously reported as if its raw local-currency total
      // were already USD (e.g. ₹5.09 shown as "$5.61").
      mockQuery.mockResolvedValue([[{ net_cost: 0.06 }]]);

      await provider.fetchSpendUSD(validConfig);

      const query = mockQuery.mock.calls[0][0].query;
      expect(query).toContain('currency_conversion_rate');
      expect(query).toMatch(/\/\s*IF\(/); // per-row division, not a single division after SUM()
      expect(query).toContain("currency = 'USD'"); // USD-native accounts skip the division (rate is often absent for them)
      expect(query).toContain('currency_conversion_rate = 0'); // guards against divide-by-zero
    });

    it('treats a null/missing net_cost result as 0, not NaN or a crash', async () => {
      mockQuery.mockResolvedValue([[{ net_cost: null }]]);
      const result = await provider.fetchSpendUSD(validConfig);
      expect(result.amountUSD).toBe(0);
    });

    it('constructs the BigQuery client with the parsed service account credentials', async () => {
      const { BigQuery } = require('@google-cloud/bigquery');
      mockQuery.mockResolvedValue([[{ net_cost: 1 }]]);

      await provider.fetchSpendUSD(validConfig);

      expect(BigQuery).toHaveBeenCalledWith({
        projectId: 'billing-host-project',
        credentials: { client_email: 'sa@project.iam.gserviceaccount.com', private_key: expect.stringContaining('BEGIN PRIVATE KEY') },
      });
    });

    it('gives a clear, actionable error when the export table does not exist yet', async () => {
      mockQuery.mockRejectedValue(new Error('Not found: Table billing-host-project:spend_management_dataset.gcp_billing_export_v1_014575_49CC35_F26E91 was not found'));

      await expect(provider.fetchSpendUSD(validConfig)).rejects.toThrow(
        /Check that BigQuery Billing Export .* is enabled/,
      );
    });

    it('wraps any other BigQuery error with context rather than leaking a raw stack trace', async () => {
      mockQuery.mockRejectedValue(new Error('Permission denied on dataset'));
      await expect(provider.fetchSpendUSD(validConfig)).rejects.toThrow('GCP billing query failed: Permission denied on dataset');
    });
  });

  describe('fetchHistoricalSpendUSD', () => {
    it('returns amountUSD from the query plus empty breakdown/byProject (not implemented in v1 - see file header comment)', async () => {
      mockQuery.mockResolvedValue([[{ net_cost: 17.63 }]]);

      const start = new Date(2026, 6, 1);
      const end = new Date(2026, 7, 3);
      const result = await provider.fetchHistoricalSpendUSD(validConfig, { startDate: start, endDate: end });

      expect(result).toEqual({ amountUSD: 17.63, breakdown: [], byProject: [] });
      const callArg = mockQuery.mock.calls[0][0];
      expect(callArg.params.startDate).toBe(start.toISOString());
      expect(callArg.params.endDate).toBe(end.toISOString());
    });
  });

  describe('fetchLimitsUSD', () => {
    function mockBudgetResponse(body: any, ok = true, status = 200) {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
    }

    it('returns null (never throws) when billingAccountId is missing - no API call attempted', async () => {
      const { billingAccountId, ...rest } = validConfig;
      const result = await provider.fetchLimitsUSD(rest);
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns null (never throws) for an invalid service account JSON', async () => {
      const result = await provider.fetchLimitsUSD({ ...validConfig, serviceAccountJson: 'not json' });
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('calls the Budget API with the correct URL, bearer token, and cloud-billing scope', async () => {
      mockBudgetResponse({ budgets: [] });

      await provider.fetchLimitsUSD(validConfig);

      const { GoogleAuth } = require('google-auth-library');
      expect(GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
        scopes: ['https://www.googleapis.com/auth/cloud-billing'],
      }));
      expect(global.fetch).toHaveBeenCalledWith(
        'https://billingbudgets.googleapis.com/v1/billingAccounts/014575-49CC35-F26E91/budgets',
        { headers: { Authorization: 'Bearer fake-access-token' } },
      );
    });

    it('returns null when no budget exists for the billing account (a normal, valid state)', async () => {
      mockBudgetResponse({ budgets: [] });
      const result = await provider.fetchLimitsUSD(validConfig);
      expect(result).toBeNull();
    });

    it('returns null when the budget is based on last-period spend rather than a fixed amount', async () => {
      mockBudgetResponse({ budgets: [{ amount: { lastPeriodAmount: {} } }] });
      const result = await provider.fetchLimitsUSD(validConfig);
      expect(result).toBeNull();
    });

    it('returns null and logs a warning on a non-ok HTTP response (e.g. missing billing.viewer role)', async () => {
      mockBudgetResponse({ error: 'PERMISSION_DENIED' }, false, 403);
      const result = await provider.fetchLimitsUSD(validConfig);
      expect(result).toBeNull();
    });

    it('returns null (not a throw) if the access token cannot be obtained', async () => {
      mockGetAccessToken.mockResolvedValue({ token: null });
      const result = await provider.fetchLimitsUSD(validConfig);
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('catches an unexpected error (e.g. network failure) and returns null rather than throwing', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
      const result = await provider.fetchLimitsUSD(validConfig);
      expect(result).toBeNull();
    });

    it('converts units+nanos to a USD amount and prefers a CURRENT_SPEND threshold rule', async () => {
      mockBudgetResponse({
        budgets: [{
          amount: { specifiedAmount: { currencyCode: 'USD', units: '500', nanos: 250000000 } },
          thresholdRules: [
            { thresholdPercent: 1.0, spendBasis: 'FORECASTED_SPEND' },
            { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
          ],
        }],
      });

      const result = await provider.fetchLimitsUSD(validConfig);

      expect(result).toEqual({
        computeHardLimitUSD: 500.25,
        computeSoftLimitUSD: 500.25 * 0.8,
        alertThresholdPct: 80,
      });
    });

    it('falls back to the first threshold rule when none is CURRENT_SPEND-basis', async () => {
      mockBudgetResponse({
        budgets: [{
          amount: { specifiedAmount: { units: '100', nanos: 0 } },
          thresholdRules: [{ thresholdPercent: 0.5, spendBasis: 'FORECASTED_SPEND' }],
        }],
      });

      const result = await provider.fetchLimitsUSD(validConfig);

      expect(result).toEqual({ computeHardLimitUSD: 100, computeSoftLimitUSD: 50, alertThresholdPct: 50 });
    });

    it('falls back to a 90% default threshold when the budget has no thresholdRules at all', async () => {
      mockBudgetResponse({
        budgets: [{ amount: { specifiedAmount: { units: '1000', nanos: 0 } }, thresholdRules: [] }],
      });

      const result = await provider.fetchLimitsUSD(validConfig);

      expect(result).toEqual({ computeHardLimitUSD: 1000, computeSoftLimitUSD: 900, alertThresholdPct: 90 });
    });

    describe('non-USD budget currency', () => {
      // Regression coverage: a budget of 1000 on an INR-native billing account is
      // ₹1,000, not $1,000 - the Budget API's amount carries no exchange rate
      // itself, so this must convert using the same currency_conversion_rate the
      // BigQuery export (and the spend query) already use for that billing account.
      it('converts a non-USD budget to USD using the export table\'s latest currency_conversion_rate', async () => {
        mockBudgetResponse({
          budgets: [{
            amount: { specifiedAmount: { currencyCode: 'INR', units: '1000' } },
            thresholdRules: [{ thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' }],
          }],
        });
        mockQuery.mockResolvedValue([[{ currency_conversion_rate: 83 }]]);

        const result = await provider.fetchLimitsUSD(validConfig);

        expect(result).toEqual({
          computeHardLimitUSD: 1000 / 83,
          computeSoftLimitUSD: (1000 / 83) * 0.5,
          alertThresholdPct: 50,
        });
        const rateQuery = mockQuery.mock.calls[0][0];
        expect(rateQuery.query).toContain('currency_conversion_rate');
        expect(rateQuery.query).toContain('ORDER BY usage_start_time DESC');
        expect(rateQuery.params.billingAccountId).toBe('014575-49CC35-F26E91');
      });

      it('does not query for a conversion rate when the budget is already USD', async () => {
        mockBudgetResponse({
          budgets: [{ amount: { specifiedAmount: { currencyCode: 'USD', units: '500' } }, thresholdRules: [] }],
        });

        const result = await provider.fetchLimitsUSD(validConfig);

        expect(result?.computeHardLimitUSD).toBe(500);
        expect(mockQuery).not.toHaveBeenCalled();
      });

      it('falls back to null (manual cap entry) when no conversion rate can be found for a non-USD budget', async () => {
        mockBudgetResponse({
          budgets: [{ amount: { specifiedAmount: { currencyCode: 'INR', units: '1000' } }, thresholdRules: [] }],
        });
        mockQuery.mockResolvedValue([[]]); // no rows - export table has no data yet for this account

        const result = await provider.fetchLimitsUSD(validConfig);

        expect(result).toBeNull();
      });

      it('falls back to null if the conversion-rate lookup itself fails (e.g. BigQuery error)', async () => {
        mockBudgetResponse({
          budgets: [{ amount: { specifiedAmount: { currencyCode: 'INR', units: '1000' } }, thresholdRules: [] }],
        });
        mockQuery.mockRejectedValue(new Error('permission denied'));

        const result = await provider.fetchLimitsUSD(validConfig);

        expect(result).toBeNull();
      });
    });
  });
});
