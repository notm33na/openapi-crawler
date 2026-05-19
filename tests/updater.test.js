import { describe, it, expect, jest } from '@jest/globals';

// Mock node-cron before updater.js is imported — Jest's VM ESM loader
// cannot parse node-cron's CJS bundle in this config without a transform.
jest.unstable_mockModule('node-cron', () => ({
  default: { schedule: jest.fn(() => ({ stop: jest.fn() })) },
}));

// Mock crawler.js to prevent transitive import of Bottleneck timers
jest.unstable_mockModule('../src/crawler.js', () => ({
  crawl: jest.fn(),
  searchGitHub: jest.fn(),
  getDefaultBranch: jest.fn(),
  repoDefaultBranchCache: new Map(),
}));

const { intervalToCron } = await import('../src/updater.js');

// ── intervalToCron ────────────────────────────────────────────────────────────

describe('intervalToCron', () => {
  it('returns "0 * * * *" for 1 hour', () => {
    expect(intervalToCron(1)).toBe('0 * * * *');
  });

  it('returns "0 */6 * * *" for 6 hours', () => {
    expect(intervalToCron(6)).toBe('0 */6 * * *');
  });

  it('returns "0 */24 * * *" for 24 hours', () => {
    expect(intervalToCron(24)).toBe('0 */24 * * *');
  });

  it('returns "0 */12 * * *" for 12 hours', () => {
    expect(intervalToCron(12)).toBe('0 */12 * * *');
  });

  it('throws for 0 hours', () => {
    expect(() => intervalToCron(0)).toThrow();
  });

  it('throws for a negative number', () => {
    expect(() => intervalToCron(-1)).toThrow();
  });

  it('throws for a non-integer (float)', () => {
    expect(() => intervalToCron(1.5)).toThrow();
  });

  it('includes the invalid value in the error message', () => {
    expect(() => intervalToCron(0)).toThrow('0');
  });
});
