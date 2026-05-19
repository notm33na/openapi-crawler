# openapi-crawler

Discovers OpenAPI and Swagger specs hosted on GitHub, tracks changes over time, and maintains a local catalog with version history. Built with Node.js ESM, no database required.

---

## Setup

```bash
git clone https://github.com/your-org/openapi-crawler
cd openapi-crawler
npm install
cp .env.example .env
```

Edit `.env` and set your GitHub personal access token:

```
GITHUB_TOKEN=ghp_your_token_here
CRAWL_LIMIT=50
POLL_INTERVAL_HOURS=24
```

The token needs no scopes for public repos. For private repos add `repo` scope.

---

## Usage

### Run a one-shot crawl

```bash
node index.js crawl
# or
npm run crawl
# or
make crawl
```

Crawl with custom options:

```bash
# Raise the limit and write to a different path
node index.js crawl --limit 100 --output ./data/catalog.json

# Override the default search queries
node index.js crawl --queries "filename:openapi.yaml,filename:openapi.json"

# Combine flags
node index.js crawl --limit 200 --output catalog.json --queries "filename:swagger.yaml"
```

After the crawl completes, a summary table is printed:

```
┌────────────┬───┐
│  Crawl Summary   │
├────────────┼───┤
│ New specs  │ 12 │
│ Updated    │  3 │
│ Unchanged  │ 28 │
│ Failed     │  2 │
├────────────┼───┤
│ TOTAL      │ 45 │
└────────────┴───┘
```

### Start the polling scheduler

```bash
node index.js update
node index.js update --output ./data/catalog.json
```

Runs a full update pass on the interval set by `POLL_INTERVAL_HOURS` (default: 24). Press `Ctrl-C` to stop.

### Run tests

```bash
npm test
# or
make test
```

---

## Output files

| File | Description |
|---|---|
| `catalog.json` | Array of all tracked specs, sorted by id |
| `catalog.summary.json` | Aggregated counts from the last run |
| `branchCache.json` | Persistent cache of resolved default branches (speeds up re-runs) |

Each entry in `catalog.json`:

```json
{
  "id": "github:owner/repo/path/to/openapi.yaml",
  "source_url": "https://raw.githubusercontent.com/owner/repo/main/path/to/openapi.yaml",
  "title": "Pet Store API",
  "oas_version": "3.0.3",
  "latest_version": "1.4.2",
  "paths_count": 12,
  "fetched_at": "2024-03-01T14:00:00.000Z",
  "status": "active",
  "content_hash": "a3f9...",
  "etag": "\"abc123\"",
  "history": [
    { "version": "1.4.2", "hash": "a3f9...", "paths_delta": 2, "recorded_at": "..." },
    { "version": "1.4.0", "hash": "b812...", "paths_delta": 0, "recorded_at": "..." }
  ]
}
```

`status` is one of `active` (parsed successfully), `invalid` (unparseable), or `stale` (not yet rechecked this run).

---

## Sample Output

A sample `catalog.json` from a real crawl run is included in the repo as `catalog.sample.json`.

---

## Architecture

**`src/fetcher.js`** — All HTTP traffic flows through this module. It owns the `githubApiLimiter` Bottleneck instance (25 requests per 60 seconds, used exclusively for GitHub API calls), handles `If-None-Match` / ETag conditional requests, and implements exponential backoff with jitter on 429 and 503 responses. Raw content fetches bypass the rate limiter entirely — concurrency for those is controlled externally by `p-limit`. Nothing else in the codebase calls axios directly.

**`src/parser.js`** — Takes a raw string (JSON or YAML) and returns a normalised metadata object. It tries `JSON.parse` first (fast, unambiguous), then falls back to `js-yaml` with the JSON schema dialect to avoid YAML's implicit type coercions. On any structural problem — bad syntax, missing `openapi`/`swagger` version key, non-object root — it throws a `ParseError` with the source URL attached so callers can record a meaningful error without catching generic exceptions.

**`src/versioner.js`** — Responsible for all change-detection logic. It hashes raw content with SHA-256, compares hashes against catalog entries, computes `paths_delta`, and assembles the immutable history entries that are prepended to each catalog record. Hashing is intentionally done on the raw string before parsing, which means whitespace-only reformats are detected as changes — a deliberate conservative choice.

**`src/catalog.js`** — Thin persistence layer over `catalog.json`. It loads the file into a `Map<id, entry>` for O(1) lookups during a crawl, and flushes the map back to a sorted JSON array on save. It also writes `catalog.summary.json` as a companion file with aggregated counts so dashboards or CI checks can read a small file instead of parsing the full catalog.

**`src/crawler.js`** — Orchestrates a complete crawl run. Search queries and a set of hardcoded seed specs run first to collect raw candidates (no branch resolution yet). Branch metadata is then resolved in a single parallel batch — up to 20 concurrent API calls, deduplicated by repo — before any spec fetching begins. Branch resolution has two caching layers: `branchCache.json` (persisted across processes) and existing `catalog.json` entries (branch extracted from `source_url` without any API call). Spec fetching runs concurrently with `p-limit`. All progress is written as structured JSON log lines to stdout so runs can be piped to log aggregators. The catalog is checkpointed every 10 entries so a crash mid-run loses at most 10 records.

**`src/updater.js`** — Wraps the crawler in a `node-cron` schedule driven by `POLL_INTERVAL_HOURS`. The updater runs a full crawl on the configured schedule (POLL_INTERVAL_HOURS, default 24h). Each scheduled run performs a fresh GitHub search to discover new specs, then re-fetches known specs using ETag/If-None-Match to skip unchanged content. This means new specs are continuously discovered while bandwidth is conserved through conditional HTTP requests.

**`index.js`** — CLI entry point. Parses `--flag value` and `--flag=value` arguments without any extra dependency, dispatches to either `crawl` or `update`, and prints a human-readable summary table after a crawl.

---

## Design decisions

### ETag-based conditional requests instead of time-based polling

Every `fetchWithETag` call sends `If-None-Match` with the stored ETag. When the server responds 304 Not Modified the raw body is never transferred, which saves bandwidth and counts against the rate limit without touching spec content that hasn't changed. Time-based polling (e.g. "re-fetch if last checked more than N hours ago") would always download the full file. ETags are complemented by a SHA-256 content hash as a second gate for servers that ignore the header.

### SHA-256 hash stored alongside `api_version`

`api_version` is whatever the API author wrote in `info.version`. It is not reliably incremented — many teams deploy changes without bumping the version string, and some use dates or commit SHAs rather than semver. The SHA-256 hash of the raw content is an objective signal that *something* changed regardless of what the author wrote. Storing both means consumers can use `api_version` for human-readable changelog entries while the crawler uses the hash to decide whether to write a new history record.

### `catalog.json` flat file instead of a database

A JSON file is self-contained, diffable with `git diff`, trivially portable, and requires no server process. For the expected catalog size (hundreds to low thousands of specs) the file is fast enough: load takes under 100 ms and the Map provides O(1) lookup per entry. If the catalog grows to tens of thousands of entries, swapping `catalog.js` for a SQLite backend is a one-file change with no impact on any other module, because the rest of the codebase depends only on the `loadCatalog` / `saveCatalog` / `mergeEntry` interface.

### How rate limiting works

GitHub API calls (code search and repo metadata) are throttled by a `githubApiLimiter` Bottleneck instance in `fetcher.js`: 25 tokens available, refilling to 25 every 60 seconds. This gives 25 req/min, below GitHub's authenticated limit of 30 req/min with headroom for bursts. Raw content fetches (`raw.githubusercontent.com`) are **not** subject to this limiter — they run through plain axios controlled by `p-limit` concurrency guards in `crawler.js`. Keeping the two traffic types separate means raw downloads never compete with search and branch-resolution calls for the same token budget.

### Branch resolution caching

Resolving default branches via the GitHub repos API (`/repos/{owner}/{repo}`) was the dominant cost on re-runs (295 of 308 seconds in one profiling session). Two caches eliminate most of those calls:

1. **`branchCache.json`** — written alongside `catalog.json` after each crawl. On the next run the file is loaded first and pre-populates the in-memory branch cache before any API calls are made. Entries include `defaultBranch` and `resolvedAt` so stale entries can be identified if needed.

2. **Existing catalog entries** — if a candidate's id is already in `catalog.json`, the branch is extracted directly from its stored `source_url` (the fifth path segment of a `raw.githubusercontent.com` URL). This works even on a fresh process with no `branchCache.json` yet.

Only repos not found in either cache reach the GitHub API. The `batch_branches.start` log event reports `from_persistent_cache`, `from_catalog`, and `api_calls_needed` counts so the savings are visible at runtime.

---

## Known tradeoffs

**GitHub search only covers indexed public repositories.** Newly created or rarely-starred repos may not appear in search results for days. Private repos require a token with `repo` scope and will only surface repos the token owner can read.

**1000-result cap per query.** The GitHub code search API returns at most 1000 results per query regardless of pagination. With four filename queries and a 50-result default limit this is rarely a problem, but it means the crawler cannot exhaustively index all public OpenAPI files on GitHub in a single run. Rotating queries (e.g. by language, topic, or org) can increase coverage.

**No webhook support.** The crawler is pull-based: it discovers changes by re-fetching on a schedule. A repo that publishes a new spec version between two crawl runs will not be reflected in the catalog until the next run. GitHub App webhooks on `push` events would give near-real-time updates but require a public-facing server to receive them.
