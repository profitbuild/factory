/**
 * The dispatcher's lock, $FACTORY_STATE_DIR/lock (incident-platform backlog #0-275 AC2, #0-261): one for the whole
 * dispatcher in v0, so one task at a time. That narrows ADR-0060 D7's "one flock per task", and is the same while one
 * task runs at a time.
 *
 * A flock(2), which Node has no call for: this process opens the lock file and lends its descriptor to util-linux's
 * flock(1) as fd 3 (`flock --nonblock --exclusive 3`, the shell's `exec 3>lock; flock -n 3`). The lock belongs to the
 * open file description, not to the process that asked for it, so it stays when flock(1) exits, for as long as this
 * process keeps its descriptor open:
 * - a run killed, even by SIGKILL, has its descriptors closed by the kernel, which releases the lock: nothing is left
 *   to clean up, and no pid is written or read (the stale locks of today's autopilot, #0-251 and #0-253, cannot
 *   happen);
 * - a live run never loses it: there is no timeout, nothing to renew, and the descriptor is a number, which no garbage
 *   collector closes. Node opens every file with O_CLOEXEC, so no later child (git, docker) inherits it.
 *
 * Once locked, the descriptor's file must still be the one at the path (the same device and inode): a lock file
 * removed or replaced by someone else would let a second run lock a new file while this one holds the old.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { childEnv } from '../process/child-env.mjs';

/** util-linux's flock(1), by its full path: PATH is not trusted to find it. */
export const FLOCK = '/usr/bin/flock';

/** Another run holds the lock. */
export class LockHeldError extends Error {}

/**
 * @param {string} stateDir $FACTORY_STATE_DIR, checked by checkStateDir already
 * @param {{ flock?: string, afterFlock?: () => void }} [options] flock(1)'s path, for a test that has it elsewhere;
 *   `afterFlock` runs between the flock and the check of the inode, where a swap would be seen: for the tests only
 * @returns {{ path: string, release: () => void }}
 * @throws {LockHeldError} when another run holds it
 */
export function acquireLock(stateDir, { flock = FLOCK, afterFlock } = {}) {
  const path = join(stateDir, 'lock');
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let held = false;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
      throw new Error(`the lock ${path} must be a regular file of this process's user with mode 600`);
    }
    const result = spawnSync(flock, ['--nonblock', '--exclusive', '3'], {
      // No variable of the dispatcher's: flock(1) needs none (childEnv, incident-platform backlog #0-276).
      stdio: ['ignore', 'ignore', 'pipe', fd], env: childEnv(), encoding: 'utf8', timeout: 10_000,
    });
    if (result.error) {
      throw new Error(`flock(1) could not be run (${flock}, util-linux): ${result.error.message}`);
    }
    if (result.status === 1) {
      throw new LockHeldError(`another run holds the dispatcher's lock (${path}): one task at a time in v0`);
    }
    if (result.status !== 0) {
      throw new Error(`flock(1) failed (${result.status ?? result.signal}): ${result.stderr.trim()}`);
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
