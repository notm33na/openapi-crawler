import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import path from 'path';

// ── fs/promises mock ──────────────────────────────────────────────────────────
// Must be registered before any dynamic import resolves catalog.js.

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
  },
}));

// Modules are loaded after the mock is in place so catalog.js picks up
// the mocked fs rather than the real one.
const fsMock = (await import('fs/promises')).default;
const { loadCatalog, saveCatalog, mergeEntry } = await import('../src/catalog.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CATALOG_PATH = '/data/catalog.json';

const ENTRY_ACTIVE  = { id: 'spec-a', title: 'Spec A', status: 'active',  content_hash: 'h-a', history: [] };
const ENTRY_STALE   = { id: 'spec-b', title: 'Spec B', status: 'stale',   content_hash: 'h-b', history: [] };
const ENTRY_INVALID = { id: 'spec-c', title: 'Spec C', status: 'invalid', content_hash: 'h-c', history: [] };

function enoent() {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

// ── catalog.js ────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset call history AND implementations so each test configures its own
  jest.resetAllMocks();
  // Default: writes always succeed
  fsMock.writeFile.mockResolvedValue(undefined);
});

describe('loadCatalog', () => {
  it('returns an empty Map when the file does not exist', async () => {
    fsMock.readFile.mockRejectedValue(enoent());

    const map = await loadCatalog(CATALOG_PATH);

    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('correctly indexes entries by id', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([ENTRY_ACTIVE, ENTRY_STALE, ENTRY_INVALID])
    );

    const map = await loadCatalog(CATALOG_PATH);

    expect(map.size).toBe(3);
    expect(map.get('spec-a')).toEqual(ENTRY_ACTIVE);
    expect(map.get('spec-b')).toEqual(ENTRY_STALE);
    expect(map.get('spec-c')).toEqual(ENTRY_INVALID);
  });

  it('calls readFile with the exact path and utf8 encoding', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify([]));

    await loadCatalog(CATALOG_PATH);

    expect(fsMock.readFile).toHaveBeenCalledWith(CATALOG_PATH, 'utf8');
  });

  it('propagates non-ENOENT read errors', async () => {
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    fsMock.readFile.mockRejectedValue(permError);

    await expect(loadCatalog(CATALOG_PATH)).rejects.toThrow('EACCES');
  });

  it('throws when the file contains non-array JSON', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ id: 'spec-a' }));

    await expect(loadCatalog(CATALOG_PATH)).rejects.toThrow('must be a JSON array');
  });
});

describe('saveCatalog', () => {
  it('writes a valid JSON array to disk at the given path', async () => {
    const map = new Map([['spec-a', ENTRY_ACTIVE]]);

    await saveCatalog(CATALOG_PATH, map);

    // First writeFile call → catalog.json
    const [writtenPath, writtenContent] = fsMock.writeFile.mock.calls[0];
    expect(writtenPath).toBe(CATALOG_PATH);

    const parsed = JSON.parse(writtenContent);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(ENTRY_ACTIVE);
  });

  it('sorts entries alphabetically by id', async () => {
    const map = new Map([
      ['spec-c', ENTRY_INVALID],
      ['spec-a', ENTRY_ACTIVE],
      ['spec-b', ENTRY_STALE],
    ]);

    await saveCatalog(CATALOG_PATH, map);

    const [, content] = fsMock.writeFile.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.map((e) => e.id)).toEqual(['spec-a', 'spec-b', 'spec-c']);
  });

  it('writes catalog.summary.json with correct status counts', async () => {
    const map = new Map([
      ['spec-a', ENTRY_ACTIVE],
      ['spec-b', ENTRY_STALE],
      ['spec-c', ENTRY_INVALID],
    ]);

    await saveCatalog(CATALOG_PATH, map, {
      new_this_run: 1,
      updated_this_run: 2,
      failed_this_run: 3,
    });

    // Two writeFile calls expected: catalog.json and catalog.summary.json
    expect(fsMock.writeFile).toHaveBeenCalledTimes(2);

    const [summaryPath, summaryContent] = fsMock.writeFile.mock.calls[1];
    expect(path.basename(summaryPath)).toBe('catalog.summary.json');

    const summary = JSON.parse(summaryContent);
    expect(summary.total).toBe(3);
    expect(summary.active).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.new_this_run).toBe(1);
    expect(summary.updated_this_run).toBe(2);
    expect(summary.failed_this_run).toBe(3);
    expect(typeof summary.last_run).toBe('string');
    expect(() => new Date(summary.last_run)).not.toThrow();
  });

  it('defaults run stats to 0 when the stats argument is omitted', async () => {
    const map = new Map([['spec-a', ENTRY_ACTIVE]]);

    await saveCatalog(CATALOG_PATH, map);

    const [, summaryContent] = fsMock.writeFile.mock.calls[1];
    const summary = JSON.parse(summaryContent);
    expect(summary.new_this_run).toBe(0);
    expect(summary.updated_this_run).toBe(0);
    expect(summary.failed_this_run).toBe(0);
  });

  it('writes the summary file next to the catalog file', async () => {
    const map = new Map([['spec-a', ENTRY_ACTIVE]]);
    const dir = path.join('some', 'nested', 'dir');
    const deepPath = path.join(dir, 'catalog.json');

    await saveCatalog(deepPath, map);

    const [summaryPath] = fsMock.writeFile.mock.calls[1];
    expect(path.dirname(summaryPath)).toBe(dir);
    expect(path.basename(summaryPath)).toBe('catalog.summary.json');
  });
});

describe('mergeEntry', () => {
  it('inserts a new entry keyed by its id', () => {
    const map = new Map();
    mergeEntry(map, ENTRY_ACTIVE);
    expect(map.size).toBe(1);
    expect(map.get('spec-a')).toBe(ENTRY_ACTIVE);
  });

  it('replaces an existing entry that shares the same id', () => {
    const map = new Map([['spec-a', ENTRY_ACTIVE]]);
    const updated = { ...ENTRY_ACTIVE, content_hash: 'new-hash', status: 'stale' };

    mergeEntry(map, updated);

    expect(map.size).toBe(1);
    expect(map.get('spec-a').content_hash).toBe('new-hash');
    expect(map.get('spec-a').status).toBe('stale');
  });

  it('does not touch other entries in the map', () => {
    const map = new Map([['spec-a', ENTRY_ACTIVE], ['spec-b', ENTRY_STALE]]);

    mergeEntry(map, { ...ENTRY_ACTIVE, content_hash: 'changed' });

    expect(map.get('spec-b')).toBe(ENTRY_STALE);
  });
});
