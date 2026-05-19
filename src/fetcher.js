import axios from 'axios';
import Bottleneck from 'bottleneck';
import 'dotenv/config';

const MAX_RETRIES = 4;

// 25 requests per 60 seconds — headroom below GitHub PAT limit of 30/min.
// maxConcurrent is intentionally omitted: external p-limit controls parallelism,
// Bottleneck only enforces the per-minute budget.
export const githubApiLimiter = new Bottleneck({
  reservoir: 25,
  reservoirRefreshAmount: 25,
  reservoirRefreshInterval: 60_000,
});

/**
 * Returns jittered exponential backoff in ms for the given retry attempt.
 * Caps at 30 seconds.
 * @param {number} attempt - Zero-based attempt index
 * @returns {number}
 */
function backoffMs(attempt) {
  return Math.min(1000 * 2 ** attempt + Math.random() * 500, 30_000);
}

/**
 * Returns true for status codes that warrant a retry with backoff.
 * @param {number} status
 * @returns {boolean}
 */
function isRetryable(status) {
  return status === 429 || status === 503;
}

/**
 * Builds request headers for a URL. Injects Authorization for GitHub URLs
 * when GITHUB_TOKEN is set in the environment.
 * @param {string} url
 * @param {string|null} storedETag
 * @param {string|null} storedLastModified
 * @returns {object}
 */
function buildHeaders(url, storedETag, storedLastModified) {
  const headers = {};

  const isGitHub =
    url.includes('github.com') || url.includes('raw.githubusercontent.com');
  if (isGitHub && process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  if (storedETag) headers['If-None-Match'] = storedETag;
  if (storedLastModified) headers['If-Modified-Since'] = storedLastModified;

  return headers;
}

/**
 * Performs a single axios GET, returning the raw response.
 * Does not retry — retry logic lives in _fetchWithRetry.
 * @param {string} url
 * @param {object} headers
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function doGet(url, headers) {
  return axios.get(url, {
    headers,
    timeout: 10_000,
    responseType: 'text',
    // Prevent axios from throwing on 304 so we can handle it ourselves
    validateStatus: (s) => s < 400 || s === 304 || s === 429 || s === 503,
  });
}

/**
 * Fetches a URL with ETag- and Last-Modified-based conditional requests and
 * automatic retry on 429/503. Raw content fetches are not subject to the
 * GitHub API rate limiter — callers control concurrency externally via p-limit.
 *
 * @param {string} url - The URL to fetch
 * @param {string|null} [storedETag=null] - ETag from a previous fetch, if any
 * @param {string|null} [storedLastModified=null] - Last-Modified value from a previous fetch, if any
 * @returns {Promise<{content: string|null, etag: string|null, lastModified: string|null, status: 'fetched'|'not_modified'}>}
 */
export async function fetchWithETag(url, storedETag = null, storedLastModified = null) {
  return _fetchWithRetry(url, storedETag, storedLastModified);
}

/**
 * Internal: performs the fetch with up to MAX_RETRIES retries on 429/503.
 * @param {string} url
 * @param {string|null} storedETag
 * @param {string|null} storedLastModified
 * @returns {Promise<{content: string|null, etag: string|null, lastModified: string|null, status: string}>}
 */
async function _fetchWithRetry(url, storedETag, storedLastModified) {
  const headers = buildHeaders(url, storedETag, storedLastModified);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await doGet(url, headers);
    } catch (err) {
      const message = err.message ?? String(err);
      throw new Error(`Failed to fetch ${url}: ${message}`);
    }

    if (response.status === 304) {
      return { content: null, etag: storedETag, lastModified: storedLastModified, status: 'not_modified' };
    }

    if (isRetryable(response.status)) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Failed to fetch ${url}: received ${response.status} after ${MAX_RETRIES} retries`
        );
      }
      const delay = backoffMs(attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (response.status >= 400) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }

    const etag = response.headers['etag'] ?? null;
    const lastModified = response.headers['last-modified'] ?? null;
    const content = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    return { content, etag, lastModified, status: 'fetched' };
  }

  throw new Error(`Failed to fetch ${url}: exceeded retry limit`);
}
