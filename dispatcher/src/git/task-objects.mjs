/**
 * A repository made for one read of a task's commits, and removed after it (incident-platform backlog #0-276, the
 * push's; #0-278, the check of the trusted paths before the gate): no git with the dispatcher's rights runs in a
 * repository an agent wrote, so the task's commits arrive as a bundle, bytes, and are read in as data.
 *
 * withTaskObjects, in order, each step refusing before the next:
 *  1. $FACTORY_STATE_DIR/tasks/<runId>/<purpose>/, 700, made fresh: one left by a killed run is removed first;
 *  2. FACTORY_REPO_DIR's objects (mainObjects): the dispatcher's own, with no alternates of their own, the clone the
 *     dispatcher's alone (checkOwnRepoDir);
 *  3. two bare repositories, `git init --bare --template=`: the task's and a reference, by the same git;
 *  4. the task's repository's config exactly the reference's (config-allowlist.mjs);
 *  5. its objects/info/alternates names FACTORY_REPO_DIR's objects, and nothing else;
 *  6. the bundle read in (git/bundle.mjs): its prerequisite the task's base, its one ref refs/heads/<branch> at
 *     `sha`, its own objects strictly checked, `sha` a descendant of the base; no ref written;
 *  7. `inside` given the repository and the reference; the directory removed after it, whatever happened.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ensureOwnDirectory } from '../state/files.mjs';
import { loadBundle } from './bundle.mjs';
import { checkPushConfig, initBare } from './config-allowlist.mjs';

/** FACTORY_REPO_DIR is not the dispatcher's alone, or its objects would come from elsewhere. */
export class RepoDirError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
/** What a read of a task's commits is for: the directory it is made in. */
const PURPOSES = Object.freeze(['push', 'check']);

async function isMissing(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

/**
 * FACTORY_REPO_DIR is the dispatcher's alone (incident-platform backlog #0-278 AC7): through alternates its objects
 * feed every push, so no one else may write any file of it, a loose object's directory or a pack included. Held by
 * the directory that shields it: the clone itself or its parent (provision.sh makes it in the dispatcher's home, 700)
 * is a directory, not a symlink, owned by this process's user, with no bit for the group or others. Under it no other
 * user can reach, so what git writes there later (a new pack, a loose object's directory) is covered too, which a
 * walk of the files present could not be.
 *
 * @param {string} repoDir
 * @param {{ uid?: number, lstatOf?: typeof lstat }} [options] for the tests only
 */
export async function checkOwnRepoDir(repoDir, { uid = process.getuid(), lstatOf = lstat } = {}) {
  const own = async (path) => {
    const stats = await lstatOf(path).catch(() => null);
    return { stats, shields: stats?.isDirectory() === true && stats.uid === uid && (stats.mode & 0o077) === 0 };
  };
  const clone = await own(repoDir);
  if (!clone.stats?.isDirectory()) {
    throw new RepoDirError('FACTORY_REPO_DIR is not a directory (a symlink is refused)');
  }
  if (clone.shields || (await own(dirname(repoDir))).shields) {
    return;
  }
  throw new RepoDirError('FACTORY_REPO_DIR is not the dispatcher\'s alone: neither it nor its parent directory is '
    + 'owned by this process\'s user with mode 700 (no bit for the group or others); its objects feed every push');
}

/**
 * The objects directory of FACTORY_REPO_DIR, the dispatcher's clone of main (a work tree's .git/objects, or a bare
 * clone's objects), refused unless it is the dispatcher's own, holds no alternates of its own, and the clone is the
 * dispatcher's alone (checkOwnRepoDir).
 *
 * @param {string} repoDir
 * @param {{ uid?: number, lstatOf?: typeof lstat }} [options] `lstatOf` for the tests only: one directory's owner
 *   given apart from another's, which a test cannot `chown`
 */
export async function mainObjects(repoDir, { uid = process.getuid(), lstatOf = lstat } = {}) {
  const dotGit = await lstatOf(join(repoDir, '.git')).catch(() => null);
  const objects = dotGit?.isDirectory() ? join(repoDir, '.git', 'objects') : join(repoDir, 'objects');
  if (dotGit && !dotGit.isDirectory()) {
    throw new RepoDirError('FACTORY_REPO_DIR/.git is not a directory (a gitfile or a symlink is refused)');
  }
  for (const [path, what] of [[objects, 'objects'], [join(objects, 'info'), 'objects/info'],
    [join(objects, 'pack'), 'objects/pack']]) {
    const stats = await lstatOf(path).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new RepoDirError(`FACTORY_REPO_DIR holds no ${what} directory (a symlink is refused)`);
    }
    if (stats.uid !== uid) {
      throw new RepoDirError(`${what} of FACTORY_REPO_DIR is owned by uid ${stats.uid}, not by this process's`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new RepoDirError(`${what} of FACTORY_REPO_DIR has mode ${(stats.mode & 0o777).toString(8)}: no one but `
        + 'its owner may write it');
    }
  }
  for (const name of ['alternates', 'http-alternates']) {
    if (!await isMissing(join(objects, 'info', name))) {
      throw new RepoDirError(`FACTORY_REPO_DIR's objects have info/${name}: their objects would come from elsewhere`);
    }
  }
  await checkOwnRepoDir(repoDir, { uid, lstatOf });
  return objects;
}

/**
 * FACTORY_REPO_DIR checked before any git runs in it, by every command that reads it (cli.mjs, bin/check-app.mjs:
 * review round 1 of factory#20, d): a directory, then mainObjects (its objects the dispatcher's, no alternates, the
 * clone the dispatcher's alone and every directory on the way to it its user's or root's, writable by no one else).
 *
 * @param {string} repoDir
 * @param {{ uid?: number, lstatOf?: typeof lstat }} [options] for the tests only
 */
export async function checkRepoDir(repoDir, { uid, lstatOf = lstat } = {}) {
  const stats = await lstatOf(repoDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new RepoDirError('FACTORY_REPO_DIR is not a directory');
  }
  await mainObjects(repoDir, { uid, lstatOf });
}

/**
 * @template T
 * @param {{ stateDir: string, repoDir: string, task: { runId: string, baseSha: string | null }, bundle: Buffer,
 *   sha: string, branch: string, purpose: 'push' | 'check', uid?: number, git?: string,
 *   hooks?: { afterInit?: (gitDir: string) => Promise<void> } }} options `uid`, `git` and `hooks` for the tests only
 * @param {(repos: { repo: string, reference: string }) => Promise<T>} inside
 * @returns {Promise<T>}
 */
export async function withTaskObjects({
  stateDir, repoDir, task, bundle, sha, branch, purpose, uid, git, hooks = {},
}, inside) {
  if (!PURPOSES.includes(purpose)) {
    throw new TypeError(`withTaskObjects: purpose must be one of ${PURPOSES.join(', ')}`);
  }
  if (!SHA.test(task?.baseSha ?? '')) {
    throw new RepoDirError(`the task ${task?.runId} has no base recorded`);
  }
  const taskDir = join(stateDir, 'tasks', task.runId);
  const dir = join(taskDir, purpose);
  await ensureOwnDirectory(join(stateDir, 'tasks'), { uid });
  await ensureOwnDirectory(taskDir, { uid });
  await rm(dir, { recursive: true, force: true });
  await ensureOwnDirectory(dir, { exclusive: true, uid });
  try {
    const objects = await mainObjects(repoDir, { uid });
    const repo = join(dir, 'repo.git');
    const reference = join(dir, 'reference.git');
    await initBare(dir, repo, { git });
    await initBare(dir, reference, { git });
    await hooks.afterInit?.(repo);
    await checkPushConfig(repo, reference, { git });
    await mkdir(join(repo, 'objects', 'info'), { recursive: true, mode: 0o700 });
    await writeFile(join(repo, 'objects', 'info', 'alternates'), `${objects}\n`,
      { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW });
    await loadBundle({ gitDir: repo, bundle, prerequisite: task.baseSha, ref: { sha, name: `refs/heads/${branch}` },
      git });
    return await inside({ repo, reference });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
