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


---

## Known tradeoffs

**GitHub search only covers indexed public repositories.** Newly created or rarely-starred repos may not appear in search results for days. Private repos require a token with `repo` scope and will only surface repos the token owner can read.

**1000-result cap per query.** The GitHub code search API returns at most 1000 results per query regardless of pagination. It means the crawler cannot exhaustively index all public OpenAPI files on GitHub in a single run. Rotating queries (e.g. by language, topic, or org) can increase coverage.

**No webhook support.** The crawler is pull-based: it discovers changes by re-fetching on a schedule. A repo that publishes a new spec version between two crawl runs will not be reflected in the catalog until the next run. GitHub App webhooks on `push` events would give near-real-time updates but require a public-facing server to receive them.
