/**
 * The dispatcher's locks, one mechanism for all three (incident-platform backlog #0-303, ADR-0060 D7 and ADR-0062
 * point 7 as amended for #0-303; first #0-275 AC2, #0-261):
 *
 *   $FACTORY_STATE_DIR/lock               the dispatcher's: only while a run takes its slot (the breaker, the fetch of
 *                                         main, the item and the base, the task's lock, the count of the live tasks,
 *                                         the sweep at the start), while it sweeps at its end, and for `cli.mjs sweep`
 *   $FACTORY_STATE_DIR/tasks/<runId>/lock a task's: held by the run of that task for the whole run, new or resumed; a
 *                                         task is live for as long as its lock cannot be taken (isLive)
 *   $FACTORY_STATE_DIR/state.lock         the state's: around every read, change and write of state.json and of the
 *                                         tasks' records, a few seconds at most
 *
 * The order (review round 1 of factory#25, doc-3c1e): a run takes the locks in the order dispatcher, task, state. At
 * its end it holds its own task's lock and waits for the dispatcher's; that makes no cycle of waits, since no one ever
 * waits for a task's lock, it is only tried (acquireTaskLock, isLive). The invariant: no one waits for a task's lock,
 * and no one waits for the dispatcher's while holding the state's.
 *
 * isLive and acquireTaskLock are called only under the dispatcher's lock: isLive's try takes a free lock for an
 * instant, and a task's lock is first taken in the slot section, so a task's liveness only changes there (or falls,
 * when a run is killed), and a count made under the dispatcher's lock holds until it is released.
 *
 * A flock(2), which Node has no call for: this process opens the lock file and lends its descriptor to util-linux's
 * flock(1) as fd 3 (`flock --nonblock --exclusive 3`, or `--timeout <s>` to wait; the shell's `exec 3>lock; flock -n
 * 3`). The lock belongs to the open file description, not to the process that asked for it, so it stays when flock(1)
 * exits, for as long as this process keeps its descriptor open:
 * - a run killed, even by SIGKILL, has its descriptors closed by the kernel, which releases the lock: nothing is left
 *   to clean up, and no pid is written or read (the stale locks of today's autopilot, #0-251 and #0-253, cannot
 *   happen). Node opens every file with O_CLOEXEC, so no child (git, docker, a sleeping process) inherits it, and a
 *   child that outlives its killed run holds nothing (#0-303 AC1);
 * - a live run never loses it: there is no timeout, nothing to renew, and the descriptor is a number, which no garbage
 *   collector closes.
 * flock(1) runs as a child of its own (spawn), for acquireLock and isLive alike, so a run that waits for a lock does
 * not stop this process's other work: two runs in one process (the tests') wait for each other as two processes do.
 * When flock(1) fails, the refusal gives its exit code or signal, never its stderr.
 *
 * Once locked, the descriptor's file must still be the one at the path (the same device and inode): a lock file
 * removed or replaced by someone else would let a second run lock a new file while this one holds the old.
 */
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { RUN_ID } from '../container/paths.mjs';
import { childEnv } from '../process/child-env.mjs';

/** util-linux's flock(1), by its full path: PATH is not trusted to find it. */
export const FLOCK = '/usr/bin/flock';

/**
 * The longest a run waits for the dispatcher's lock, and for the state's: 30 minutes, since another run's slot section
 * holds its fetch of main (up to 10 minutes) and its sweep's helpers (up to 10 minutes each); 5 seconds.
 */
export const DISPATCHER_WAIT_S = 30 * 60;
export const STATE_WAIT_S = 5;

/** Another run holds the lock. */
export class LockHeldError extends Error {}

/** The lock file is the dispatcher's own, or it is refused: a regular file of this process's user, 600. */
function checkLockFile(fd, path) {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
    throw new Error(`the lock ${path} must be a regular file of this process's user with mode 600`);
  }
  return stats;
}

/**
 * flock(1) on `fd`, as a child, the one for acquireLock and isLive: true once the lock is taken, false when another
 * holds it (past the wait, when it waits); any other end is an error naming flock(1)'s exit code or signal.
 */
function flockOn(fd, args, flock) {
  return new Promise((resolve, reject) => {
    // No variable of the dispatcher's: flock(1) needs none (childEnv, incident-platform backlog #0-276).
    const child = spawn(flock, [...args, '--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd],
      env: childEnv() });
    child.on('error', (error) => reject(new Error(`flock(1) could not be run (${flock}, util-linux): ${error.code
      ?? error.message}`)));
    child.on('close', (status, signal) => {
      if (status === 0 || status === 1) {
        resolve(status === 0);
      } else {
        reject(new Error(`flock(1) failed (${status === null ? `signal ${signal}` : `exit ${status}`})`));
      }
    });
  });
}

/**
 * Takes the lock at `path` (made 600 if it is missing), or refuses.
 *
 * @param {string} path the lock file
 * @param {{ wait?: number | false, what?: string, flock?: string, afterFlock?: () => void }} [options] `wait` false
 *   (the default) tries once (`--nonblock`), a number of seconds waits that long (`--timeout`); `what` names the lock
 *   in the refusal; `flock` flock(1)'s path, for a test that has it elsewhere; `afterFlock` runs between the flock and
 *   the check of the inode, where a swap would be seen: for the tests only
 * @returns {Promise<{ path: string, release: () => void }>}
 * @throws {LockHeldError} when another run holds it (past `wait`, when it waits)
 */
export async function acquireLock(path, { wait = false, what = `the lock ${path}`, flock = FLOCK, afterFlock } = {}) {
  if (wait !== false && !(Number.isSafeInteger(wait) && wait > 0)) {
    throw new TypeError('acquireLock: wait must be false or a positive number of seconds');
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let held = false;
  try {
    const stats = checkLockFile(fd, path);
    if (!await flockOn(fd, wait === false ? ['--nonblock'] : ['--timeout', String(wait)], flock)) {
      throw new LockHeldError(wait === false ? `another run holds ${what} (${path})`
        : `another run has held ${what} (${path}) for ${wait} s: refused, not waited for any longer`);
    }
    afterFlock?.();
    const now = lstatSync(path, { throwIfNoEntry: false });
    if (!now || now.dev !== stats.dev || now.ino !== stats.ino) {
      throw new Error(`the lock ${path} was removed or replaced while it was taken: refused`);
    }
    held = true;
  } finally {
    if (!held) {
      closeSync(fd);
    }
  }
  let open = true;
  return {
    path,
    release() {
      if (open) {
        open = false;
        closeSync(fd);
      }
    },
  };
}

/**
 * Whether a run holds the lock at `path` (#0-303): one try, no wait, no pid; under the dispatcher's lock only (see the
 * order above). Taken, the lock is released at once and
 * the answer is no; a lock file that is not there is no live run's either. The same checks as acquireLock's: a lock
 * file that is not the dispatcher's own is refused, not read as dead.
 *
 * @param {string} path
 * @param {{ flock?: string }} [options] for the tests only
 * @returns {Promise<boolean>}
 */
export async function isLive(path, { flock = FLOCK } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  try {
    checkLockFile(fd, path);
    return !await flockOn(fd, ['--nonblock'], flock);
  } finally {
    // Taken or not, the descriptor is closed: a lock it got is released with it.
    closeSync(fd);
  }
}

/**
 * The dispatcher's lock, $FACTORY_STATE_DIR/lock: the thin layer over acquireLock of the call that took it for a whole
 * run before #0-303, now only for a run's slot section, its sweep at the end, and `cli.mjs sweep`.
 *
 * @param {string} stateDir $FACTORY_STATE_DIR, checked by checkStateDir already
 * @param {{ wait?: number | false, flock?: string, afterFlock?: () => void }} [options] `wait` DISPATCHER_WAIT_S by
 *   default: another run's slot section or sweep is waited for
 */
export function acquireDispatcherLock(stateDir, { wait = DISPATCHER_WAIT_S, ...rest } = {}) {
  return acquireLock(join(stateDir, 'lock'), { wait, what: 'the dispatcher\'s lock', ...rest });
}

/** A task's lock, tasks/<runId>/lock: tried once, never waited for; held, the task is live. `runId` is checked. */
export function taskLockPath(stateDir, runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw new TypeError('taskLockPath: runId is not one of newRunId\'s');
  }
  return join(stateDir, 'tasks', runId, 'lock');
}

/**
 * Takes the lock of the task `runId`, whose directory exists, or refuses: another run of it is live. Called under
 * the dispatcher's lock only (see the order above); `runId` is checked.
 *
 * @param {string} stateDir
 * @param {string} runId
 */
export async function acquireTaskLock(stateDir, runId, options = {}) {
  const path = taskLockPath(stateDir, runId);
  try {
    return await acquireLock(path, { ...options, wait: false,
      what: `the lock of the task ${runId}` });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new LockHeldError(`the task ${runId} is live: another run holds its lock (${path})`);
    }
    throw error;
  }
}

/** The state's lock, $FACTORY_STATE_DIR/state.lock, waited for STATE_WAIT_S. */
export const stateLockPath = (stateDir) => join(stateDir, 'state.lock');

/**
 * Runs `inside` under the state's lock (#0-303): a read, change and write of state.json or of a task's record, whole.
 * Not reentrant: a function that holds it calls the unlocked forms (breaker.mjs, tasks.mjs).
 *
 * @template T
 * @param {string} stateDir
 * @param {() => Promise<T>} inside
 * @returns {Promise<T>}
 */
export async function withStateLock(stateDir, inside) {
  const lock = await acquireLock(stateLockPath(stateDir), { wait: STATE_WAIT_S, what: 'the state\'s lock' });
  try {
    return await inside();
  } finally {
    lock.release();
  }
}
