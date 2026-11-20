// Not a test file. Repositories and bundles for the push's tests (incident-platform backlog #0-276), made by the test's
// own git, as 4.4's task repository would make them: a product's main (FACTORY_REPO_DIR), a task's clone with its new
// commit, and its bundle `<base>..<branch>`; and bundles no honest git would make, put together from a header and a
// pack (a second prerequisite, a history of its own under a correct header, a capability, data after the pack).
// Every git here runs with no system or global config, in the test's own directories.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
export const GIT_VERSION = execFileSync(REAL_GIT, ['--version'], { encoding: 'utf8' }).trim();

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };

/** Runs the test's git in `cwd`; its stdout, as text unless `binary`. */
export function git(cwd, args, { input, binary = false } = {}) {
  const out = execFileSync(REAL_GIT, args, { cwd, env: ENV, input, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' });
  return binary ? out : out.toString('utf8').trim();
}

/** A raw object written as it is (`hash-object --literally`), for what `git commit` would never write. */
const literal = (cwd, type, content) => git(cwd, ['hash-object', '-t', type, '-w', '--literally', '--stdin'],
  { input: content });

const fileText = (n) => Array.from({ length: n }, (_, i) => `line ${i} of a file long enough for git to delta it\n`)
  .join('');

/**
 * A product's main: one commit `base` holding `f`. With `badOld`, main's history also holds a commit with no author
 * email and a tree with a zero-padded mode, both of which `fsck --strict` refuses: objects in FACTORY_REPO_DIR, reached
 * through alternates, which a strict check of the bundle's own objects must not read.
 *
 * @returns {Promise<{ dir: string, base: string }>}
 */
export async function makeProduct(root, { badOld = false } = {}) {
  const dir = join(root, 'main');
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'f'), fileText(40));
  git(dir, ['add', 'f']);
  const tree = git(dir, ['write-tree']);
  const parents = [];
  if (badOld) {
    const blob = git(dir, ['hash-object', '-w', '--stdin'], { input: 'old\n' });
    const badTree = literal(dir, 'tree', Buffer.concat([Buffer.from('0100644 old\0'), Buffer.from(blob, 'hex')]));
    const badCommit = literal(dir, 'commit',
      `tree ${badTree}\nauthor NoMail 1600000000 +0000\ncommitter c <c@example.com> 1600000000 +0000\n\nold, bad\n`);
    parents.push('-p', badCommit);
  }
  const base = git(dir, ['commit-tree', tree, ...parents, '-m', 'base']);
  git(dir, ['update-ref', 'refs/heads/main', base]);
  git(dir, ['reset', '-q', '--hard', base]);
  return { dir, base };
}

/**
 * A task's clone of the product with one new commit on `branch` (a change of `f`, so the bundle's pack is thin), and
 * the bundle `<base>..<branch>`. `noEmail` makes the new commit's author line lack its email, which `fetch` lets
 * through and `index-pack --strict` refuses.
 *
 * @returns {Promise<{ dir: string, sha: string, bundle: Buffer }>}
 */
export async function makeTask(root, product, { branch = 'feat/x', noEmail = false, name = 'task' } = {}) {
  const dir = join(root, name);
  git(root, ['clone', '-q', product.dir, dir]);
  git(dir, ['checkout', '-q', '-b', branch]);
  await writeFile(join(dir, 'f'), `${fileText(40)}one more line\n`);
  git(dir, ['add', 'f']);
  const tree = git(dir, ['write-tree']);
  const sha = noEmail
    ? literal(dir, 'commit', `tree ${tree}\nparent ${product.base}\nauthor NoMail 1700000001 +0000\n`
      + 'committer c <c@example.com> 1700000001 +0000\n\nno email\n')
    : git(dir, ['commit-tree', tree, '-p', product.base, '-m', 'the task\'s commit']);
  git(dir, ['update-ref', `refs/heads/${branch}`, sha]);
  return { dir, sha, bundle: git(dir, ['bundle', 'create', '-', `${product.base}..${branch}`], { binary: true }) };
}

/** The pack of the objects `revs` reach (`--revs`: e.g. [sha, `^${base}`]), thin against what they exclude. */
export function packOf(dir, revs, { thin = true } = {}) {
  return git(dir, ['pack-objects', '--revs', '--stdout', ...(thin ? ['--thin'] : []), '-q'],
    { input: `${revs.join('\n')}\n`, binary: true });
}

/** A bundle put together by hand: the signature, `lines` (prerequisites, refs, capabilities), a blank line, `pack`. */
export function bundleOf({ version = 2, lines, pack }) {
  return Buffer.concat([Buffer.from(`# v${version} git bundle\n${lines.join('\n')}\n\n`), pack]);
}

/**
 * In the task's clone, a commit that does not descend from the base: a root of its own, its whole history in the pack.
 *
 * @returns {{ sha: string, pack: Buffer }}
 */
export function separateHistory(task) {
  const tree = git(task.dir, ['write-tree']);
  const sha = git(task.dir, ['commit-tree', tree, '-m', 'a history of its own']);
  return { sha, pack: packOf(task.dir, [sha], { thin: false }) };
}
