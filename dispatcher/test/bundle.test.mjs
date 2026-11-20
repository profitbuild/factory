// The one reader of git bundles (incident-platform backlog #0-276 AC6), with the test's git and git/bundle.mjs: the
// header parsed by Node, exactly; exactly one prerequisite, the commit named; exactly one ref, the one named; the
// bundle's own objects checked by index-pack --strict, not main's through alternates (an old commit with no email and
// an old tree with a zero-padded mode sit in the product's history and do not fail a good bundle); the ref a
// descendant of the prerequisite; nothing after the pack; and never a ref written. The git it runs is the version the
// diagnostic names (the dispatcher's container: 2.39; CI's; the 2.43 job: ubuntu:24.04, the VM's).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BundleError, MAX_HEADER_BYTES, loadBundle, parseBundle, readBundleFile,
} from '../src/git/bundle.mjs';
import { initBare } from '../src/git/config-allowlist.mjs';
import {
  GIT_VERSION, bundleOf, git, makeProduct, makeTask, packOf, separateHistory,
} from '../testing/git-fixtures.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);
let product;
let task;
before(async () => {
  product = await makeProduct(root.dir, { badOld: true });
  task = await makeTask(root.dir, product);
});

test('the git these tests run', (t) => {
  t.diagnostic(GIT_VERSION);
});

let repos = 0;
/** A fresh bare repository whose alternates are the product's objects: the push repository's shape. */
async function freshRepo() {
  repos += 1;
  const dir = join(root.dir, `repo-${repos}`);
  await mkdir(dir, { mode: 0o700 });
  const gitDir = join(dir, 'repo.git');
  await initBare(dir, gitDir);
  await writeFile(join(gitDir, 'objects', 'info', 'alternates'), `${join(product.dir, '.git', 'objects')}\n`);
  return gitDir;
}

const refs = async (gitDir) => (await readdir(join(gitDir, 'refs'), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => entry.name);

/** Refused with a BundleError matching `pattern`, and no ref in the repository after it. */
async function refused(options, pattern) {
  const gitDir = await freshRepo();
  await assert.rejects(loadBundle({ gitDir, prerequisite: product.base, ref: { sha: task.sha, name: 'refs/heads/feat/x' },
    ...options }), (error) => {
    assert.ok(error instanceof BundleError, `${error.constructor.name}: ${error.message}`);
    assert.match(error.message, pattern);
    return true;
  });
  assert.deepEqual(await refs(gitDir), [], 'no ref was written');
  return gitDir;
}

test('AC6: a good bundle is read in: its commit there, no ref written, main\'s old bad objects not read', async () => {
  const gitDir = await freshRepo();
  assert.deepEqual(await loadBundle({ gitDir, bundle: task.bundle, prerequisite: product.base,
    ref: { sha: task.sha, name: 'refs/heads/feat/x' } }), { sha: task.sha, name: 'refs/heads/feat/x' });
  assert.equal(git(gitDir, ['--git-dir', gitDir, 'cat-file', '-t', task.sha]), 'commit');
  assert.deepEqual(await refs(gitDir), []);
});

test('AC6 control: main\'s history does hold objects a strict fsck refuses, through the alternates too', async () => {
  const gitDir = await freshRepo();
  await loadBundle({ gitDir, bundle: task.bundle, prerequisite: product.base,
    ref: { sha: task.sha, name: 'refs/heads/feat/x' } });
  assert.throws(() => git(gitDir, ['--git-dir', gitDir, 'fsck', '--strict']), /missingEmail|zeroPaddedFilemode/,
    'a plain fsck --strict (--full) would refuse this good bundle\'s repository');
});

test('AC6: a commit with no author email is refused by the strict check, before any ref', async () => {
  const bad = await makeTask(root.dir, product, { noEmail: true, name: 'task-no-email' });
  await refused({ bundle: bad.bundle, ref: { sha: bad.sha, name: 'refs/heads/feat/x' } },
    /^the bundle's objects fail git's strict check: .*missingEmail/);
});

test('AC6 control: what this git\'s own fetch of that bundle does with fsckObjects depends on its version',
  async (t) => {
    // git 2.39.5 and 2.43.0 (the VM's) let the commit in; a newer git (CI's 2.56.1) refuses it. The dispatcher's
    // check is index-pack --strict on every version (the test above), never this setting: hence this control
    // reports, and holds only that the outcome is one of the two.
    const bad = await makeTask(root.dir, product, { noEmail: true, name: 'task-no-email-fetch' });
    const file = join(root.dir, 'no-email.bundle');
    await writeFile(file, bad.bundle);
    const gitDir = await freshRepo();
    let outcome;
    try {
      git(gitDir, ['--git-dir', gitDir, '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', 'fetch',
        '-q', file, 'refs/heads/feat/x:refs/heads/fetched']);
      assert.equal(git(gitDir, ['--git-dir', gitDir, 'rev-parse', 'refs/heads/fetched']), bad.sha);
      outcome = 'lets the commit with no author email in';
    } catch (error) {
      assert.match(String(error.stderr ?? error.message), /missingEmail/, 'refused, if at all, for the missing email');
      outcome = 'refuses the commit with no author email';
    }
    t.diagnostic(`${GIT_VERSION}: fetch <bundle> with fsckObjects ${outcome}`);
  });

test('AC6: prerequisites not exactly the base are refused before git reads the pack', async () => {
  const pack = packOf(task.dir, [task.sha, `^${product.base}`]);
  const ref = `${task.sha} refs/heads/feat/x`;
  await refused({ bundle: bundleOf({ lines: [ref], pack }) }, /prerequisites must be exactly .*; it has none/);
  await refused({ bundle: bundleOf({ lines: [`-${product.base}`, `-${'1'.repeat(40)}`, ref], pack }) },
    /prerequisites must be exactly/);
  await refused({ bundle: bundleOf({ lines: [`-${'2'.repeat(40)}`, ref], pack }) },
    new RegExp(`prerequisites must be exactly ${product.base}; it has 2{40}`));
  const full = git(task.dir, ['bundle', 'create', '-', 'feat/x'], { binary: true });
  await refused({ bundle: full }, /it has none/);
});

test('AC6: more than one ref, or another ref, or the ref at another commit, is refused', async () => {
  const pack = packOf(task.dir, [task.sha, `^${product.base}`]);
  const pre = `-${product.base}`;
  await refused({ bundle: bundleOf({ lines: [pre, `${task.sha} refs/heads/feat/x`, `${task.sha} refs/heads/feat/y`],
    pack }) }, /exactly one ref, refs\/heads\/feat\/x; it holds 2/);
  await refused({ bundle: bundleOf({ lines: [pre], pack }) }, /it holds 0/);
  for (const name of ['refs/heads/other', 'refs/tags/x', 'refs/heads/factory/feat/x']) {
    await refused({ bundle: bundleOf({ lines: [pre, `${task.sha} ${name}`], pack }) },
      new RegExp(`ref must be refs/heads/feat/x at ${task.sha}; it is ${name.replaceAll('/', '\\/')}`));
  }
  await refused({ bundle: task.bundle, ref: { sha: '3'.repeat(40), name: 'refs/heads/feat/x' } },
    /ref must be refs\/heads\/feat\/x at 3{40}; it is refs\/heads\/feat\/x at /);
});

test('AC6: a ref whose history does not grow from the prerequisite, under a correct header, is refused', async () => {
  const separate = separateHistory(task);
  await refused({
    bundle: bundleOf({ lines: [`-${product.base}`, `${separate.sha} refs/heads/feat/x`], pack: separate.pack }),
    ref: { sha: separate.sha, name: 'refs/heads/feat/x' },
  }, new RegExp(`ref ${separate.sha} does not descend from its prerequisite ${product.base}`));
});

test('AC6: data after the pack, a pack cut short, or a pack missing, is refused', async () => {
  await refused({ bundle: Buffer.concat([task.bundle, Buffer.from('more')]) }, /holds data after its pack/);
  await refused({ bundle: task.bundle.subarray(0, task.bundle.length - 10) }, /fail git's strict check/);
  const header = task.bundle.subarray(0, task.bundle.indexOf('\n\n') + 2);
  await refused({ bundle: Buffer.concat([header, Buffer.from('not a pack at all, but long enough to be read')]) },
    /holds no pack after its header/);
});

test('the header is Node\'s to read, strictly: signature, capabilities, lines, bytes', () => {
  const pack = Buffer.from(`PACK${'\0'.repeat(28)}`);
  const pre = `-${'a'.repeat(40)}`;
  const ref = `${'b'.repeat(40)} refs/heads/feat/x`;
  assert.deepEqual(parseBundle(bundleOf({ lines: [`${pre} a comment`, ref], pack })),
    { version: 2, prerequisites: ['a'.repeat(40)], refs: [{ sha: 'b'.repeat(40), name: 'refs/heads/feat/x' }], pack });
  assert.equal(parseBundle(bundleOf({ version: 3, lines: ['@object-format=sha1', pre, ref], pack })).version, 3);
  const bad = (lines, pattern, version = 2) => assert.throws(() => parseBundle(bundleOf({ version, lines, pack })),
    (error) => error instanceof BundleError && pattern.test(error.message));
  bad(['@object-format=sha1', pre, ref], /capability/);
  bad(['@object-format=sha256', pre, ref], /capability/, 3);
  bad([`@filter=blob:none`, pre, ref], /capability/, 3);
  bad([pre, '@object-format=sha1', ref], /capability/, 3);
  bad([pre, `${'B'.repeat(40)} refs/heads/x`], /line 3 is neither/);
  bad([pre, `${'b'.repeat(40)} heads/x`], /line 3 is neither/);
  bad([pre, `${'b'.repeat(40)} refs/heads/a b`], /line 3 is neither/);
  bad([`-${'a'.repeat(39)}`, ref], /line 2 is neither/);
  bad([pre, `${ref}\r`], /not printable ASCII/);
  bad([pre, `${'b'.repeat(40)} refs/heads/é`], /not printable ASCII/);
  assert.throws(() => parseBundle(Buffer.from(`# v4 git bundle\n${pre}\n\nPACK`)), /signature/);
  assert.throws(() => parseBundle(Buffer.concat([Buffer.from(`# v2 git bundle\n${'-'.repeat(MAX_HEADER_BYTES)}\n\n`),
    pack])), /no header that ends within/);
  assert.throws(() => parseBundle('a string'), TypeError);
});

test('a bundle file is read as the dispatcher\'s files are: its own, 600, no symlink, not too large', async () => {
  const dir = join(root.dir, 'files');
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, 'task.bundle');
  await writeFile(path, task.bundle, { mode: 0o600 });
  assert.deepEqual(await readBundleFile(path), task.bundle);
  await symlink(path, join(dir, 'link.bundle'));
  await assert.rejects(readBundleFile(join(dir, 'link.bundle')), /not a regular file/);
  await assert.rejects(readBundleFile(path, { uid: process.getuid() + 1 }), /owned by uid/);
  await chmod(path, 0o644);
  await assert.rejects(readBundleFile(path), /has mode 644/);
});
