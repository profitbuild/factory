/**
 * FACTORY_REPO_DIR, the dispatcher's bare clone of the product's main, brought up to GitHub's main before a new task
 * (incident-platform backlog #0-278; ADR-0060 D6 as amended: the adapter and every file the dispatcher reads come
 * from the base commit of that clone). The repository becomes private at stage 9, so the update is made with
 * builder-app's token from the start, under the rule of its push (github/builder-token.mjs, gitFetchCommand):
 *  1. the token source is the repository's; the URL is pushUrl(repository), on GitHub (a test's loopback server);
 *  2. FACTORY_REPO_DIR's objects are the dispatcher's, with no alternates, the clone the dispatcher's alone
 *     (task-objects.mjs, mainObjects: #0-278 AC7);
 *  3. its config is exactly a reference `git init --bare --template=`'s, made fresh under
 *     $FACTORY_STATE_DIR/fetch/ (700, removed after), but for remote.origin.url equal to that URL, which
 *     `git clone --bare` writes (provision.sh); checked right before the token is asked for;
 *  4. `git fetch <url> refs/heads/main:refs/heads/main`, no `+`: an update that is not a fast-forward is refused,
 *     with git's own word for it, never the remote's text.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { GIT_HOST, gitFetchCommand, gitHost, pushUrl } from '../github/builder-token.mjs';
import { ensureOwnDirectory } from '../state/files.mjs';
import { mainCommit } from './base-bundle.mjs';
import { checkRepoConfig, initBare } from './config-allowlist.mjs';
import { runGit } from './run-git.mjs';
import { mainObjects } from './task-objects.mjs';

/** The longest the update of main may run. */
export const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

/** main could not be brought up to GitHub's. */
export class MainFetchError extends Error {}

/**
 * @param {{ stateDir: string, repoDir: string, repository: string,
 *   tokens: { repository: string, getToken: () => Promise<string> }, baseEnv?: Record<string, string | undefined>,
 *   gitBase?: string, uid?: number, git?: string }} options `repository` the adapter's; `gitBase`, `uid` and `git`
 *   for the tests only
 * @returns {Promise<{ before: string, after: string }>} main's commit before the update and after it
 */
export async function fetchMain({ stateDir, repoDir, repository, tokens, baseEnv = process.env, gitBase = GIT_HOST,
  uid, git }) {
  if (tokens?.repository !== repository || typeof tokens?.getToken !== 'function') {
    throw new MainFetchError(`the token source is for ${tokens?.repository ?? 'no repository'}, not ${repository}`);
  }
  let url;
  try {
    url = pushUrl(repository, gitHost(gitBase).origin);
  } catch (error) {
    throw new MainFetchError(error.message);
  }
  const before = await mainCommit(repoDir, { git });
  await mainObjects(repoDir, { uid });
  const dir = join(stateDir, 'fetch');
  await rm(dir, { recursive: true, force: true });
  await ensureOwnDirectory(dir, { exclusive: true, uid });
  try {
    const reference = join(dir, 'reference.git');
    await initBare(dir, reference, { git });
    await checkRepoConfig(repoDir, reference, { git, allowed: [['remote.origin.url', url]], what: 'FACTORY_REPO_DIR' });
    const command = gitFetchCommand({ token: await tokens.getToken(), url });
    const result = await runGit({ cwd: repoDir, gitDir: repoDir, git, args: command.args, allow: command.allow,
      set: command.set, baseEnv, timeoutMs: FETCH_TIMEOUT_MS });
    if (result.code !== 0) {
      // git's own lines only: a line of the remote's starts with "remote:".
      const own = result.stderr.split('\n').filter((line) => !line.startsWith('remote:'));
      if (own.some((line) => line.includes('(non-fast-forward)'))) {
        throw new MainFetchError('GitHub\'s main is not a fast-forward of FACTORY_REPO_DIR\'s: the update is refused '
          + '(main is never rewritten; the owner looks at both before the clone is made again)');
      }
      throw new MainFetchError(`git fetch of main failed (exit ${result.code}); the remote's text is not quoted`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { before, after: await mainCommit(repoDir, { git }) };
}
