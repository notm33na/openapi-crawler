import 'dotenv/config';
import path from 'path';
import { crawl } from './src/crawler.js';
import { schedulePolling } from './src/updater.js';

// ── Argument parser ───────────────────────────────────────────────────────────

/**
 * Parses process.argv into a command name and a flags map.
 * Supports --flag value and --flag=value forms.
 * The first non-flag token is the command.
 *
 * @param {string[]} argv - Argument list (typically process.argv.slice(2))
 * @returns {{ command: string|null, flags: Record<string, string|true> }}
 */
function parseArgs(argv) {
  let command = null;
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (command === null) {
      command = arg;
    }
  }

  return { command, flags };
}

// ── Summary table ─────────────────────────────────────────────────────────────

/**
 * Prints a formatted summary table to stdout after a crawl run.
 * @param {{ new: number, updated: number, unchanged: number, failed: number }} stats
 */
function printSummaryTable(stats) {
  const rows = [
    ['New specs',    stats.new],
    ['Updated',      stats.updated],
    ['Unchanged',    stats.unchanged],
    ['Failed',       stats.failed],
  ];
  const total = stats.new + stats.updated + stats.unchanged + stats.failed;

  const labelW = Math.max(...rows.map(([l]) => l.length), 'Total'.length);
  const valueW = Math.max(...[...rows.map(([, v]) => v), total].map((v) => String(v).length));

  const divider = (l, mid, r) =>
    l + '─'.repeat(labelW + 2) + mid + '─'.repeat(valueW + 2) + r;

  const row = (label, value, bold = false) => {
    const v = String(value).padStart(valueW);
    const l = label.padEnd(labelW);
    return `│ ${bold ? l.toUpperCase() : l} │ ${v} │`;
  };

  console.log('');
  console.log(divider('┌', '┬', '┐'));
  console.log(`│${'  Crawl Summary'.padEnd(labelW + valueW + 5)}│`);
  console.log(divider('├', '┼', '┤'));
  for (const [label, value] of rows) {
    console.log(row(label, value));
  }
  console.log(divider('├', '┼', '┤'));
  console.log(row('Total', total, true));
  console.log(divider('└', '┴', '┘'));
  console.log('');
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
openapi-crawler — discover and track OpenAPI specs on GitHub

Usage:
  node index.js <command> [flags]

Commands:
  crawl     Search GitHub for OpenAPI specs and update the catalog (one-shot)
  update    Start the polling scheduler to re-check specs on an interval

Flags:
  --limit <n>          Max specs to crawl (default: CRAWL_LIMIT env or 50)
  --output <path>      Path to catalog.json (default: catalog.json)
  --queries <q1,q2>    Comma-separated GitHub search queries
                       (default: filename:openapi.yaml,filename:openapi.json,
                                 filename:swagger.yaml,filename:swagger.json)

Examples:
  node index.js crawl
  node index.js crawl --limit 100 --output ./data/catalog.json
  node index.js crawl --queries "filename:openapi.yaml,filename:swagger.yaml"
  node index.js update --output ./data/catalog.json
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  // ── crawl ──────────────────────────────────────────────────────────────────
  if (command === 'crawl') {
    const limit = parseInt(flags.limit ?? process.env.CRAWL_LIMIT ?? '50', 10);
    if (Number.isNaN(limit) || limit < 1) {
      console.error('Error: --limit must be a positive integer.');
      process.exit(1);
    }

    const catalogPath = path.resolve(String(flags.output ?? 'catalog.json'));

    const queries =
      typeof flags.queries === 'string'
        ? flags.queries.split(',').map((q) => q.trim()).filter(Boolean)
        : undefined;

    console.log(
      `Starting crawl  limit=${limit}  output=${catalogPath}` +
      (queries ? `  queries=${queries.join(', ')}` : '')
    );

    const stats = await crawl({ limit, catalogPath, queries });
    printSummaryTable(stats);
    return;
  }

  // ── update ─────────────────────────────────────────────────────────────────
  if (command === 'update') {
    const catalogPath = path.resolve(String(flags.output ?? 'catalog.json'));
    const queries =
      typeof flags.queries === 'string'
        ? flags.queries.split(',').map((q) => q.trim()).filter(Boolean)
        : undefined;

    console.log(
      `Starting update scheduler  output=${catalogPath}` +
      `  interval=${process.env.POLL_INTERVAL_HOURS ?? 24}h`
    );
    console.log('Press Ctrl-C to stop.\n');

    const task = schedulePolling({ catalogPath, queries });

    process.on('SIGINT', () => {
      if (task && typeof task.stop === 'function') task.stop();
      console.log('\nScheduler stopped.');
      process.exit(0);
    });
    return;
  }

  // ── unknown / missing command ──────────────────────────────────────────────
  if (command !== null) {
    console.error(`Unknown command: "${command}"`);
  }
  printHelp();
  process.exit(command === null ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err.message ?? err);
  process.exit(1);
});
