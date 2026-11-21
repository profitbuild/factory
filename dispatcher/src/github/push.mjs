/**
 * builder-app's push of a task's branch, from a push repository the dispatcher makes for that push alone
 * (incident-platform backlog #0-276; stage-4.md "Decided for 4.3b"; ADR-0060 D7 as amended). No git with the
 * dispatcher's rights runs in a repository an agent wrote: the task's commits arrive as a bundle (bytes, made by the
 * dispatcher from its task repository: 4.4), never by a fetch from the task's clone.
 *
 * pushTask, in order, each step refusing before the next, and no token asked for before the last check:
 *  1. the token source is the repository's; `sha` is 40 hex digits, `branch` the task's own and a valid branch (no +,
 *     :, ..), the task's base recorded;
 *  2-7. the push repository, made by git/task-objects.mjs's withTaskObjects (purpose `push`), which the check of
 *     the trusted paths shares (incident-platform backlog #0-278): $FACTORY_STATE_DIR/tasks/<runId>/push/, 700, made
 *     fresh; FACTORY_REPO_DIR's objects, and their info/ and pack/, directories of the dispatcher's, not symlinks,
 *     writable by no one else, with no alternates of their own (alternates chain), and the clone the dispatcher's
 *     alone (#0-278 AC7); two bare repositories, `git init --bare --template=`, the push repository and a
 *     reference; the push repository's config exactly the reference's, a first time; its objects/info/alternates
 *     naming FACTORY_REPO_DIR's objects, and nothing else; the bundle read in (git/bundle.mjs): its prerequisite the
 *     task's base, its one ref refs/heads/<branch> at `sha`, its own objects strictly checked, `sha` a descendant
 *     of the base; no ref written;
 *  8. the config is checked again, right before the token is asked for;
 *  9. the token, and `git push --porcelain <url> <sha>:refs/heads/factory/<branch>`, built by gitPushCommand, to
 *     pushUrl(repository) on GitHub: the URL is never the caller's (a test gives its loopback server, `gitBase`, over
 *     http; no other host is taken, pushTarget);
 * 10. the result read from --porcelain: a ref refused is a PushRejectedError naming git's kind of refusal, never the
 *     remote's text (a reason recorded for a task, 4.4, holds no text of GitHub's).
 * The push directory is removed after every push, refused or not: nothing of a push lives on to the next.
 */
import { checkPushConfig } from '../git/config-allowlist.mjs';
import { runGit } from '../git/run-git.mjs';
import { mainObjects, withTaskObjects } from '../git/task-objects.mjs';
import { GIT_HOST, checkTaskBranch, gitHost, gitPushCommand, pushUrl } from './builder-token.mjs';

export { mainObjects };

/** The longest a push may run. */
export const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

/** The push was refused before it was made: what was asked for is not the task's. */
export class PushRefusedError extends Error {}
/** git pushed and the ref was refused, or git failed. */
export class PushRejectedError extends Error {}

const SHA = /^[0-9a-f]{40}$/;

/** What git itself says of a ref it refused locally: kept, since it is git's and not the remote's. */
const LOCAL_REASONS = new Set(['non-fast-forward', 'fetch first', 'already exists', 'stale info']);

function checkTarget({ task, sha, branch, repository, tokens }) {
  if (tokens?.repository !== repository || typeof tokens?.getToken !== 'function') {
    throw new PushRefusedError(`the token source is for ${tokens?.repository ?? 'no repository'}, not ${repository}`);
  }
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

/**
 * Where a push of `repository` goes: on GitHub (GIT_HOST), https://github.com/<repository>.git; on a test's server,
 * an http:// origin on a loopback address. No other host is taken, HTTPS or not (gitHost, the one rule); the protocols
 * git may use are gitPushCommand's to set, from the same rule.
 *
 * @param {string} repository
 * @param {string} [gitBase]
 * @returns {{ url: string }}
 */
export function pushTarget(repository, gitBase = GIT_HOST) {
  let host;
  try {
    host = gitHost(gitBase);
  } catch (error) {
    throw new PushRefusedError(error.message);
  }
  return { url: pushUrl(repository, host.origin) };
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
 *   bundle: Buffer, sha: string, branch: string, repository: string,
 *   tokens: { repository: string, getToken: () => Promise<string> }, baseEnv?: Record<string, string | undefined>,
 *   uid?: number, gitBase?: string, git?: string,
 *   hooks?: { afterInit?: (gitDir: string) => Promise<void>, beforeToken?: (gitDir: string) => Promise<void> } }}
 *   options `repository` the adapter's, owner/name; `tokens` builder-app's token source (createBuilderTokenSource),
 *   which must be that repository's; `gitBase` (GIT_HOST but in tests: the fake server, over HTTP to loopback), `git`
 *   and `hooks` (where a planted key would come in) for the tests only
 * @returns {Promise<{ ref: string, flag: string }>}
 */
export async function pushTask({
  stateDir, repoDir, task, bundle, sha, branch, repository, tokens, baseEnv = process.env, uid, hooks = {},
  gitBase = GIT_HOST, git,
}) {
  checkTarget({ task, sha, branch, repository, tokens });
  const { url } = pushTarget(repository, gitBase);
  return withTaskObjects({ stateDir, repoDir, task, bundle, sha, branch, purpose: 'push', uid, git, hooks },
    async ({ repo, reference }) => {
      await hooks.beforeToken?.(repo);
      await checkPushConfig(repo, reference, { git });
      const command = gitPushCommand({ token: await tokens.getToken(), sha, branch, url });
      const result = await runGit({
        cwd: repo, gitDir: repo, git, args: command.args, allow: command.allow, set: command.set, baseEnv,
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      return readPushResult(result, command.ref);
    });
}
