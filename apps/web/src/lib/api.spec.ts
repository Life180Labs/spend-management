/**
 * @jest-environment jsdom
 */
import { api } from './api';

function mockFetchResponse(opts: { status: number; body: string; ok?: boolean }) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    text: async () => opts.body,
    json: async () => JSON.parse(opts.body || 'null'),
  });
}

describe('api request()', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns null for a 200 response with a genuinely empty body (NestJS handler returning `null`, e.g. previewLimits for a provider with no fetchLimitsUSD)', async () => {
    mockFetchResponse({ status: 201, body: '' });
    const result = await api.post('/integrations/preview-limits', { provider: 'HEYGEN', config: {} });
    expect(result).toBeNull();
  });

  it('still returns null for a 204 No Content response', async () => {
    mockFetchResponse({ status: 204, body: '' });
    const result = await api.delete('/tools/t1');
    expect(result).toBeNull();
  });

  it('parses a real JSON body normally when one is present', async () => {
    mockFetchResponse({ status: 200, body: JSON.stringify({ id: 't1', name: 'Railway' }) });
    const result = await api.get<{ id: string; name: string }>('/tools/t1');
    expect(result).toEqual({ id: 't1', name: 'Railway' });
  });
});
