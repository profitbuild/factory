/**
 * The files of the dispatcher's state, under $FACTORY_STATE_DIR (incident-platform backlog #0-275, stage-4.md "4.3"):
 * the dispatcher's own, not the agents', so every directory is 700 and every file 600, the dispatcher user's.
 *
 * The state directory itself is made by the provisioning (#0-277's provision.sh: 700, owned by the dispatcher user);
 * checkStateDir only refuses one that is not so, and never changes a mode or an owner: a directory found wrong was
 * made by someone else, and a chmod would hide that. The directories below it are made here.
 *
 * Every write goes to a temporary file in the same directory, which is synced and renamed over the old one, and the
 * directory synced after: a run killed at any point leaves either the old file or the new one, never a part of one.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { readOwnFile } from '../config/own-file.mjs';

/** The state directory, or a file or directory in it, is not what it must be. */
export class StateError extends Error {}
/** A file of the state is there but is not JSON. */
export class NotJsonError extends StateError {}

/** Any access by group or others. */
const NOT_OWNER_ONLY = 0o077;

function checkOwnDirectory(stats, what, uid) {
  if (!stats.isDirectory()) {
    throw new StateError(`${what} is not a directory (a symlink is refused)`);
  }
  if (stats.uid !== uid) {
    throw new StateError(`${what} is owned by uid ${stats.uid}, not by this process's (${uid})`);
  }
  if ((stats.mode & NOT_OWNER_ONLY) !== 0) {
    throw new StateError(`${what} has mode ${(stats.mode & 0o777).toString(8)}: it must be 700`);
  }
}

/**
 * $FACTORY_STATE_DIR is a directory, not a symlink, of this process's user, with no access for group or others. The
 * refusal names the variable, not its path, as every refusal of a setting does.
 *
 * @param {string} path
 * @param {{ uid?: number }} [options] the owner required, the process's user by default (a test's other)
 */
export async function checkStateDir(path, { uid = process.getuid() } = {}) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new StateError('FACTORY_STATE_DIR does not exist (the provisioning makes it: 700, the dispatcher user\'s)');
    }
    throw error;
  }
  checkOwnDirectory(stats, 'FACTORY_STATE_DIR', uid);
}

/**
 * A directory of the state (tasks/, tasks/<runId>/): made 700 when it is missing, checked as checkStateDir checks
 * when it exists. With `exclusive`, one that exists already is refused (a task's directory is made once).
 *
 * @param {string} path
 * @param {{ exclusive?: boolean, uid?: number }} [options]
 */
export async function ensureOwnDirectory(path, { exclusive = false, uid = process.getuid() } = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST' || exclusive) {
      throw error;
    }
  }
  checkOwnDirectory(await lstat(path), path, uid);
}

/**
 * Writes `value` as JSON to `path`, atomically: a new temporary file (O_EXCL, O_NOFOLLOW, 600) in the same directory,
 * written and synced, then renamed over `path`, then the directory synced.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {{ beforeRename?: (temporary: string) => Promise<void> }} [options] runs between the write and the rename,
 *   where a kill would happen: for the tests only.
 */
export async function writeJsonAtomic(path, value, { beforeRename } = {}) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeRename?.(temporary);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/**
 * A JSON file of the state, read only when it is a regular file of this process's user that no one else can read or
 * write (own-file.mjs). `undefined` when it does not exist; a file that is not JSON throws a NotJsonError that does not
 * quote it.
 *
 * @param {string} path
 * @param {{ uid?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function readJson(path, { uid } = {}) {
  let text;
  try {
    text = await readOwnFile(path, {
      what: 'the state file', forbiddenMode: NOT_OWNER_ONLY, uid, refuse: (message) => new StateError(message),
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NotJsonError(`${path} is not JSON`);
  }
}
