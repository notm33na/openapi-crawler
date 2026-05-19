import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/fetcher.js', () => ({
  githubApiLimiter: { schedule: (fn) => fn(), counts: () => ({ QUEUED: 0, RUNNING: 0, EXECUTING: 0 }) },
  fetchWithETag: jest.fn(),
}));

jest.unstable_mockModule('axios', () => ({
  default: { get: jest.fn() },
}));

const { searchGitHub, getDefaultBranch, crawl, repoDefaultBranchCache } =
  await import('../src/crawler.js');
const { fetchWithETag } = await import('../src/fetcher.js');
const axios = (await import('axios')).default;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GITHUB_ITEM = {
  name: 'openapi.yaml',
  path: 'docs/openapi.yaml',
  repository: { full_name: 'acme/petstore' },
};

const VALID_OAS3 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Pet Store', version: '1.0.0' },
  paths: { '/pets': {} },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSearchResponse(items) {
  return { data: { total_count: items.length, items } };
}

function makeRepoResponse(defaultBranch = 'main') {
  return { data: { default_branch: defaultBranch } };
}

/**
 * Default axios.get mock: repo API calls return 'main'; everything else
 * returns a single-item search response for GITHUB_ITEM.
 */
function defaultAxiosMock() {
  axios.get.mockImplementation((url) => {
    if (url.includes('api.github.com/repos/')) {
      return Promise.resolve(makeRepoResponse('main'));
    }
    return Promise.resolve(makeSearchResponse([GITHUB_ITEM]));
  });
}

// ── getDefaultBranch ──────────────────────────────────────────────────────────

describe('getDefaultBranch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
  });

  it('fetches default_branch from the repos API', async () => {
    axios.get.mockResolvedValue(makeRepoResponse('develop'));
    const branch = await getDefaultBranch('acme/petstore');
    expect(branch).toBe('develop');
    expect(axios.get.mock.calls[0][0]).toContain('api.github.com/repos/acme/petstore');
  });

  it('caches the result so the same repo is only fetched once', async () => {
    axios.get.mockResolvedValue(makeRepoResponse('trunk'));
    await getDefaultBranch('acme/petstore');
    const branch = await getDefaultBranch('acme/petstore'); // cache hit
    expect(branch).toBe('trunk');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries for different repos', async () => {
    axios.get
      .mockResolvedValueOnce(makeRepoResponse('main'))
      .mockResolvedValueOnce(makeRepoResponse('master'));
    const b1 = await getDefaultBranch('acme/repo-a');
    const b2 = await getDefaultBranch('acme/repo-b');
    expect(b1).toBe('main');
    expect(b2).toBe('master');
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('returns "main" and does not throw when the API call fails', async () => {
    axios.get.mockRejectedValue(new Error('HTTP 404'));
    const branch = await getDefaultBranch('acme/private-repo');
    expect(branch).toBe('main');
  });

  it('returns "main" when the API response has no default_branch field', async () => {
    axios.get.mockResolvedValue({ data: {} });
    const branch = await getDefaultBranch('acme/incomplete-repo');
    expect(branch).toBe('main');
  });
});

// ── searchGitHub ──────────────────────────────────────────────────────────────

describe('searchGitHub', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
    defaultAxiosMock();
  });

  it('maps items to { id, source_url } using the branch from the repos API', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse('main'));
      return Promise.resolve(makeSearchResponse([GITHUB_ITEM]));
    });

    const results = await searchGitHub('filename:openapi.yaml');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: 'github:acme/petstore/docs/openapi.yaml',
      source_url: 'https://raw.githubusercontent.com/acme/petstore/main/docs/openapi.yaml',
    });
  });

  it('uses the branch returned by the repos API, not a hardcoded default', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse('trunk'));
      return Promise.resolve(makeSearchResponse([GITHUB_ITEM]));
    });

    const results = await searchGitHub('filename:openapi.yaml');
    expect(results[0].source_url).toContain('/trunk/');
  });

  it('falls back to "main" when the repos API returns no default_branch', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve({ data: {} });
      return Promise.resolve(makeSearchResponse([GITHUB_ITEM]));
    });

    const results = await searchGitHub('filename:openapi.yaml');
    expect(results[0].source_url).toContain('/main/');
  });

  it('encodes the query in the search request URL', async () => {
    const results = await searchGitHub('filename:openapi.yaml extension:yaml');
    const searchCall = axios.get.mock.calls.find((c) => c[0].includes('search/code'));
    expect(searchCall[0]).toContain('q=');
    expect(searchCall[0]).not.toContain(' ');
  });

  it('sends Authorization header with Bearer token', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    await searchGitHub('filename:openapi.yaml');
    const searchCall = axios.get.mock.calls.find((c) => c[0].includes('search/code'));
    expect(searchCall[1].headers.Authorization).toBe('Bearer test-token');
  });

  it('filters out results whose name does not exactly match the filename in the query', async () => {
    const items = [
      { ...GITHUB_ITEM, name: 'openapi.yaml' },
      { ...GITHUB_ITEM, name: 'openapi.yaml.j2',    path: 'openapi.yaml.j2' },
      { ...GITHUB_ITEM, name: 'openapi.yaml.bak',   path: 'openapi.yaml.bak' },
      { ...GITHUB_ITEM, name: 'openapi.yaml.plush',  path: 'openapi.yaml.plush' },
    ];
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse());
      return Promise.resolve(makeSearchResponse(items));
    });

    const results = await searchGitHub('filename:openapi.yaml');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('github:acme/petstore/docs/openapi.yaml');
  });

  it('keeps all results when the query has no filename: clause', async () => {
    const items = [
      { ...GITHUB_ITEM, name: 'openapi.yaml' },
      { ...GITHUB_ITEM, name: 'swagger.json', path: 'swagger.json' },
    ];
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse());
      return Promise.resolve(makeSearchResponse(items));
    });

    const results = await searchGitHub('org:acme openapi');
    expect(results).toHaveLength(2);
  });

  it('does not re-fetch the repos API for the same repo across multiple items', async () => {
    const items = [
      { ...GITHUB_ITEM, path: 'api/v1/openapi.yaml' },
      { ...GITHUB_ITEM, path: 'api/v2/openapi.yaml' },
    ];
    let repoCalls = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) { repoCalls++; return Promise.resolve(makeRepoResponse()); }
      return Promise.resolve(makeSearchResponse(items));
    });

    await searchGitHub('filename:openapi.yaml');
    expect(repoCalls).toBe(1); // cache hit on second item
  });

  it('fetches additional pages when total_count exceeds the first page', async () => {
    const makeItems = (offset, n) =>
      Array.from({ length: n }, (_, i) => ({
        name: 'openapi.yaml',
        path: `docs/api${offset + i}/openapi.yaml`,
        repository: { full_name: `acme/repo${offset + i}` },
      }));

    let searchPage = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse());
      searchPage++;
      if (searchPage === 1) return Promise.resolve({ data: { total_count: 5, items: makeItems(0, 3) } });
      return Promise.resolve({ data: { total_count: 5, items: makeItems(3, 2) } });
    });

    const results = await searchGitHub('filename:openapi.yaml', { perPage: 3, maxResults: 10, maxPages: 2 });

    expect(results).toHaveLength(5);
    expect(searchPage).toBe(2);
    const urls = axios.get.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('page=2'))).toBe(true);
  });

  it('stops paginating once maxResults filtered items are collected', async () => {
    const makeItems = (offset, n) =>
      Array.from({ length: n }, (_, i) => ({
        name: 'openapi.yaml',
        path: `docs/api${offset + i}/openapi.yaml`,
        repository: { full_name: `acme/repo${offset + i}` },
      }));

    let searchPage = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse());
      searchPage++;
      if (searchPage === 1) return Promise.resolve({ data: { total_count: 100, items: makeItems(0, 5) } });
      return Promise.resolve({ data: { total_count: 100, items: makeItems(5, 5) } });
    });

    const results = await searchGitHub('filename:openapi.yaml', { perPage: 5, maxResults: 7, maxPages: 5 });

    expect(results).toHaveLength(7);
    expect(searchPage).toBe(2);
  });

  it('stops paginating when the last page has fewer items than perPage', async () => {
    const makeItems = (n) =>
      Array.from({ length: n }, (_, i) => ({
        name: 'openapi.yaml',
        path: `docs/api${i}/openapi.yaml`,
        repository: { full_name: `acme/repo${i}` },
      }));

    let searchPage = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse());
      searchPage++;
      return Promise.resolve({ data: { total_count: 3, items: makeItems(3) } });
    });

    const results = await searchGitHub('filename:openapi.yaml', { perPage: 5, maxResults: 50, maxPages: 5 });

    expect(results).toHaveLength(3);
    expect(searchPage).toBe(1);
  });

  it('stops after maxPages even when more results are available', async () => {
    let searchPage = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('/repos/')) return Promise.resolve(makeRepoResponse());
      searchPage++;
      return Promise.resolve({ data: { total_count: 1000, items: [GITHUB_ITEM] } });
    });

    await searchGitHub('filename:openapi.yaml', { perPage: 1, maxResults: 100, maxPages: 2 });
    expect(searchPage).toBe(2);
  });

  it('throws when the search API request fails', async () => {
    axios.get.mockRejectedValue(new Error('network error'));
    await expect(searchGitHub('filename:openapi.yaml')).rejects.toThrow('network error');
  });
});

// ── crawl ─────────────────────────────────────────────────────────────────────

describe('crawl', () => {
  let tmpDir;
  let catalogPath;

  beforeEach(async () => {
    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crawler-test-'));
    catalogPath = path.join(tmpDir, 'catalog.json');
    defaultAxiosMock();
    fetchWithETag.mockResolvedValue({ content: VALID_OAS3, etag: '"etag-1"', status: 'fetched' });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns summary stats with a new entry', async () => {
    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.new).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('writes catalog.json with the new entry', async () => {
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('github:acme/petstore/docs/openapi.yaml');
    expect(written[0].status).toBe('active');
    expect(written[0].title).toBe('Pet Store');
  });

  it('marks entry as unchanged when ETag returns not_modified', async () => {
    fetchWithETag.mockResolvedValue({ content: null, etag: '"etag-1"', status: 'not_modified' });
    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.unchanged).toBe(1);
    expect(stats.new).toBe(0);
  });

  it('marks entry as unchanged when content hash matches existing entry', async () => {
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
    defaultAxiosMock();
    fetchWithETag.mockResolvedValue({ content: VALID_OAS3, etag: '"etag-2"', status: 'fetched' });

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.unchanged).toBe(1);
    expect(stats.updated).toBe(0);
  });

  it('marks entry as updated when content changes', async () => {
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
    defaultAxiosMock();
    const changed = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Pet Store', version: '2.0.0' },
      paths: { '/pets': {}, '/owners': {} },
    });
    fetchWithETag.mockResolvedValue({ content: changed, etag: '"etag-2"', status: 'fetched' });

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.updated).toBe(1);
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written[0].history).toHaveLength(2);
  });

  it('marks entry as failed and sets status invalid on ParseError', async () => {
    fetchWithETag.mockResolvedValue({ content: 'not: valid: oas: content', etag: null, status: 'fetched' });
    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.failed).toBe(1);
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written[0].status).toBe('invalid');
  });

  it('marks entry as failed when fetch throws a non-404 error', async () => {
    fetchWithETag.mockRejectedValue(new Error('timeout'));
    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.failed).toBe(1);
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8')).length;
    expect(written).toBe(0);
  });

  it('retries with master branch when the primary URL returns 404', async () => {
    const primaryUrl = 'https://raw.githubusercontent.com/acme/petstore/main/docs/openapi.yaml';
    const masterUrl  = 'https://raw.githubusercontent.com/acme/petstore/master/docs/openapi.yaml';

    fetchWithETag
      .mockRejectedValueOnce(new Error(`Failed to fetch ${primaryUrl}: HTTP 404`))
      .mockResolvedValueOnce({ content: VALID_OAS3, etag: '"etag-master"', status: 'fetched' });

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    expect(stats.new).toBe(1);
    expect(fetchWithETag.mock.calls[1][0]).toBe(masterUrl);
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written[0].source_url).toBe(masterUrl);
  });

  it('marks entry as failed when both primary and master branch return 404', async () => {
    const primaryUrl = 'https://raw.githubusercontent.com/acme/petstore/main/docs/openapi.yaml';
    const masterUrl  = 'https://raw.githubusercontent.com/acme/petstore/master/docs/openapi.yaml';

    fetchWithETag
      .mockRejectedValueOnce(new Error(`Failed to fetch ${primaryUrl}: HTTP 404`))
      .mockRejectedValueOnce(new Error(`Failed to fetch ${masterUrl}: HTTP 404`));

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    expect(stats.failed).toBe(1);
    expect(fetchWithETag).toHaveBeenCalledTimes(2);
  });

  it('deduplicates results across queries', async () => {
    const stats = await crawl({
      catalogPath,
      queries: ['filename:openapi.yaml', 'filename:openapi.json'],
      limit: 10,
      seeds: [],
    });
    expect(stats.new).toBe(1);
    expect(fetchWithETag).toHaveBeenCalledTimes(1);
  });

  it('always includes seed specs even when search returns nothing', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('api.github.com/repos/')) return Promise.resolve(makeRepoResponse('main'));
      return Promise.resolve(makeSearchResponse([]));
    });

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10 });
    // 3 seeds fetched despite empty search
    expect(fetchWithETag).toHaveBeenCalledTimes(3);
    expect(stats.new + stats.updated + stats.unchanged + stats.failed).toBe(3);
  });

  it('deduplicates a seed that also appears in search results', async () => {
    // stripe/openapi/openapi/spec3.yaml is one of the hardcoded seeds
    const seedItem = {
      name: 'spec3.yaml',
      path: 'openapi/spec3.yaml',
      repository: { full_name: 'stripe/openapi' },
    };
    axios.get.mockImplementation((url) => {
      if (url.includes('api.github.com/repos/')) return Promise.resolve(makeRepoResponse('main'));
      return Promise.resolve(makeSearchResponse([seedItem]));
    });

    await crawl({ catalogPath, queries: ['filename:spec3.yaml'], limit: 10 });

    const stripeUrls = fetchWithETag.mock.calls
      .map((c) => c[0])
      .filter((u) => u.includes('stripe/openapi'));
    expect(stripeUrls).toHaveLength(1);
  });

  it('caps candidate collection at limit * 3 across all queries', async () => {
    // Each search call returns a distinct batch of 6 items (different repos),
    // so deduplication doesn't discard them. total_count:100 prevents the
    // early-stop from firing (items.length < perPage would otherwise break).
    let searchCallCount = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('api.github.com/repos/')) return Promise.resolve(makeRepoResponse());
      const offset = searchCallCount++ * 6;
      const items = Array.from({ length: 6 }, (_, i) => ({
        name: 'openapi.yaml',
        path: `docs/api${offset + i}/openapi.yaml`,
        repository: { full_name: `acme/repo${offset + i}` },
      }));
      return Promise.resolve({ data: { total_count: 100, items } });
    });

    await crawl({
      catalogPath,
      queries: ['filename:openapi.yaml', 'filename:openapi.yaml'],
      limit: 3,
      seeds: [],
    });

    expect(fetchWithETag).toHaveBeenCalledTimes(9); // limit * CANDIDATE_MULTIPLIER = 3 * 3
  });

  it('continues processing when one search query fails', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('api.github.com/repos/')) return Promise.resolve(makeRepoResponse());
      if (url.includes('swagger.yaml')) return Promise.reject(new Error('rate limited'));
      return Promise.resolve(makeSearchResponse([GITHUB_ITEM]));
    });

    const stats = await crawl({
      catalogPath,
      queries: ['filename:swagger.yaml', 'filename:openapi.yaml'],
      limit: 10,
      seeds: [],
    });
    expect(stats.new).toBe(1);
  });

  it('writes catalog.summary.json after crawl', async () => {
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    const summary = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'catalog.summary.json'), 'utf8')
    );
    expect(summary.total).toBe(1);
    expect(summary.new_this_run).toBe(1);
  });

  it('extracts branch from existing catalog entry without calling the repos API', async () => {
    // First crawl: populates catalog with a source_url containing the branch
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    // Second crawl: branch should come from catalog, not from the repos API
    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
    defaultAxiosMock();
    fetchWithETag.mockResolvedValue({ content: VALID_OAS3, etag: '"etag-1"', status: 'fetched' });

    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    const repoCalls = axios.get.mock.calls.filter((c) => c[0].includes('/repos/'));
    expect(repoCalls).toHaveLength(0);
  });

  it('writes branchCache.json with resolved branch entries after crawl', async () => {
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    const cachePath = path.join(tmpDir, 'branchCache.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    expect(cache['acme/petstore']).toBeDefined();
    expect(cache['acme/petstore'].defaultBranch).toBe('main');
    expect(cache['acme/petstore'].resolvedAt).toBeDefined();
  });

  it('increments consecutive_failures and keeps status active after 1 failure', async () => {
    // First crawl: creates an active entry
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    jest.clearAllMocks();
    repoDefaultBranchCache.clear();
    defaultAxiosMock();
    fetchWithETag.mockRejectedValue(new Error('network timeout'));

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    expect(stats.failed).toBe(1);
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written).toHaveLength(1);
    expect(written[0].status).toBe('active');
    expect(written[0].consecutive_failures).toBe(1);
  });

  it('marks an existing catalog entry as stale after 3 consecutive failures', async () => {
    // First crawl: creates an active entry
    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    // Run 3 more crawls, each failing
    for (let i = 0; i < 3; i++) {
      jest.clearAllMocks();
      repoDefaultBranchCache.clear();
      defaultAxiosMock();
      fetchWithETag.mockRejectedValue(new Error('network timeout'));
      await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });
    }

    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written).toHaveLength(1);
    expect(written[0].status).toBe('stale');
    expect(written[0].consecutive_failures).toBe(3);
  });

  it('does not write a stale entry for a brand-new spec that immediately fails', async () => {
    fetchWithETag.mockRejectedValue(new Error('network timeout'));

    const stats = await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    expect(stats.failed).toBe(1);
    const written = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    expect(written).toHaveLength(0);
  });

  it('loads branchCache.json to skip the repos API on re-run', async () => {
    // Pre-populate the branch cache
    const cachePath = path.join(tmpDir, 'branchCache.json');
    await fs.writeFile(
      cachePath,
      JSON.stringify({ 'acme/petstore': { defaultBranch: 'main', resolvedAt: '2024-01-01T00:00:00.000Z' } })
    );

    await crawl({ catalogPath, queries: ['filename:openapi.yaml'], limit: 10, seeds: [] });

    const repoCalls = axios.get.mock.calls.filter((c) => c[0].includes('/repos/'));
    expect(repoCalls).toHaveLength(0);
  });
});
