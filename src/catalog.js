import fs from 'fs/promises';
import path from 'path';

/**
 * Loads catalog.json from disk and indexes entries by id into a Map.
 * Returns an empty Map if the file does not exist.
 * Propagates all other I/O errors (e.g. permission denied, malformed JSON).
 *
 * @param {string} filePath - Absolute or relative path to catalog.json
 * @returns {Promise<Map<string, object>>}
 */
export async function loadCatalog(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }

  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error(`catalog at ${filePath} must be a JSON array`);
  }

  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, entry);
  }
  return map;
}

/**
 * Persists a catalog Map to disk as a pretty-printed JSON array sorted by id,
 * and writes a companion catalog.summary.json with run statistics.
 *
 * @param {string} filePath - Path to catalog.json
 * @param {Map<string, object>} catalogMap
 * @param {{ new_this_run?: number, updated_this_run?: number, failed_this_run?: number }} [stats={}]
 * @returns {Promise<void>}
 */
export async function saveCatalog(filePath, catalogMap, stats = {}) {
  const entries = [...catalogMap.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');

  const statusCounts = { active: 0, stale: 0, invalid: 0 };
  for (const entry of entries) {
    const s = entry.status;
    if (s in statusCounts) statusCounts[s]++;
  }

  const summary = {
    total: entries.length,
    active: statusCounts.active,
    stale: statusCounts.stale,
    invalid: statusCounts.invalid,
    last_run: new Date().toISOString(),
    new_this_run: stats.new_this_run ?? 0,
    updated_this_run: stats.updated_this_run ?? 0,
    failed_this_run: stats.failed_this_run ?? 0,
  };

  const summaryPath = path.join(
    path.dirname(filePath),
    'catalog.summary.json'
  );
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
}

/**
 * Inserts or replaces an entry in the catalog Map keyed by entry.id.
 *
 * @param {Map<string, object>} catalogMap
 * @param {object} newEntry - Entry object with an `id` field
 * @returns {void}
 */
export function mergeEntry(catalogMap, newEntry) {
  catalogMap.set(newEntry.id, newEntry);
}
