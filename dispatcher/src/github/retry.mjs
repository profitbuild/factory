/**
 * The one helper every GitHub call of the dispatcher's flow goes through (incident-platform backlog #0-275 AC4,
 * #0-261): a transient failure is retried with backoff and jitter, and is not counted as one of the task's attempts;
 * ten in a row stop the task as BLOCKED with the reason (tasks.mjs, runPhases).
 *
 * Transient, read from the error app-token.mjs's githubRequest throws, never from its message:
 * - an answer 5xx or 429;
 * - an answer 403 that is a rate limit: with a Retry-After header, or x-ratelimit-remaining 0 (GitHub sends its
 *   secondary rate limit as 403 or 429); any other 403 is an answer, and returns at once;
 * - no answer: `kind` 'timeout', or 'network' (a refused connection, a reset, a DNS error).
 * Anything else (404, 422, a refusal of checked-token.mjs, an error with neither `status` nor `kind`) is thrown at
 * once.
 *
 * The wait after the n-th failure in a row: d = min(60 s, 1 s · 2^(n-1)), drawn in [d/2, d) (jitter), and no shorter
 * than the answer's Retry-After, itself held to 60 s. Ten failures take about four minutes. The clock (`sleep`) and
 * the randomness (`random`) are the caller's to inject.
 *
 * A call retried may have happened (a POST whose answer timed out): a caller whose call is not idempotent makes it so
 * (the flow looks for a branch's pull request before it opens one, 4.4).
 */
import { setTimeout as delay } from 'node:timers/promises';

import { githubRequest } from './app-token.mjs';

/** Transient failures in a row that stop the task. */
export const MAX_IN_A_ROW = 10;
/** The first wait; each next doubles, up to MAX_DELAY_MS. */
export const FIRST_DELAY_MS = 1000;
export const MAX_DELAY_MS = 60 * 1000;

/** GitHub failed MAX_IN_A_ROW times in a row, each time transiently: the task is BLOCKED with this as the reason. */
export class GitHubUnavailableError extends Error {}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransient(error) {
  if (error?.kind === 'timeout' || error?.kind === 'network') {
    return true;
  }
  const status = error?.status;
  if (!Number.isInteger(status)) {
    return false;
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return status === 403 && (error.retryAfterMs !== undefined || error.rateLimitRemaining === 0);
}

/**
 * The wait after the `failures`-th transient failure in a row.
 *
 * @param {number} failures 1 for the first
 * @param {() => number} random in [0, 1)
 * @param {number} [retryAfterMs] the answer's Retry-After
 */
export function backoffMs(failures, random, retryAfterMs = 0) {
  const ceiling = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (failures - 1));
  const drawn = ceiling / 2 + random() * (ceiling / 2);
  return Math.min(MAX_DELAY_MS, Math.max(drawn, retryAfterMs));
}

/**
 * Runs `call` until it succeeds, retrying a transient failure; a failure that is not transient is thrown at once.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @param {{ sleep?: (ms: number) => Promise<void>, random?: () => number,
 *   onRetry?: (retry: { failures: number, waitMs: number, error: Error }) => void }} [options]
 * @returns {Promise<T>}
 * @throws {GitHubUnavailableError} after MAX_IN_A_ROW transient failures in a row
 */
export async function withRetries(call, { sleep = delay, random = Math.random, onRetry } = {}) {
  for (let failures = 1; ; failures += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error)) {
        throw error;
      }
      if (failures >= MAX_IN_A_ROW) {
        throw new GitHubUnavailableError(`GitHub failed ${failures} times in a row, each time transiently (5xx, 429, `
          + `a rate limit, a timeout or a network error); the last: ${error.message}`, { cause: error });
      }
      const waitMs = backoffMs(failures, random, error.retryAfterMs);
      onRetry?.({ failures, waitMs, error });
      await sleep(waitMs);
    }
  }
}

/**
 * One GitHub REST call through withRetries: githubRequest's options (baseUrl, method, path, bearer, body, fetchImpl,
 * timeoutMs), and withRetries' as `retry`.
 *
 * @param {object} request
 * @param {Parameters<typeof withRetries>[1]} [retry]
 */
export function githubCall(request, retry) {
  return withRetries(() => githubRequest(request), retry);
}
