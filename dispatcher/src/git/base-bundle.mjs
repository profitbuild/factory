/**
 * The bundle a task's clone is made from (incident-platform ADR-0062 point 2; backlog #0-277 AC7): made by the
 * dispatcher in its own FACTORY_REPO_DIR, the product's clone of main, through runGit, and handed to a one-shot helper
 * on its stdin (work-dir.mjs). The clone is made from it by the helper's git, so it shares no inode with
 * FACTORY_REPO_DIR (a local `git clone` would hardlink objects/).
 *
 * `git bundle create -` of a bare SHA makes an empty bundle ("Refusing to create empty bundle"), and a bundle with no
 * HEAD checks out nothing unless the branch is named: so the ref `refs/heads/base` is pointed at the task's base
 * first, the bundle is `git bundle create - refs/heads/base`, and the helper clones it with `-b base`. Its header is
 * read back and must be exactly that ref at that commit, with no prerequisite.
 */
import { firstLines, runGit } from './run-git.mjs';

/** The base bundle's one ref. */
export const BASE_REF = 'refs/heads/base';

/** The base bundle could not be made, or is not what it must be. */
export class BaseBundleError extends Error {}

const SHA = /^[0-9a-f]{40}$/;

async function inRepo({ repoDir, args, git, large = false }) {
  const result = await runGit({ cwd: repoDir, gitDir: repoDir, args, git, large });
  if (result.code !== 0) {
    throw new BaseBundleError(`git ${args[0]} in FACTORY_REPO_DIR failed (exit ${result.code}): `
      + `${firstLines(result.stderr) || 'no message'}`);
  }
  return result.stdout;
}

/**
 * The commit `refs/heads/main` of FACTORY_REPO_DIR names: v0's base for a new task (4.4's pick chooses it later).
 *
 * @param {string} repoDir
 * @param {{ git?: string }} [options] `git` for the tests only
 */
export async function mainCommit(repoDir, { git } = {}) {
  const sha = (await inRepo({ repoDir, git, args: ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'] }))
    .toString('utf8').trim();
  if (!SHA.test(sha)) {
    throw new BaseBundleError('FACTORY_REPO_DIR has no refs/heads/main');
  }
  return sha;
}

/**
 * @param {{ repoDir: string, baseSha: string, git?: string }} options `git` for the tests only
 * @returns {Promise<Buffer>} the bundle
 */
export async function makeBaseBundle({ repoDir, baseSha, git }) {
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) {
    throw new TypeError('makeBaseBundle: baseSha must be 40 hex digits');
  }
  await inRepo({ repoDir, git, args: ['update-ref', '--no-deref', BASE_REF, `${baseSha}^{commit}`] });
  const bundle = await inRepo({ repoDir, git, args: ['bundle', 'create', '-', BASE_REF], large: true });
  const end = bundle.indexOf('\n\n');
  const header = end < 0 ? [] : bundle.subarray(0, end).toString('utf8').split('\n');
  if (header[0] !== '# v2 git bundle' || header.length !== 2 || header[1] !== `${baseSha} ${BASE_REF}`) {
    throw new BaseBundleError(`the base bundle's header is not exactly ${BASE_REF} at the base, with no prerequisite`);
  }
  return bundle;
}
