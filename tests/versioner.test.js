import { describe, it, expect, beforeEach } from '@jest/globals';
import { computeHash, hasChanged, buildHistoryEntry, buildCatalogEntry } from '../src/versioner.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PARSED_SPEC = {
  title: 'Pet Store',
  oas_version: '3.0.3',
  api_version: '1.0.0',
  paths_count: 4,
  description: 'A pet store API.',
  servers: ['https://api.pets.io'],
  tags: ['pets', 'store'],
};

// ── versioner.js ──────────────────────────────────────────────────────────────

describe('computeHash', () => {
  it('returns a consistent SHA-256 hex string for the same input', () => {
    const h1 = computeHash('openapi: 3.0.3\ninfo:\n  title: T');
    const h2 = computeHash('openapi: 3.0.3\ninfo:\n  title: T');

    expect(h1).toBe(h2);
    // SHA-256 produces a 64-character lowercase hex digest
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns different hashes for different content', () => {
    const specV1 = JSON.stringify({ openapi: '3.0.3', info: { version: '1.0.0' } });
    const specV2 = JSON.stringify({ openapi: '3.0.3', info: { version: '2.0.0' } });

    expect(computeHash(specV1)).not.toBe(computeHash(specV2));
  });

  it('is sensitive to whitespace differences', () => {
    expect(computeHash('abc')).not.toBe(computeHash('abc '));
    expect(computeHash('abc')).not.toBe(computeHash(' abc'));
  });
});

describe('hasChanged', () => {
  const hash = computeHash('{"openapi":"3.0.3"}');

  it('returns true when catalogEntry is null (new spec)', () => {
    expect(hasChanged(hash, null)).toBe(true);
  });

  it('returns true when catalogEntry is undefined', () => {
    expect(hasChanged(hash, undefined)).toBe(true);
  });

  it('returns true when hash does not match the stored content_hash', () => {
    const staleEntry = { id: 'x', content_hash: 'aaaa' + hash.slice(4) };
    expect(hasChanged(hash, staleEntry)).toBe(true);
  });

  it('returns false when hash matches the stored content_hash exactly', () => {
    const currentEntry = { id: 'x', content_hash: hash };
    expect(hasChanged(hash, currentEntry)).toBe(false);
  });
});

describe('buildHistoryEntry', () => {
  it('calculates correct paths_delta relative to previous count', () => {
    // 6 paths now, 4 before → delta = +2
    const entry = buildHistoryEntry({ ...PARSED_SPEC, paths_count: 6 }, 'hash-abc', 4);
    expect(entry.paths_delta).toBe(2);
  });

  it('calculates negative paths_delta when paths were removed', () => {
    // 2 paths now, 4 before → delta = -2
    const entry = buildHistoryEntry({ ...PARSED_SPEC, paths_count: 2 }, 'hash-abc', 4);
    expect(entry.paths_delta).toBe(-2);
  });

  it('treats missing previousPathsCount as 0 (first ever recording)', () => {
    const entry = buildHistoryEntry(PARSED_SPEC, 'hash-abc', undefined);
    // 4 paths, previous = 0 → delta = 4
    expect(entry.paths_delta).toBe(4);
  });

  it('returns the correct version and hash', () => {
    const entry = buildHistoryEntry(PARSED_SPEC, 'deadbeef', 0);
    expect(entry.version).toBe('1.0.0');
    expect(entry.hash).toBe('deadbeef');
  });

  it('sets recorded_at to a valid ISO 8601 timestamp', () => {
    const before = Date.now();
    const entry = buildHistoryEntry(PARSED_SPEC, 'h', 0);
    const after = Date.now();
    const ts = new Date(entry.recorded_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('buildCatalogEntry', () => {
  it('caps history at 10 entries when content changes on every crawl', () => {
    let entry = null;
    // Simulate 12 consecutive crawls, each with different content
    for (let i = 0; i < 12; i++) {
      const h = computeHash(`raw-content-revision-${i}`);
      entry = buildCatalogEntry(
        'spec-id',
        'https://example.com/spec.yaml',
        { ...PARSED_SPEC, api_version: `1.0.${i}`, paths_count: i + 1 },
        h,
        `"etag-${i}"`,
        entry,
      );
    }

    expect(entry.history).toHaveLength(10);
    // History is newest-first — revision 11 is at index 0
    expect(entry.history[0].version).toBe('1.0.11');
    expect(entry.history[9].version).toBe('1.0.2');
  });

  it('does not grow history beyond 10 regardless of how many runs occur', () => {
    let entry = null;
    for (let i = 0; i < 25; i++) {
      const h = computeHash(`content-${i}`);
      entry = buildCatalogEntry('id', 'https://example.com/s.yaml', PARSED_SPEC, h, null, entry);
    }
    expect(entry.history.length).toBeLessThanOrEqual(10);
  });

  it('does not append a history entry when content hash is unchanged', () => {
    const h = computeHash('stable-content');
    const first = buildCatalogEntry('id', 'https://example.com/s.yaml', PARSED_SPEC, h, '"etag-1"', null);
    const second = buildCatalogEntry('id', 'https://example.com/s.yaml', PARSED_SPEC, h, '"etag-2"', first);

    expect(second.history).toHaveLength(1);
  });

  it('sets status to active', () => {
    const h = computeHash('c');
    const entry = buildCatalogEntry('id', 'https://example.com/s.yaml', PARSED_SPEC, h, null, null);
    expect(entry.status).toBe('active');
  });
});
