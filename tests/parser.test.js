import { describe, it, expect, beforeEach } from '@jest/globals';
import { parseSpec, ParseError } from '../src/parser.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OAS3_JSON = JSON.stringify({
  openapi: '3.0.3',
  info: {
    title: 'Inventory API',
    version: '2.1.0',
    description: 'Tracks warehouse inventory.',
  },
  paths: {
    '/items': {},
    '/items/{id}': {},
    '/locations': {},
  },
  servers: [{ url: 'https://api.example.com/v2' }],
  tags: [{ name: 'items' }, { name: 'locations' }],
});

// OAS 2.x expressed in YAML — tests the YAML parse path explicitly
const OAS2_YAML = `
swagger: "2.0"
info:
  title: Widget API
  version: "1.4.0"
  description: Manages widgets.
host: api.widgets.io
basePath: /v1
schemes:
  - https
paths:
  /widgets: {}
  /widgets/{id}: {}
tags:
  - name: widgets
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wraps an object as a JSON string so callers look like network responses. */
const raw = (obj) => JSON.stringify(obj);

// ── parser.js ─────────────────────────────────────────────────────────────────

describe('parseSpec', () => {
  describe('valid OAS 3.x JSON spec', () => {
    it('returns correct metadata', () => {
      const result = parseSpec(OAS3_JSON, 'https://api.example.com/openapi.json');

      expect(result).toEqual({
        title: 'Inventory API',
        oas_version: '3.0.3',
        api_version: '2.1.0',
        paths_count: 3,
        description: 'Tracks warehouse inventory.',
        servers: ['https://api.example.com/v2'],
        tags: ['items', 'locations'],
      });
    });

    it('reads the openapi field as oas_version', () => {
      const spec = raw({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: {} });
      expect(parseSpec(spec).oas_version).toBe('3.1.0');
    });
  });

  describe('valid OAS 2.x YAML spec', () => {
    it('returns correct metadata', () => {
      const result = parseSpec(OAS2_YAML, 'https://api.widgets.io/swagger.yaml');

      expect(result.title).toBe('Widget API');
      expect(result.oas_version).toBe('2.0');
      expect(result.api_version).toBe('1.4.0');
      expect(result.paths_count).toBe(2);
      expect(result.description).toBe('Manages widgets.');
      expect(result.servers).toEqual(['https://api.widgets.io/v1']);
      expect(result.tags).toEqual(['widgets']);
    });

    it('reads the swagger field as oas_version', () => {
      expect(parseSpec(OAS2_YAML).oas_version).toBe('2.0');
    });
  });

  describe('ParseError — neither valid JSON nor YAML', () => {
    it('throws ParseError', () => {
      expect(() => parseSpec('{key: [broken: yaml}}}')).toThrow(ParseError);
    });

    it('error message mentions invalid JSON and invalid YAML', () => {
      let err;
      try { parseSpec('{key: [broken: yaml}}}'); } catch (e) { err = e; }
      expect(err.message).toMatch(/invalid JSON/i);
      expect(err.message).toMatch(/invalid YAML/i);
    });

    it('throws ParseError for empty string', () => {
      expect(() => parseSpec('')).toThrow(ParseError);
    });
  });

  describe('ParseError — OAS version cannot be determined', () => {
    it('throws ParseError when neither swagger nor openapi key is present', () => {
      const noVersion = raw({ info: { title: 'X', version: '1' }, paths: {} });
      expect(() => parseSpec(noVersion)).toThrow(ParseError);
    });

    it('error message says cannot determine OAS version', () => {
      const noVersion = raw({ info: { title: 'X', version: '1' }, paths: {} });
      expect(() => parseSpec(noVersion)).toThrow('cannot determine OAS version');
    });

    it('attaches sourceUrl to the error when provided', () => {
      const noVersion = raw({ info: { title: 'X', version: '1' } });
      let err;
      try { parseSpec(noVersion, 'https://example.com/bad.json'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ParseError);
      expect(err.sourceUrl).toBe('https://example.com/bad.json');
      expect(err.message).toContain('https://example.com/bad.json');
    });
  });

  describe('description truncation', () => {
    it('truncates description longer than 300 characters to exactly 300', () => {
      const longDesc = 'A'.repeat(400);
      const spec = raw({ openapi: '3.0.0', info: { title: 'T', version: '1', description: longDesc }, paths: {} });
      const result = parseSpec(spec);
      expect(result.description).toHaveLength(300);
      expect(result.description).toBe('A'.repeat(300));
    });

    it('does not truncate a description of exactly 300 characters', () => {
      const exact = 'B'.repeat(300);
      const spec = raw({ openapi: '3.0.0', info: { title: 'T', version: '1', description: exact }, paths: {} });
      expect(parseSpec(spec).description).toHaveLength(300);
    });

    it('preserves a description shorter than 300 characters unchanged', () => {
      const short = 'Short description.';
      const spec = raw({ openapi: '3.0.0', info: { title: 'T', version: '1', description: short }, paths: {} });
      expect(parseSpec(spec).description).toBe(short);
    });
  });

  describe('missing paths', () => {
    it('returns paths_count of 0 when paths key is absent', () => {
      const spec = raw({ openapi: '3.0.0', info: { title: 'T', version: '1' } });
      expect(parseSpec(spec).paths_count).toBe(0);
    });

    it('returns paths_count of 0 when paths is an empty object', () => {
      const spec = raw({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} });
      expect(parseSpec(spec).paths_count).toBe(0);
    });

    it('returns paths_count of 0 when paths is null', () => {
      const spec = raw({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: null });
      expect(parseSpec(spec).paths_count).toBe(0);
    });
  });
});
