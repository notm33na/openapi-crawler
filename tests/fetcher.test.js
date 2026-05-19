import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: { get: jest.fn() },
}));

const axios = (await import('axios')).default;
const { fetchWithETag, githubApiLimiter } = await import('../src/fetcher.js');

// Stop the Bottleneck interval timer so Jest can exit cleanly
afterAll(async () => {
  await githubApiLimiter.stop({ dropWaitingJobs: false });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOkResponse(overrides = {}) {
  return {
    status: 200,
    headers: {},
    data: 'openapi: 3.0.0',
    ...overrides,
  };
}

// ── fetchWithETag ─────────────────────────────────────────────────────────────

describe('fetchWithETag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  describe('If-Modified-Since header', () => {
    it('sends If-Modified-Since when storedLastModified is provided', async () => {
      const lm = 'Thu, 01 Jan 2026 00:00:00 GMT';
      axios.get.mockResolvedValue(makeOkResponse({ headers: { 'last-modified': lm } }));

      await fetchWithETag('https://example.com/spec.yaml', null, lm);

      expect(axios.get.mock.calls[0][1].headers['If-Modified-Since']).toBe(lm);
    });

    it('does not send If-Modified-Since when storedLastModified is null', async () => {
      axios.get.mockResolvedValue(makeOkResponse());

      await fetchWithETag('https://example.com/spec.yaml', null, null);

      expect(axios.get.mock.calls[0][1].headers['If-Modified-Since']).toBeUndefined();
    });

    it('sends both If-None-Match and If-Modified-Since when both are provided', async () => {
      const lm = 'Thu, 01 Jan 2026 00:00:00 GMT';
      axios.get.mockResolvedValue(makeOkResponse());

      await fetchWithETag('https://example.com/spec.yaml', '"etag-abc"', lm);

      const headers = axios.get.mock.calls[0][1].headers;
      expect(headers['If-None-Match']).toBe('"etag-abc"');
      expect(headers['If-Modified-Since']).toBe(lm);
    });
  });

  describe('lastModified in response', () => {
    it('returns lastModified from the response Last-Modified header', async () => {
      const lm = 'Fri, 02 Jan 2026 12:00:00 GMT';
      axios.get.mockResolvedValue(makeOkResponse({ headers: { 'last-modified': lm } }));

      const result = await fetchWithETag('https://example.com/spec.yaml');

      expect(result.lastModified).toBe(lm);
      expect(result.status).toBe('fetched');
    });

    it('returns null lastModified when the response has no Last-Modified header', async () => {
      axios.get.mockResolvedValue(makeOkResponse({ headers: {} }));

      const result = await fetchWithETag('https://example.com/spec.yaml');

      expect(result.lastModified).toBeNull();
    });

    it('preserves storedLastModified on a 304 Not Modified response', async () => {
      const lm = 'Thu, 01 Jan 2026 00:00:00 GMT';
      axios.get.mockResolvedValue({ status: 304, headers: {}, data: '' });

      const result = await fetchWithETag('https://example.com/spec.yaml', '"etag-1"', lm);

      expect(result.status).toBe('not_modified');
      expect(result.lastModified).toBe(lm);
    });
  });
});
