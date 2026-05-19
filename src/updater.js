import cron from 'node-cron';
import 'dotenv/config';

import { crawl } from './crawler.js';

/**
 * Converts a polling interval in whole hours to a cron expression.
 * Hours = 1 → "0 * * * *" (every hour on the hour).
 * Hours > 1 → "0 * /N * * *" (every N hours on the hour, where N = intervalHours).
 *
 * @param {number} intervalHours - Positive integer number of hours
 * @returns {string} Cron expression
 * @throws {Error} When intervalHours is not a positive integer
 */
export function intervalToCron(intervalHours) {
  if (!Number.isInteger(intervalHours) || intervalHours < 1) {
    throw new Error(`intervalHours must be a positive integer, got: ${intervalHours}`);
  }
  return intervalHours === 1 ? '0 * * * *' : `0 */${intervalHours} * * *`;
}

/**
 * Checks a single source URL for spec changes. Left as a no-op stub because
 * the update cycle is driven by full crawl() runs rather than per-URL checks.
 * Kept for API compatibility.
 *
 * @param {string} _sourceUrl
 * @param {object} _catalog
 */
export async function checkForUpdate(_sourceUrl, _catalog) {}

/**
 * Runs a full crawl pass with the given options.
 * @param {{ catalogPath?: string, queries?: string[] }} [options={}]
 * @returns {Promise<{ new: number, updated: number, unchanged: number, failed: number }>}
 */
export async function runUpdatePass(options = {}) {
  return crawl(options);
}

/**
 * Schedules recurring crawl runs on the interval set by POLL_INTERVAL_HOURS
 * (defaults to 24). Executes one run immediately on startup, then on the cron
 * schedule. Logs a structured JSON line before each run and after, including
 * the time of the next scheduled run.
 *
 * @param {{ catalogPath?: string, queries?: string[] }} [options={}]
 * @returns {cron.ScheduledTask} The scheduled cron task — call .stop() to cancel
 */
export function schedulePolling(options = {}) {
  const intervalHours = parseInt(process.env.POLL_INTERVAL_HOURS ?? '24', 10);
  const cronExpr = intervalToCron(intervalHours);

  function logJson(level, event, data = {}) {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + '\n'
    );
  }

  async function runPass() {
    logJson('info', 'scheduler.run.start', { interval_hours: intervalHours });
    try {
      const stats = await runUpdatePass(options);
      logJson('info', 'scheduler.run.done', { ...stats });
    } catch (err) {
      logJson('error', 'scheduler.run.failed', { error: err.message });
    }
    const nextRunAt = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
    logJson('info', 'scheduler.next_run', { next_run_at: nextRunAt, interval_hours: intervalHours });
  }

  // Run once immediately on startup, then on the cron schedule
  runPass();
  return cron.schedule(cronExpr, runPass);
}
