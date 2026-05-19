import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import 'dotenv/config';

import { fetchWithETag, githubApiLimiter } from './fetcher.js';
import { parseSpec, ParseError } from './parser.js';
import { computeHash, hasChanged, buildCatalogEntry } from './versioner.js';
import { loadCatalog, saveCatalog, mergeEntry } from './catalog.js';

const DEFAULT_CATALOG_PATH = path.resolve('catalog.json');
const DEFAULT_LIMIT = parseInt(process.env.CRAWL_LIMIT ?? '50', 10);
const CHECKPOINT_INTERVAL = 10;
const CANDIDATE_MULTIPLIER = 3; // collect up to 3× the limit to absorb failures/invalids
const GITHUB_SEARCH_PER_PAGE = 100; // GitHub max per_page for code search
const GITHUB_SEARCH_MAX_PAGES = 2; // fetch at most 2 pages per query (200 results)
const BRANCH_FETCH_CONCURRENCY = 20; // parallel repo-metadata calls
const SPEC_FETCH_CONCURRENCY = 10;   // parallel raw content fetches (no rate limit)
const QUEUE_MONITOR_INTERVAL_MS = 10_000;

const DEFAULT_QUERIES = [
  'filename:openapi.yaml',
  'filename:openapi.json',
  'filename:swagger.yaml',
  'filename:swagger.json',
];

// Well-known high-quality specs fetched directly every run, independent of search.
const SEED_SPECS = [
  { fullName: 'stripe/openapi',               specPath: 'openapi/spec3.yaml' },
  { fullName: 'APIs-guru/openapi-directory',  specPath: 'APIs/googleapis.com/gmail/v1/openapi.yaml' },
  { fullName: 'github/rest-api-description',  specPath: 'descriptions/api.github.com/api.github.com.yaml' },
];

/** Writes a structured JSON log line to stdout. */
function log(level, event, data = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + '\n'
  );
}

/** Persists across calls within a process so the same repo is never fetched twice. */
export const repoDefaultBranchCache = new Map();

/**
 * Tracks in-flight repo metadata requests so concurrent callers for the same
 * repo share one HTTP round-trip rather than issuing duplicate requests.
 */
const pendingBranchFetches = new Map();

/**
 * Returns the default branch for a GitHub repo, using a process-level cache
 * to avoid redundant API calls. Concurrent calls for the same repo share a
 * single in-flight request via the pending-fetch map. Falls back to "main"
 * on any error.
 *
 * @param {string} fullName - "owner/repo"
 * @returns {Promise<string>}
 */
export async function getDefaultBranch(fullName) {
  if (repoDefaultBranchCache.has(fullName)) return repoDefaultBranchCache.get(fullName);
  if (pendingBranchFetches.has(fullName)) return pendingBranchFetches.get(fullName);

  const promise = githubApiLimiter.schedule(() =>
    axios.get(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 10_000,
    })
  ).then((response) => {
    const branch = response.data.default_branch ?? 'main';
    repoDefaultBranchCache.set(fullName, branch);
    pendingBranchFetches.delete(fullName);
    return branch;
  }).catch((err) => {
    log('warn', 'repo_meta.failed', { repo: fullName, error: err.message });
    pendingBranchFetches.delete(fullName);
    return 'main';
  });

  pendingBranchFetches.set(fullName, promise);
  return promise;
}

/**
 * Fetches all pages of a GitHub code search query and returns raw item
 * descriptors — no branch resolution. This is the fast path used by crawl so
 * branch lookups can be batched across all queries at once.
 *
 * @param {string} query
 * @param {{ perPage?: number, maxResults?: number, maxPages?: number, runId?: string|null }} [options]
 * @returns {Promise<Array<{ id: string, fullName: string, filePath: string }>>}
 */
async function searchGitHubItems(
  query,
  {
    perPage = GITHUB_SEARCH_PER_PAGE,
    maxResults = perPage,
    maxPages = GITHUB_SEARCH_MAX_PAGES,
    runId = null,
  } = {}
) {
  const expectedName = query.match(/filename:(\S+)/)?.[1] ?? null;

  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const collected = [];

  for (let page = 1; page <= maxPages && collected.length < maxResults; page++) {
    const url =
      `https://api.github.com/search/code` +
      `?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;

    const searchT0 = Date.now();
    const response = await githubApiLimiter.schedule(() =>
      axios.get(url, { headers, timeout: 10_000 })
    );
    const searchMs = Date.now() - searchT0;

    const { items, total_count } = response.data;
    const filtered = items.filter((i) => expectedName === null || i.name === expectedName);
    const needed = maxResults - collected.length;

    log('info', 'search.page', {
      run_id: runId,
      query,
      page,
      returned: items.length,
      matched: filtered.length,
      total_count,
      search_ms: searchMs,
    });

    for (const item of filtered.slice(0, needed)) {
      collected.push({
        id: `github:${item.repository.full_name}/${item.path}`,
        fullName: item.repository.full_name,
        filePath: item.path,
      });
    }

    if (items.length < perPage || page * perPage >= total_count) break;
  }

  return collected;
}

/**
 * Searches GitHub code search for files matching the given query and returns
 * fully resolved candidates with source URLs. Branch metadata is resolved in
 * a single parallel batch after all pages are collected.
 *
 * @param {string} query - GitHub code search query (e.g. "filename:openapi.yaml")
 * @param {{ perPage?: number, maxResults?: number, maxPages?: number, runId?: string|null }} [options]
 * @returns {Promise<Array<{ id: string, source_url: string }>>}
 */
export async function searchGitHub(
  query,
  {
    perPage = GITHUB_SEARCH_PER_PAGE,
    maxResults = perPage,
    maxPages = GITHUB_SEARCH_MAX_PAGES,
    runId = null,
  } = {}
) {
  const items = await searchGitHubItems(query, { perPage, maxResults, maxPages, runId });

  const branchLimit = pLimit(BRANCH_FETCH_CONCURRENCY);
  return Promise.all(
    items.map(({ id, fullName, filePath }) =>
      branchLimit(async () => {
        const branch = await getDefaultBranch(fullName);
        return {
          id,
          source_url: [
            'https://raw.githubusercontent.com',
            fullName,
            branch,
            filePath,
          ].join('/'),
        };
      })
    )
  );
}

/**
 * Swaps the branch segment of a raw.githubusercontent.com URL to "master".
 * Returns null if the URL isn't a raw GitHub URL or already uses "master".
 * @param {string} url
 * @returns {string|null}
 */
function masterFallbackUrl(url) {
  const m = url.match(
    /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)([^/]+)(\/.*)/
  );
  if (!m) return null;
  const branch = m[2];
  if (branch === 'master') return null;
  return m[1] + 'master' + m[3];
}

/**
 * Fetches a URL, retrying once with the "master" branch if the primary URL
 * returns a 404. This handles repos where default_branch in the search result
 * is stale or wrong.
 *
 * @param {string} url - Primary URL to fetch
 * @param {string|null} etag - Stored ETag for the primary URL
 * @param {string|null} lastModified - Stored Last-Modified value for the primary URL
 * @returns {Promise<{ result: object, resolvedUrl: string }>}
 */
async function fetchWithBranchFallback(url, etag, lastModified) {
  try {
    return { result: await fetchWithETag(url, etag, lastModified), resolvedUrl: url };
  } catch (err) {
    if (!err.message.includes('HTTP 404')) throw err;
    const fallback = masterFallbackUrl(url);
    if (!fallback) throw err;
    // Discard stale ETag/Last-Modified — different branch URL means they won't match
    return { result: await fetchWithETag(fallback, null, null), resolvedUrl: fallback };
  }
}

/**
 * Builds a minimal catalog entry for a spec that failed to parse.
 * Preserves existing history so prior valid snapshots aren't lost.
 */
function buildInvalidEntry(id, source_url, hash, etag, lastModified, existingEntry) {
  return {
    id,
    source_url,
    title: existingEntry?.title ?? '',
    oas_version: existingEntry?.oas_version ?? '',
    latest_version: existingEntry?.latest_version ?? '',
    description: existingEntry?.description ?? '',
    servers: existingEntry?.servers ?? [],
    tags: existingEntry?.tags ?? [],
    paths_count: existingEntry?.paths_count ?? 0,
    fetched_at: new Date().toISOString(),
    status: 'invalid',
    content_hash: hash,
    etag: etag ?? null,
    last_modified: lastModified ?? existingEntry?.last_modified ?? null,
    history: existingEntry?.history ?? [],
  };
}

/**
 * Extracts the branch segment from a raw.githubusercontent.com URL.
 * URL format: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
 * Returns null if the URL is not a raw GitHub URL or is too short.
 * @param {string|undefined} sourceUrl
 * @returns {string|null}
 */
function extractBranchFromUrl(sourceUrl) {
  if (!sourceUrl?.includes('raw.githubusercontent.com')) return null;
  const parts = sourceUrl.split('/');
  return parts.length >= 6 ? parts[5] : null;
}

/**
 * Reads branchCache.json and returns a Map<fullName, { defaultBranch, resolvedAt }>.
 * Returns an empty Map if the file does not exist or cannot be parsed.
 * @param {string} cachePath
 * @returns {Promise<Map<string, { defaultBranch: string, resolvedAt: string }>>}
 */
async function loadBranchCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

/**
 * Writes the branch cache map to branchCache.json as a plain JSON object.
 * @param {string} cachePath
 * @param {Map<string, { defaultBranch: string, resolvedAt: string }>} cacheMap
 */
async function saveBranchCache(cachePath, cacheMap) {
  await fs.writeFile(cachePath, JSON.stringify(Object.fromEntries(cacheMap), null, 2));
}

/**
 * Runs a full crawl: searches GitHub for OpenAPI specs, fetches each one,
 * parses it, and updates the catalog.
 *
 * Branch resolution is batched into a single parallel phase after all search
 * pages are collected, so GitHub API calls never block raw content fetches.
 * Raw content fetches run on a separate p-limit with no API rate limit.
 *
 * @param {{
 *   limit?: number,
 *   catalogPath?: string,
 *   queries?: string[],
 *   seeds?: Array<{ fullName: string, specPath: string }>
 * }} [options={}]
 * @returns {Promise<{ new: number, updated: number, unchanged: number, failed: number }>}
 */
export async function crawl(options = {}) {
  const {
    limit = DEFAULT_LIMIT,
    catalogPath = DEFAULT_CATALOG_PATH,
    queries = DEFAULT_QUERIES,
    seeds = SEED_SPECS,
  } = options;

  const runId = `run-${Date.now()}`;
  const crawlT0 = Date.now();

  if (!process.env.GITHUB_TOKEN) {
    log('warn', 'crawl.no_token', {
      run_id: runId,
      message: 'GITHUB_TOKEN not set — search rate limit will be very low',
    });
  }

  log('info', 'crawl.start', { run_id: runId, limit, query_count: queries.length });

  // ── 1. Collect raw candidates (no branch resolution yet) ──────────────────
  // Raw items carry { id, fullName, filePath } — branch lookup is deferred
  // so all search pages can complete before any API calls for repo metadata.

  const candidateCap = limit * CANDIDATE_MULTIPLIER;
  const seen = new Set();

  // Seeds as raw items
  const rawItems = seeds.map(({ fullName, specPath }) => {
    const id = `github:${fullName}/${specPath}`;
    seen.add(id);
    return { id, fullName, filePath: specPath };
  });

  log('info', 'crawl.seeds.start', {
    run_id: runId,
    seed_count: seeds.length,
    unique_repos: new Set(seeds.map((s) => s.fullName)).size,
  });

  // Search raw items across all queries
  const searchT0 = Date.now();

  for (const query of queries) {
    if (rawItems.length >= candidateCap) break;

    const queryT0 = Date.now();
    let results;
    try {
      results = await searchGitHubItems(query, {
        maxResults: candidateCap - rawItems.length,
        runId,
      });
      log('info', 'search.done', {
        run_id: runId,
        query,
        found: results.length,
        query_ms: Date.now() - queryT0,
      });
    } catch (err) {
      log('error', 'search.failed', {
        run_id: runId,
        query,
        error: err.message,
        query_ms: Date.now() - queryT0,
      });
      continue;
    }

    for (const item of results) {
      if (rawItems.length >= candidateCap) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rawItems.push(item);
    }
  }

  const searchMs = Date.now() - searchT0;

  // ── 2. Batch-resolve all repo branches in parallel ─────────────────────────
  // Load catalog early so existing source_urls supply branch names without an
  // API call. A persistent branchCache.json eliminates API calls on re-runs
  // even for candidates not yet in the catalog.

  const catalog = await loadCatalog(catalogPath);
  const branchCachePath = path.join(path.dirname(path.resolve(catalogPath)), 'branchCache.json');
  const persistentBranchCache = await loadBranchCache(branchCachePath);

  const uniqueFullNames = [...new Set(rawItems.map((i) => i.fullName))];

  // Pre-populate from persistent branch cache file
  let fromPersistentCache = 0;
  for (const fullName of uniqueFullNames) {
    if (persistentBranchCache.has(fullName)) {
      repoDefaultBranchCache.set(fullName, persistentBranchCache.get(fullName).defaultBranch);
      fromPersistentCache++;
    }
  }

  // Pre-populate from existing catalog entries (extract branch from source_url)
  const fromCatalogSet = new Set();
  for (const { id, fullName } of rawItems) {
    if (repoDefaultBranchCache.has(fullName)) continue;
    if (fromCatalogSet.has(fullName)) continue;
    const existingEntry = catalog.get(id);
    const branch = extractBranchFromUrl(existingEntry?.source_url);
    if (branch) {
      repoDefaultBranchCache.set(fullName, branch);
      fromCatalogSet.add(fullName);
    }
  }

  const apiCallsNeeded = uniqueFullNames.filter((fn) => !repoDefaultBranchCache.has(fn)).length;

  log('info', 'batch_branches.start', {
    run_id: runId,
    unique_repos: uniqueFullNames.length,
    from_persistent_cache: fromPersistentCache,
    from_catalog: fromCatalogSet.size,
    api_calls_needed: apiCallsNeeded,
  });

  const branchLimit = pLimit(BRANCH_FETCH_CONCURRENCY);
  const branchT0 = Date.now();
  const branchMap = new Map();

  await Promise.all(
    uniqueFullNames.map((fullName) =>
      branchLimit(async () => {
        branchMap.set(fullName, await getDefaultBranch(fullName));
      })
    )
  );

  // Persist newly resolved branches to speed up future runs
  let newlyCached = 0;
  for (const [fullName, branch] of branchMap) {
    if (!persistentBranchCache.has(fullName)) {
      persistentBranchCache.set(fullName, { defaultBranch: branch, resolvedAt: new Date().toISOString() });
      newlyCached++;
    }
  }
  if (newlyCached > 0) await saveBranchCache(branchCachePath, persistentBranchCache);

  const branchMs = Date.now() - branchT0;
  log('info', 'batch_branches.done', {
    run_id: runId,
    unique_repos: uniqueFullNames.length,
    branch_ms: branchMs,
    avg_ms: uniqueFullNames.length > 0 ? Math.round(branchMs / uniqueFullNames.length) : 0,
    newly_cached: newlyCached,
  });

  // ── 3. Construct candidates with resolved source URLs ──────────────────────
  const candidates = rawItems.map(({ id, fullName, filePath }) => ({
    id,
    source_url: [
      'https://raw.githubusercontent.com',
      fullName,
      branchMap.get(fullName) ?? 'main',
      filePath,
    ].join('/'),
  }));

  log('info', 'crawl.candidates', {
    run_id: runId,
    count: candidates.length,
    search_ms: searchMs,
    branch_ms: branchMs,
  });

  // ── 4. Process candidates concurrently (catalog already loaded above) ─────
  const stats = { new: 0, updated: 0, unchanged: 0, failed: 0 };

  const checkpoint = async (processed) => {
    await saveCatalog(catalogPath, catalog, {
      new_this_run: stats.new,
      updated_this_run: stats.updated,
      failed_this_run: stats.failed,
    });
    log('info', 'crawl.checkpoint', { run_id: runId, processed });
  };

  let processedCount = 0;
  let checkpointing = false;

  // Log Bottleneck (GitHub API) queue depth on a fixed interval to diagnose
  // whether branch/search calls are backing up during the fetch phase.
  const queueTimer = setInterval(() => {
    const counts = githubApiLimiter.counts();
    log('info', 'rate_limiter.status', {
      run_id: runId,
      queued: counts.QUEUED,
      running: counts.RUNNING,
      executing: counts.EXECUTING,
    });
  }, QUEUE_MONITOR_INTERVAL_MS);

  const processOne = async ({ id, source_url }, queueWaitMs) => {
    const specT0 = Date.now();
    const existingEntry = catalog.get(id) ?? null;

    // ── Fetch (raw content, no API rate limit) ──────────────────────────────
    const fetchT0 = Date.now();
    let fetchResult, resolvedUrl;
    let fetchMs = 0;
    let parseMs = 0;

    try {
      ({ result: fetchResult, resolvedUrl } = await fetchWithBranchFallback(
        source_url, existingEntry?.etag ?? null, existingEntry?.last_modified ?? null
      ));
      fetchMs = Date.now() - fetchT0;
      if (resolvedUrl !== source_url) {
        log('info', 'fetch.branch_fallback', { run_id: runId, id, url: resolvedUrl });
      }
    } catch (err) {
      fetchMs = Date.now() - fetchT0;
      log('warn', 'fetch.failed', { run_id: runId, id, error: err.message });
      if (existingEntry) {
        const failures = (existingEntry.consecutive_failures ?? 0) + 1;
        mergeEntry(catalog, {
          ...existingEntry,
          consecutive_failures: failures,
          status: failures >= 3 ? 'stale' : existingEntry.status,
          fetched_at: new Date().toISOString(),
        });
      }
      stats.failed++;
      log('info', 'spec.timing', {
        run_id: runId, id, queue_wait_ms: queueWaitMs,
        fetch_ms: fetchMs, parse_ms: 0, total_ms: Date.now() - specT0, outcome: 'fetch_failed',
      });
      return;
    }

    // ── ETag cache hit ───────────────────────────────────────────────────────
    if (fetchResult.status === 'not_modified') {
      log('info', 'spec.not_modified', { run_id: runId, id });
      stats.unchanged++;
      log('info', 'spec.timing', {
        run_id: runId, id, queue_wait_ms: queueWaitMs,
        fetch_ms: fetchMs, parse_ms: 0, total_ms: Date.now() - specT0, outcome: 'not_modified',
      });
      return;
    }

    // ── Content hash check ───────────────────────────────────────────────────
    const hash = computeHash(fetchResult.content);
    if (!hasChanged(hash, existingEntry)) {
      log('info', 'spec.unchanged', { run_id: runId, id });
      mergeEntry(catalog, {
        ...existingEntry,
        etag: fetchResult.etag,
        last_modified: fetchResult.lastModified ?? existingEntry?.last_modified ?? null,
        fetched_at: new Date().toISOString(),
      });
      stats.unchanged++;
      log('info', 'spec.timing', {
        run_id: runId, id, queue_wait_ms: queueWaitMs,
        fetch_ms: fetchMs, parse_ms: 0, total_ms: Date.now() - specT0, outcome: 'unchanged',
      });
      return;
    }

    // ── Parse ────────────────────────────────────────────────────────────────
    const parseT0 = Date.now();
    let parsedSpec;
    try {
      parsedSpec = parseSpec(fetchResult.content, resolvedUrl);
      parseMs = Date.now() - parseT0;
    } catch (err) {
      parseMs = Date.now() - parseT0;
      if (err instanceof ParseError) {
        log('warn', 'spec.invalid', { run_id: runId, id, reason: err.reason });
      } else {
        log('error', 'spec.parse_error', { run_id: runId, id, error: err.message });
      }
      mergeEntry(catalog, buildInvalidEntry(id, resolvedUrl, hash, fetchResult.etag, fetchResult.lastModified, existingEntry));
      stats.failed++;
      log('info', 'spec.timing', {
        run_id: runId, id, queue_wait_ms: queueWaitMs,
        fetch_ms: fetchMs, parse_ms: parseMs, total_ms: Date.now() - specT0, outcome: 'parse_failed',
      });
      return;
    }

    // ── Upsert ───────────────────────────────────────────────────────────────
    const isNew = !existingEntry;
    mergeEntry(
      catalog,
      buildCatalogEntry(id, resolvedUrl, parsedSpec, hash, fetchResult.etag, existingEntry, fetchResult.lastModified)
    );

    const outcome = isNew ? 'new' : 'updated';
    if (isNew) {
      stats.new++;
      log('info', 'spec.new', { run_id: runId, id, title: parsedSpec.title });
    } else {
      stats.updated++;
      log('info', 'spec.updated', { run_id: runId, id, title: parsedSpec.title });
    }

    log('info', 'spec.timing', {
      run_id: runId, id, queue_wait_ms: queueWaitMs,
      fetch_ms: fetchMs, parse_ms: parseMs, total_ms: Date.now() - specT0, outcome,
    });
  };

  const processLimit = pLimit(SPEC_FETCH_CONCURRENCY);
  const processT0 = Date.now();

  await Promise.all(
    candidates.map((candidate) => {
      const submittedAt = Date.now();
      return processLimit(async () => {
        const queueWaitMs = Date.now() - submittedAt;
        await processOne(candidate, queueWaitMs);
        processedCount++;
        if (processedCount % CHECKPOINT_INTERVAL === 0 && !checkpointing) {
          checkpointing = true;
          try { await checkpoint(processedCount); } finally { checkpointing = false; }
        }
      });
    })
  );

  const processMs = Date.now() - processT0;
  clearInterval(queueTimer);

  // ── Final save ─────────────────────────────────────────────────────────────
  await saveCatalog(catalogPath, catalog, {
    new_this_run: stats.new,
    updated_this_run: stats.updated,
    failed_this_run: stats.failed,
  });

  const totalMs = Date.now() - crawlT0;
  log('info', 'crawl.timing', {
    run_id: runId,
    search_ms: searchMs,
    branch_ms: branchMs,
    process_ms: processMs,
    total_ms: totalMs,
  });
  log('info', 'crawl.done', { run_id: runId, ...stats });

  return stats;
}
