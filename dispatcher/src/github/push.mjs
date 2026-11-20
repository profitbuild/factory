/**
 * builder-app's push of a task's branch, from a push repository the dispatcher makes for that push alone
 * (incident-platform backlog #0-276; stage-4.md "Decided for 4.3b"; ADR-0060 D7 as amended). No git with the
 * dispatcher's rights runs in a repository an agent wrote: the task's commits arrive as a bundle (bytes, made by the
 * dispatcher from its task repository: 4.4), never by a fetch from the task's clone.
 *
 * pushTask, in order, each step refusing before the next, and no token asked for before the last check:
 *  1. `sha` is 40 hex digits, `branch` the task's own and a valid branch (no +, :, ..), the task's base recorded;
 *  2. $FACTORY_STATE_DIR/tasks/<runId>/push/, 700, made fresh: one left by a killed run is removed first;
 *  3. FACTORY_REPO_DIR's objects (the dispatcher's clone of main, for the base's objects) are a directory of the
 *     dispatcher's, not a symlink, writable by no one else, with no alternates of their own (alternates chain);
 *  4. two bare repositories, `git init --bare --template=`: the push repository and a reference, by the same git;
 *  5. the push repository's config is exactly the reference's (config-allowlist.mjs), a first time;
 *  6. its objects/info/alternates names FACTORY_REPO_DIR's objects, and nothing else;
 *  7. the bundle is read in (git/bundle.mjs): its prerequisite the task's base, its one ref refs/heads/<branch> at
 *     `sha`, its own objects strictly checked, `sha` a descendant of the base; no ref written;
 *  8. the config is checked again, right before the token is asked for;
 *  9. the token, and `git push --porcelain <url> <sha>:refs/heads/factory/<branch>`, built by gitPushCommand;
 * 10. the result read from --porcelain: a ref refused is a PushRejectedError naming git's kind of refusal, never the
 *     remote's text (a reason recorded for a task, 4.4, holds no text of GitHub's).
 * The push directory is removed after every push, refused or not: nothing of a push lives on to the next.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadBundle } from '../git/bundle.mjs';
import { checkPushConfig, initBare } from '../git/config-allowlist.mjs';
import { runGit } from '../git/run-git.mjs';
import { ensureOwnDirectory } from '../state/files.mjs';
import { checkTaskBranch, gitPushCommand, pushUrl } from './builder-token.mjs';

/** The longest a push may run. */
export const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

/** The push was refused before it was made: what was asked for is not the task's. */
export class PushRefusedError extends Error {}
/** git pushed and the ref was refused, or git failed. */
export class PushRejectedError extends Error {}

const SHA = /^[0-9a-f]{40}$/;

/** What git itself says of a ref it refused locally: kept, since it is git's and not the remote's. */
const LOCAL_REASONS = new Set(['non-fast-forward', 'fetch first', 'already exists', 'stale info']);

function checkTarget({ task, sha, branch }) {
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    throw new PushRefusedError('the commit to push must be 40 hex digits');
  }
  try {
    checkTaskBranch(branch);
  } catch (error) {
    throw new PushRefusedError(error.message);
  }
  if (branch !== task.branch) {
    throw new PushRefusedError(`the branch to push is not the task's own (${task.branch ?? 'none recorded'})`);
  }
  if (!SHA.test(task.baseSha ?? '')) {
    throw new PushRefusedError(`the task ${task.runId} has no base recorded`);
  }
}

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
 * The objects directory of FACTORY_REPO_DIR, the dispatcher's clone of main (a work tree's .git/objects, or a bare
 * clone's objects), refused unless it is the dispatcher's own and holds no alternates of its own.
 *
 * @param {string} repoDir
 * @param {{ uid?: number }} [options]
 */
export async function mainObjects(repoDir, { uid = process.getuid() } = {}) {
  const dotGit = await lstat(join(repoDir, '.git')).catch(() => null);
  const objects = dotGit?.isDirectory() ? join(repoDir, '.git', 'objects') : join(repoDir, 'objects');
  if (dotGit && !dotGit.isDirectory()) {
    throw new PushRefusedError('FACTORY_REPO_DIR/.git is not a directory (a gitfile or a symlink is refused)');
  }
  const stats = await lstat(objects).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new PushRefusedError('FACTORY_REPO_DIR holds no objects directory (a symlink is refused)');
  }
  if (stats.uid !== uid) {
    throw new PushRefusedError(`FACTORY_REPO_DIR's objects are owned by uid ${stats.uid}, not by this process's`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new PushRefusedError(`FACTORY_REPO_DIR's objects have mode ${(stats.mode & 0o777).toString(8)}: no one but `
      + 'their owner may write them');
  }
  for (const name of ['alternates', 'http-alternates']) {
    if (!await isMissing(join(objects, 'info', name))) {
      throw new PushRefusedError(`FACTORY_REPO_DIR's objects have info/${name}: their objects would come from elsewhere`);
    }
  }
  return objects;
}

/**
 * The --porcelain answer of a push of `ref`: refused unless git reports it new (`*`), fast-forwarded (` `) or already
 * there (`=`, the same commit: a push run twice, 4.4's phases).
 */
export function readPushResult({ code, stdout }, ref) {
  const lines = stdout.toString('utf8').split('\n');
  const line = lines.find((l) => /^.\t[^\t]*\t/.test(l) && l.split('\t')[1].endsWith(`:${ref}`));
  if (!line) {
    throw new PushRejectedError(`git push failed (exit ${code}) and reported no result for ${ref}`);
  }
  const [flag, , summary] = line.split('\t');
  if (['*', ' ', '='].includes(flag) && code === 0) {
    return { ref, flag };
  }
  const kind = /^\[([a-z ]+)\]/.exec(summary)?.[1] ?? 'refused';
  const reason = /\(([^)]*)\)\s*$/.exec(summary)?.[1];
  const own = kind === 'rejected' && LOCAL_REASONS.has(reason) ? ` (${reason})` : '';
  throw new PushRejectedError(`the push of ${ref} was refused: ${kind}${own}`);
}

/**
 * @param {{ stateDir: string, repoDir: string, task: { runId: string, branch: string | null, baseSha: string | null },
 *   bundle: Buffer, sha: string, branch: string, repository: string, getToken: () => Promise<string>, url?: string,
 *   allowProtocols?: string, baseEnv?: Record<string, string | undefined>, uid?: number,
 *   hooks?: { afterInit?: (gitDir: string) => Promise<void>, beforeToken?: (gitDir: string) => Promise<void> } }}
 *   options `repository` the adapter's, owner/name; `url` pushUrl(repository) but in tests, with `allowProtocols`;
 *   `hooks` for the tests only, where a planted key would come in
 * @returns {Promise<{ ref: string, flag: string }>}
 */
export async function pushTask({
  stateDir, repoDir, task, bundle, sha, branch, repository, getToken, url = pushUrl(repository),
  allowProtocols = 'https', baseEnv = process.env, uid, hooks = {},
}) {
  checkTarget({ task, sha, branch });
  const taskDir = join(stateDir, 'tasks', task.runId);
  const dir = join(taskDir, 'push');
  await ensureOwnDirectory(join(stateDir, 'tasks'), { uid });
  await ensureOwnDirectory(taskDir, { uid });
  await rm(dir, { recursive: true, force: true });
  await ensureOwnDirectory(dir, { exclusive: true, uid });
  try {
    const objects = await mainObjects(repoDir, { uid });
    const repo = join(dir, 'repo.git');
    const reference = join(dir, 'reference.git');
    await initBare(dir, repo);
    await initBare(dir, reference);
    await hooks.afterInit?.(repo);
    await checkPushConfig(repo, reference);
    await mkdir(join(repo, 'objects', 'info'), { recursive: true, mode: 0o700 });
    await writeFile(join(repo, 'objects', 'info', 'alternates'), `${objects}\n`,
      { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW });
    await loadBundle({ gitDir: repo, bundle, prerequisite: task.baseSha, ref: { sha, name: `refs/heads/${branch}` } });
    await hooks.beforeToken?.(repo);
    await checkPushConfig(repo, reference);
    const command = gitPushCommand({ token: await getToken(), sha, branch, url, allowProtocols });
    const result = await runGit({
      cwd: repo, gitDir: repo, args: command.args, allow: command.allow, set: command.set, baseEnv,
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    return readPushResult(result, command.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
