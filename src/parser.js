import yaml from 'js-yaml';

const DESCRIPTION_MAX_LENGTH = 300;
const TAGS_MAX_COUNT = 10;

export class ParseError extends Error {
  /**
   * @param {string} reason - Human-readable reason for the parse failure
   * @param {string} [sourceUrl] - URL of the spec that failed, if available
   */
  constructor(reason, sourceUrl) {
    const message = sourceUrl
      ? `ParseError for ${sourceUrl}: ${reason}`
      : `ParseError: ${reason}`;
    super(message);
    this.name = 'ParseError';
    this.reason = reason;
    this.sourceUrl = sourceUrl ?? null;
  }
}

/**
 * Attempts JSON.parse first, then js-yaml. Throws ParseError if both fail.
 * @param {string} rawContent
 * @param {string} sourceUrl
 * @returns {object}
 */
function deserialize(rawContent, sourceUrl) {
  if (typeof rawContent !== 'string' || rawContent.trim() === '') {
    throw new ParseError('content is empty or not a string', sourceUrl);
  }

  // JSON.parse is faster and unambiguous for JSON — try it first
  try {
    return JSON.parse(rawContent);
  } catch {
    // Not JSON — fall through to YAML
  }

  try {
    const doc = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new ParseError('YAML parsed to a non-object value', sourceUrl);
    }
    return doc;
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(`invalid JSON and invalid YAML: ${err.message}`, sourceUrl);
  }
}

/**
 * Reads the OAS version string from the root object.
 * Returns { family: 'oas2'|'oas3', raw: string }.
 * Throws ParseError when neither "swagger" nor "openapi" keys are present.
 * @param {object} spec
 * @param {string} sourceUrl
 * @returns {{ family: 'oas2'|'oas3', raw: string }}
 */
function detectVersion(spec, sourceUrl) {
  if (typeof spec.swagger === 'string') {
    return { family: 'oas2', raw: spec.swagger };
  }
  if (typeof spec.openapi === 'string') {
    return { family: 'oas3', raw: spec.openapi };
  }
  throw new ParseError('cannot determine OAS version', sourceUrl);
}

/**
 * Builds the servers list.
 *   OAS 3: spec.servers[].url
 *   OAS 2: one entry constructed from host + basePath (scheme defaults to https)
 * @param {object} spec
 * @param {'oas2'|'oas3'} family
 * @returns {string[]}
 */
function extractServers(spec, family) {
  if (family === 'oas3') {
    if (!Array.isArray(spec.servers)) return [];
    return spec.servers
      .map((s) => (typeof s?.url === 'string' ? s.url.trim() : null))
      .filter(Boolean);
  }

  // OAS 2 — reconstruct from host / basePath / schemes
  const host = typeof spec.host === 'string' ? spec.host.trim() : '';
  if (!host) return [];

  const basePath =
    typeof spec.basePath === 'string' ? spec.basePath.trim() : '/';
  const schemes = Array.isArray(spec.schemes) && spec.schemes.length > 0
    ? spec.schemes
    : ['https'];

  return schemes.map((scheme) => `${scheme}://${host}${basePath}`);
}

/**
 * Parses raw OpenAPI/Swagger spec content and extracts normalised metadata.
 *
 * @param {string} rawContent - Raw JSON or YAML string
 * @param {string} [sourceUrl=''] - Origin URL used in error messages
 * @returns {{
 *   title: string,
 *   oas_version: string,
 *   api_version: string,
 *   paths_count: number,
 *   description: string,
 *   servers: string[],
 *   tags: string[]
 * }}
 * @throws {ParseError}
 */
export function parseSpec(rawContent, sourceUrl = '') {
  const spec = deserialize(rawContent, sourceUrl);
  const { family, raw: oas_version } = detectVersion(spec, sourceUrl);

  const info = spec.info && typeof spec.info === 'object' ? spec.info : {};

  const title =
    typeof info.title === 'string' ? info.title.trim() : '';

  const api_version =
    typeof info.version === 'string' ? String(info.version).trim() : '';

  const rawDescription =
    typeof info.description === 'string' ? info.description : '';
  const description =
    rawDescription.length > DESCRIPTION_MAX_LENGTH
      ? rawDescription.slice(0, DESCRIPTION_MAX_LENGTH)
      : rawDescription;

  const paths_count =
    spec.paths && typeof spec.paths === 'object' && !Array.isArray(spec.paths)
      ? Object.keys(spec.paths).length
      : 0;

  const servers = extractServers(spec, family);

  const tags = Array.isArray(spec.tags)
    ? spec.tags
        .slice(0, TAGS_MAX_COUNT)
        .map((t) => (typeof t?.name === 'string' ? t.name.trim() : null))
        .filter(Boolean)
    : [];

  return { title, oas_version, api_version, paths_count, description, servers, tags };
}
