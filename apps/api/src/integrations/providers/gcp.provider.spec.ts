const mockQuery = jest.fn();

jest.mock('@google-cloud/bigquery', () => ({
  BigQuery: jest.fn().mockImplementation((opts: any) => ({
    __opts: opts,
    query: mockQuery,
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
      expect(callArg.query).toContain('SUM(cost)');
      expect(callArg.query).toContain('UNNEST(credits)');
      expect(callArg.params.billingAccountId).toBe('014575-49CC35-F26E91');
      expect(typeof callArg.params.startDate).toBe('string');
      expect(typeof callArg.params.endDate).toBe('string');
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

  it('has no fetchLimitsUSD - GCP exposes no live limit-reading API', () => {
    expect((provider as any).fetchLimitsUSD).toBeUndefined();
  });
});
