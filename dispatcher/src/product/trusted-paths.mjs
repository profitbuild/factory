/**
 * The paths a task's branch may not change (incident-platform ADR-0060 D7 as amended, backlog #0-278 AC1, AC6): the
 * adapter's `trustedPaths`, read from the task's base, never from the branch. The check is the dispatcher's own code:
 * the changed paths are listed by its own git, with its own flags, in a repository it made for the check
 * (git/task-objects.mjs: the task's bundle read in as data, its objects' alternates on FACTORY_REPO_DIR), never by the
 * product's `changedPaths` command, which stays advisory and runs in the task container (product/commands.mjs).
 *
 *   git diff-tree -r -z --name-only --no-renames --no-ext-diff --no-textconv <base> <head>
 *
 * The plumbing form, not `git diff`: its output does not change with a config or a version; `-z` takes any name whole;
 * with no rename detection both sides of a rename are listed, so a file moved out of a trusted directory is a change
 * of it. A path changes a trusted entry when it is the entry, lies under an entry that is a directory (`dir/`), or is
 * that directory's own name (a file put in place of the directory), or lies under a file entry (a directory put in
 * place of the file).
 *
 * checkChangedPaths is the one function of the rule: stage 4.5 adds the lists of the adapter's `protectedPaths` that
 * need the owner (ADR-0060 D7 as amended). A refusal names the field and how many paths, never a path: the branch is
 * the agent's.
 */
import { firstLines, runGit } from '../git/run-git.mjs';
import { withTaskObjects } from '../git/task-objects.mjs';

/** A task's branch changes what judges it. */
export class TrustedPathsError extends Error {}

const SHA = /^[0-9a-f]{40}$/;

/** Whether `path` lies under the trusted entry `entry` (a directory ends with /), or is it. */
export function isUnder(entry, path) {
  return entry.endsWith('/') ? path.startsWith(entry) : path === entry;
}

/** Whether a change of `path` changes the trusted entry `entry`. */
export function changesEntry(entry, path) {
  if (entry.endsWith('/')) {
    return path.startsWith(entry) || path === entry.slice(0, -1);
  }
  return path === entry || path.startsWith(`${entry}/`);
}

/**
 * The paths the commit `head` changes against `base`, by the dispatcher's git in the repository `gitDir`, which it
 * made.
 *
 * @param {{ gitDir: string, base: string, head: string, git?: string }} options `git` for the tests only
 * @returns {Promise<string[]>}
 */
export async function changedPathsOf({ gitDir, base, head, git }) {
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) {
    throw new TypeError('changedPathsOf: base and head must be 40 hex digits');
  }
  const result = await runGit({ cwd: gitDir, gitDir, git, args: ['diff-tree', '-r', '-z', '--name-only',
    '--no-renames', '--no-ext-diff', '--no-textconv', base, head] });
  if (result.code !== 0) {
    throw new TrustedPathsError(`git diff-tree of the task's commits failed (exit ${result.code}): `
      + `${firstLines(result.stderr) || 'no message'}`);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Refuses `changed` when one of its paths changes an entry of the adapter's `trustedPaths`.
 *
 * @param {{ adapter: { trustedPaths: string[] }, changed: string[] }} options `adapter` the base's
 */
export function checkChangedPaths({ adapter, changed }) {
  const hits = adapter.trustedPaths.map((entry, index) => ({ index,
    count: changed.filter((path) => changesEntry(entry, path)).length })).filter((hit) => hit.count > 0);
  if (hits.length > 0) {
    throw new TrustedPathsError(`the task's branch changes what judges it, refused before its gate: ${hits.map((hit) =>
      `${hit.count} path${hit.count === 1 ? '' : 's'} of the adapter's trustedPaths[${hit.index}]`).join(', ')} `
      + '(the adapter is the base\'s)');
  }
}

/**
 * The check of a task's commits before its gate: the bundle read into a repository made for the check, the changed
 * paths listed there and held to the base's adapter. No product code runs for it.
 *
 * @param {{ stateDir: string, repoDir: string, task: { runId: string, branch: string, baseSha: string },
 *   bundle: Buffer, sha: string, adapter: { trustedPaths: string[] }, uid?: number, git?: string }} options
 * @returns {Promise<string[]>} the changed paths, for 4.5's check of the owner's paths
 */
export async function checkTaskPaths({ stateDir, repoDir, task, bundle, sha, adapter, uid, git }) {
  return withTaskObjects({ stateDir, repoDir, task, bundle, sha, branch: task.branch, purpose: 'check', uid, git },
    async ({ repo }) => {
      const changed = await changedPathsOf({ gitDir: repo, base: task.baseSha, head: sha, git });
      checkChangedPaths({ adapter, changed });
      return changed;
    });
}
