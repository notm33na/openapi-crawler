import crypto from 'crypto';

const HISTORY_MAX = 10;

/**
 * Computes a SHA-256 hex digest of a raw content string.
 * @param {string} rawContent - The raw spec text (JSON or YAML)
 * @returns {string} 64-character hex digest
 */
export function computeHash(rawContent) {
  return crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex');
}

/**
 * Returns true when the content has changed relative to the catalog entry.
 * A null entry (new URL) is always considered changed.
 * @param {string} newHash
 * @param {object|null} catalogEntry
 * @returns {boolean}
 */
export function hasChanged(newHash, catalogEntry) {
  if (catalogEntry === null || catalogEntry === undefined) return true;
  return newHash !== catalogEntry.content_hash;
}

/**
 * Builds a single history entry to prepend to a catalog entry's history array.
 * @param {object} parsedSpec - Result of parseSpec()
 * @param {string} hash - SHA-256 hex digest from computeHash()
 * @param {number} previousPathsCount - paths_count from the prior catalog entry, or 0
 * @returns {{ version: string, hash: string, paths_delta: number, recorded_at: string }}
 */
export function buildHistoryEntry(parsedSpec, hash, previousPathsCount) {
  return {
    version: parsedSpec.api_version,
    hash,
    paths_delta: parsedSpec.paths_count - (previousPathsCount ?? 0),
    recorded_at: new Date().toISOString(),
  };
}

/**
 * Builds or updates a full catalog entry for a given source URL.
 *
 * When existingEntry is provided and the content hash matches, the entry's
 * top-level fields are refreshed (fetched_at, etag) but history is unchanged.
 * When the hash differs, a new history entry is prepended and the list is
 * capped at HISTORY_MAX entries.
 *
 * @param {string} id - Stable identifier for this spec (e.g. slugified title or UUID)
 * @param {string} sourceUrl
 * @param {object} parsedSpec - Result of parseSpec()
 * @param {string} hash - SHA-256 hex digest from computeHash()
 * @param {string|null} etag - ETag from the HTTP response, or null
 * @param {object|null} existingEntry - Current catalog entry, or null for new entries
 * @param {string|null} [lastModified=null] - Last-Modified header value from the HTTP response
 * @returns {{
 *   id: string,
 *   source_url: string,
 *   title: string,
 *   oas_version: string,
 *   latest_version: string,
 *   description: string,
 *   servers: string[],
 *   tags: string[],
 *   paths_count: number,
 *   fetched_at: string,
 *   status: 'active',
 *   content_hash: string,
 *   etag: string|null,
 *   last_modified: string|null,
 *   history: object[]
 * }}
 */
export function buildCatalogEntry(id, sourceUrl, parsedSpec, hash, etag, existingEntry, lastModified = null) {
  const now = new Date().toISOString();
  const previousPathsCount = existingEntry?.paths_count ?? 0;
  const existingHistory = existingEntry?.history ?? [];

  let history;
  if (!hasChanged(hash, existingEntry)) {
    // Content unchanged — keep existing history, just refresh timestamps/etag
    history = existingHistory;
  } else {
    const newEntry = buildHistoryEntry(parsedSpec, hash, previousPathsCount);
    // Prepend newest, then cap — oldest entries fall off the end
    history = [newEntry, ...existingHistory].slice(0, HISTORY_MAX);
  }

  return {
    id,
    source_url: sourceUrl,
    title: parsedSpec.title,
    oas_version: parsedSpec.oas_version,
    latest_version: parsedSpec.api_version,
    description: parsedSpec.description,
    servers: parsedSpec.servers,
    tags: parsedSpec.tags,
    paths_count: parsedSpec.paths_count,
    fetched_at: now,
    status: 'active',
    content_hash: hash,
    etag: etag ?? null,
    last_modified: lastModified ?? null,
    history,
  };
}
