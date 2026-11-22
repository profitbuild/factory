/**
 * The breaker's counts and history, $FACTORY_STATE_DIR/state.json (incident-platform backlog #0-275): the semantics
 * of today's autopilot's `scripts/factory/state.sh` and `state_init` in incident-platform.
 *
 *   { "consecutiveBlocked": 0, "shippedSinceAudit": 0, "lastAudit": null, "history": [] }
 *
 * - a missing file is a fresh breaker, written as one;
 * - a file that cannot be read as one (not JSON, or the counts not counts) is a tripped breaker: losing the state must
 *   not silently re-arm the dispatcher. Unlike state.sh, the file is left as it is, not overwritten with a tripped
 *   one, so that the owner can repair it; resetting the breaker is the owner's, and not this code's;
 * - `shipped` resets consecutiveBlocked and counts one more since the audit; `blocked` counts one more in a row and
 *   records the stage it stopped in; the history keeps the last HISTORY_LIMIT outcomes.
 *
 * A file of the wrong owner or mode is refused outright (files.mjs), not taken as unreadable.
 *
 * Every read, and every read, change and write, runs whole under the state's lock (incident-platform backlog #0-303,
 * lock.mjs's withStateLock): two runs that record an outcome at once both count, and neither write is lost.
 */
import { join } from 'node:path';

import { NotJsonError, readJson, StateError, writeJsonAtomic } from './files.mjs';
import { withStateLock } from './lock.mjs';

/** Outcomes kept in the history, as state.sh keeps them. */
export const HISTORY_LIMIT = 200;
/** consecutiveBlocked of a breaker whose state cannot be read: tripped, whatever the limit. */
export const TRIPPED = 99;

const fresh = () => ({ consecutiveBlocked: 0, shippedSinceAudit: 0, lastAudit: null, history: [] });
const count = (value) => Number.isInteger(value) && value >= 0;

function readable(state) {
  return typeof state === 'object' && state !== null && !Array.isArray(state)
    && count(state.consecutiveBlocked) && count(state.shippedSinceAudit) && Array.isArray(state.history);
}

/**
 * The breaker in `stateDir`, written fresh when it has no state.json yet.
 *
 * @param {string} stateDir
 * @returns {Promise<{ path: string, state: object, unreadable: boolean }>} `unreadable`: state.json is there but is
 *   not a breaker's state; `state` is then a tripped one, never written
 */
export function openBreaker(stateDir) {
  return withStateLock(stateDir, () => openUnlocked(stateDir));
}

/** openBreaker, under a state's lock its caller holds. */
async function openUnlocked(stateDir) {
  const path = join(stateDir, 'state.json');
  let state;
  try {
    state = await readJson(path);
  } catch (error) {
    if (!(error instanceof NotJsonError)) {
      throw error;
    }
    return { path, state: { ...fresh(), consecutiveBlocked: TRIPPED }, unreadable: true };
  }
  if (state === undefined) {
    state = fresh();
    await writeJsonAtomic(path, state);
    return { path, state, unreadable: false };
  }
  if (!readable(state)) {
    return { path, state: { ...fresh(), consecutiveBlocked: TRIPPED }, unreadable: true };
  }
  return { path, state, unreadable: false };
}

/**
 * Why `run` is refused, or null: the breaker has tripped (FACTORY_MAX_BLOCKED blocked tasks in a row), or its state
 * cannot be read. The message tells the owner what to do; nothing here resets it.
 *
 * @param {{ path: string, state: object, unreadable: boolean }} breaker
 * @param {number} maxBlocked FACTORY_MAX_BLOCKED
 * @returns {string | null}
 */
export function breakerRefusal(breaker, maxBlocked) {
  if (breaker.unreadable) {
    return `the breaker's state ${breaker.path} cannot be read, so the breaker counts as tripped: repair the file `
      + '(consecutiveBlocked and shippedSinceAudit non-negative integers, history a list), or delete it knowingly, '
      + 'which resets the breaker to zero and forgets the history';
  }
  if (breaker.state.consecutiveBlocked >= maxBlocked) {
    return `the breaker has tripped: ${breaker.state.consecutiveBlocked} tasks blocked in a row, FACTORY_MAX_BLOCKED `
      + `is ${maxBlocked}; the owner looks at them, then resets the breaker`;
  }
  return null;
}

/**
 * Records a task's outcome, as `state.sh record` does.
 *
 * @param {string} stateDir
 * @param {{ outcome: 'shipped' | 'blocked', item: string, pr?: string | null, stage?: string | null,
 *   now?: () => number }} outcome `pr` the pull request's URL; `stage` the phase a blocked task stopped in
 * @returns {Promise<object>} the new state
 */
export function recordOutcome(stateDir, outcome) {
  return withStateLock(stateDir, () => recordUnlocked(stateDir, outcome));
}

async function recordUnlocked(stateDir, { outcome, item, pr = null, stage = null, now = Date.now }) {
  const breaker = await openUnlocked(stateDir);
  if (breaker.unreadable) {
    throw new StateError(breakerRefusal(breaker, 0));
  }
  const { state } = breaker;
  const t = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let next;
  if (outcome === 'shipped') {
    next = { ...state, consecutiveBlocked: 0, shippedSinceAudit: state.shippedSinceAudit + 1,
      history: [...state.history, { t, item, outcome, pr: pr ?? '' }] };
  } else if (outcome === 'blocked') {
    next = { ...state, consecutiveBlocked: state.consecutiveBlocked + 1,
      history: [...state.history, { t, item, outcome, pr: pr ?? '', ...(stage ? { stage } : {}) }] };
  } else {
    throw new TypeError(`unknown outcome: ${outcome}`);
  }
  next.history = next.history.slice(-HISTORY_LIMIT);
  await writeJsonAtomic(breaker.path, next);
  return next;
}
