/**
 * The proxy's log of refusals (incident-platform backlog #0-313 AC8; opencomputer's modelproxy, its design only): a
 * looping agent cannot flood it. A line per run and reason at most every 10 s; the next line of that pair counts those
 * skipped meanwhile. A line names the run (the dispatcher's runId), the reason (one of the proxy's own words) and, for
 * a path refused, the request's path alone: no query (a client's free text), no header, no value of the request's or
 * of upstream's (#0-284's rule), the path cut to 200 characters and quoted as JSON, so no control character reaches
 * the log.
 */

/** The longest part of a path a line keeps. */
export const PATH_KEPT = 200;
/** At most one line per run and reason in this many ms. */
export const LOG_EVERY_MS = 10_000;

/** A request's path for a log line: before any `?`, cut, quoted. */
export function pathForLog(url) {
  const path = String(url ?? '').split('?')[0].split('#')[0];
  return JSON.stringify(path.length > PATH_KEPT ? `${path.slice(0, PATH_KEPT)}…` : path);
}

/**
 * @param {{ write: (line: string) => void, runId: string, now?: () => number, everyMs?: number }} options `now` and
 *   `everyMs` for the tests
 * @returns {(reason: string, detail?: string) => void} logs a refusal, `detail` the proxy's own (pathForLog's)
 */
export function refusalLog({ write, runId, now = Date.now, everyMs = LOG_EVERY_MS }) {
  const last = new Map();
  return (reason, detail = '') => {
    const at = now();
    const seen = last.get(reason);
    if (seen !== undefined && at - seen.at < everyMs) {
      seen.skipped += 1;
      return;
    }
    const skipped = seen?.skipped ?? 0;
    last.set(reason, { at, skipped: 0 });
    const more = skipped > 0 ? ` (${skipped} more like it not logged)` : '';
    try {
      write(`dispatcher proxy: run ${runId}: ${reason}${detail === '' ? '' : ` ${detail}`}${more}\n`);
    } catch {
      // stderr is gone: the line is lost, the refusal is not.
    }
  };
}
