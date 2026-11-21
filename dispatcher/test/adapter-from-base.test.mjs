// The adapter read from the base commit of FACTORY_REPO_DIR, as a blob, never from a checkout nor from a task's branch
// (incident-platform backlog #0-278 AC3, AC5): checked against its schema, then against the base's tree, every path it
// names resolved there segment by segment, from the tree's entries; a symlink at a path or on the way to it, a
// submodule, a file in place of a directory, a path missing, a script outside trustedPaths or not executable, and an
// adapter outside its own trustedPaths are refused, each naming the field and never a value. The schema checks the
// spelling only: the paths it lets through are the tree's to refuse.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AdapterError, checkAdapter } from '../src/adapter.mjs';
import { ADAPTER_PATH, readAdapter } from '../src/product/adapter-from-base.mjs';
import { BaseTreeError, readBlobs, resolveInBase, segmentsOf, subtreeFiles } from '../src/product/base-tree.mjs';
import { ADAPTER, SCRIPTS, adapterFiles, commit, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);
let n = 0;

async function product(options) {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir, { mode: 0o700 });
  return makeAdapterProduct(dir, options);
}

const read = (p, base = p.base) => readAdapter({ repoDir: p.repoDir, base, git: REAL_GIT });

/** Refused with `pattern`, and no value of the adapter in the message. */
async function refused(promise, pattern, values = []) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AdapterError || error instanceof BaseTreeError, `${error.constructor.name}: ${error.message}`);
    assert.match(error.message, pattern);
    for (const value of values) {
      assert.ok(!error.message.includes(value), `the refusal holds the value ${value}: ${error.message}`);
    }
    return true;
  });
}

test('AC3: the adapter is the base\'s blob: read, checked, frozen; a later commit of main does not change it', async () => {
  const p = await product();
  const adapter = await read(p);
  assert.deepEqual(adapter, ADAPTER);
  assert.ok(Object.isFrozen(adapter) && Object.isFrozen(adapter.trustedPaths));
  const later = await commit(p.work, { files: { '.factory/adapter.json': `${JSON.stringify({ ...ADAPTER,
    profile: 'other' })}\n` } });
  git(p.work, ['push', '-q', p.repoDir, 'HEAD:refs/heads/main']);
  assert.equal((await read(p)).profile, 'spring-boot', 'the base asked for, not main');
  assert.equal((await read(p, later)).profile, 'other');
});

test('AC3: the adapter in the work directory is never read: only the tree of the base', async () => {
  const p = await product();
  await writeFile(join(p.work, ADAPTER_PATH), '{ not the base\'s');
  assert.deepEqual(await read(p), ADAPTER);
  await writeFile(join(p.repoDir, 'adapter.json'), 'planted beside the bare clone');
  assert.deepEqual(await read(p), ADAPTER);
});

test('a base with no adapter is refused, marked missing for the caller\'s remedy; one not JSON, or off its schema, too',
  async () => {
    const none = await product({ files: { [ADAPTER_PATH]: null } });
    await assert.rejects(read(none), (error) => error instanceof AdapterError && error.missing === true
      && error.message === 'the base holds no .factory/adapter.json');
    const quoted = 'ghs' + '_x';
    const notJson = await product({ files: { [ADAPTER_PATH]: `{"repository": "${quoted}"` } });
    await refused(read(notJson), /^the adapter \.factory\/adapter\.json of the base is not JSON$/, [quoted]);
    const off = await product({ files: { [ADAPTER_PATH]: JSON.stringify({ ...ADAPTER, trustedPaths: [] }) } });
    await refused(read(off), /^the adapter breaks its schema: \/trustedPaths: /);
  });

test('AC5: the adapter itself, or .factory, a symlink in the base, is refused, read from the tree, not a checkout',
  async () => {
    const atFile = await product({ files: { [ADAPTER_PATH]: null, 'elsewhere/adapter.json': adapterFiles()[ADAPTER_PATH] },
      links: { [ADAPTER_PATH]: '../elsewhere/adapter.json' } });
    await refused(read(atFile), /^the adapter \.factory\/adapter\.json reaches a symlink in the base \(segment 2 of 2\)/);
    const p = await product();
    await commit(p.work, { files: { '.factory': null, 'real/adapter.json': adapterFiles()[ADAPTER_PATH] },
      links: { '.factory': 'real' } });
    git(p.work, ['push', '-q', p.repoDir, 'HEAD:refs/heads/main']);
    const head = git(p.work, ['rev-parse', 'HEAD']);
    await refused(read(p, head), /^the adapter \.factory\/adapter\.json reaches a symlink in the base \(segment 1 of 2\)/);
  });

const FIELDS = [
  ['gate.command[0]', (a, v) => ({ ...a, gate: { ...a.gate, command: [v] } })],
  ['changedPaths.command[0]', (a, v) => ({ ...a, changedPaths: { command: [v] } })],
  ['queue.files[1]', (a, v) => ({ ...a, queue: { ...a.queue, files: [a.queue.files[0], v] } })],
  ['protectedPaths.file', (a, v) => ({ ...a, protectedPaths: { file: v } })],
  ['taskImage', (a, v) => ({ ...a, taskImage: v })],
];

test('AC5: every path the adapter names is resolved in the base: a symlink at it is refused, field by field', async () => {
  for (const [field, set] of FIELDS) {
    // A script under scripts/factory/, so the rule of trustedPaths holds and the symlink is what is refused.
    const path = field.endsWith('command[0]') ? 'scripts/factory/link.sh' : field === 'taskImage' ? 'link.json' : 'link.md';
    const p = await product({ adapter: set(ADAPTER, path), links: { [path]: 'README.md' } });
    await refused(read(p), new RegExp(`^the adapter's ${field.replace(/[[\].]/g, '\\$&')} reaches a symlink in the base `
      + '\\(segment \\d of \\d\\): a symlink is refused$'), [path, 'README.md']);
  }
});

test('AC5: a symlinked directory on the way to a path is refused, as is a file in its place, a submodule, a path missing',
  async () => {
    const viaLink = await product({ adapter: { ...ADAPTER, protectedPaths: { file: 'rules/protected-paths.md' } },
      files: { 'real-rules/protected-paths.md': 'x\n' }, links: { rules: 'real-rules' } });
    await refused(read(viaLink),
      /^the adapter's protectedPaths\.file reaches a symlink in the base \(segment 1 of 2\): a symlink is refused$/,
      ['rules', 'real-rules']);
    const viaFile = await product({ adapter: { ...ADAPTER, protectedPaths: { file: 'README.md/x.md' } } });
    await refused(read(viaFile), /^the adapter's protectedPaths\.file goes through a file of the base \(segment 1 of 2/);
    const missing = await product({ adapter: { ...ADAPTER, queue: { kind: 'backlog-md', files: ['NONE.md'] } } });
    await assert.rejects(read(missing), (error) => error.missing === true
      && /^the adapter's queue\.files\[0\] is not in the base \(segment 1 of 1 is missing\)$/.test(error.message));
    const sub = await product();
    git(sub.work, ['update-index', '--add', '--cacheinfo', `160000,${sub.base},vendor/sub`]);
    git(sub.work, ['commit', '-q', '-m', 'a submodule']);
    const withSub = git(sub.work, ['rev-parse', 'HEAD']);
    git(sub.work, ['push', '-q', sub.repoDir, 'HEAD:refs/heads/main']);
    await refused(resolveInBase({ repoDir: sub.repoDir, base: withSub, path: 'vendor/sub', kind: 'file', what: 'x',
      git: REAL_GIT }), /^x reaches a submodule in the base \(segment 2 of 2\)/);
  });

test('AC5: trustedPaths: a directory entry must be a directory of the base, a file entry a file; a symlink is refused',
  async () => {
    const dirIsFile = await product({ adapter: { ...ADAPTER, trustedPaths: [...ADAPTER.trustedPaths, 'README.md/'] } });
    await refused(read(dirIsFile), /^the adapter's trustedPaths\[2\] is not a directory of the base$/);
    const fileIsDir = await product({ adapter: { ...ADAPTER, trustedPaths: [...ADAPTER.trustedPaths, 'scripts'] } });
    await refused(read(fileIsDir), /^the adapter's trustedPaths\[2\] is not a file of the base$/);
    const linked = await product({ adapter: { ...ADAPTER, trustedPaths: [...ADAPTER.trustedPaths, 'tools/'] },
      files: { 'real-tools/x.sh': 'x\n' }, links: { tools: 'real-tools' } });
    await refused(read(linked), /^the adapter's trustedPaths\[2\] reaches a symlink in the base \(segment 1 of 1\)/);
  });

test('AC5: the schema checks the spelling only; the tree refuses what it lets through', () => {
  // Paths the schema takes, each refused by the tree's rule (segmentsOf) or by its resolution.
  for (const path of ['scripts/factory/.', 'scripts//factory/run-tests.sh', './scripts/factory/run-tests.sh',
    'scripts/./factory/run-tests.sh']) {
    assert.doesNotThrow(() => checkAdapter({ ...ADAPTER, gate: { ...ADAPTER.gate, command: [path] } }), path);
    assert.throws(() => segmentsOf(path, 'the adapter\'s gate.command[0]'), (error) => error instanceof BaseTreeError
      && /^the adapter's gate\.command\[0\] has an empty, \. or \.\. segment \(segment \d\)$/.test(error.message));
  }
});

test('a script with a . segment, outside trustedPaths, or not executable is refused; the adapter outside them too',
  async () => {
    const dot = await product({ adapter: { ...ADAPTER, gate: { ...ADAPTER.gate, command: ['scripts/factory/.'] } } });
    await refused(read(dot), /^the adapter's gate\.command\[0\] has an empty, \. or \.\. segment \(segment 3\)$/);
    const outside = await product({ adapter: { ...ADAPTER, changedPaths: { command: ['bin/changed.sh'] } },
      files: { 'bin/changed.sh': '#!/bin/sh\n' }, executable: [...SCRIPTS, 'bin/changed.sh'] });
    await refused(read(outside), /^the adapter's changedPaths\.command\[0\] is not under any of its trustedPaths: a task /);
    const plain = await product({ executable: ['scripts/factory/changed-paths.sh'] });
    await refused(read(plain), /^the adapter's gate\.command\[0\] is not executable in the base \(mode 100755\)$/);
    const self = await product({ adapter: { ...ADAPTER, trustedPaths: ['scripts/factory/'] } });
    await refused(read(self), /^the adapter \.factory\/adapter\.json is not under any of its trustedPaths: a task could /);
    const named = await product({ adapter: { ...ADAPTER, trustedPaths: ['scripts/factory/', '.factory/adapter.json'] } });
    assert.deepEqual((await read(named)).trustedPaths, ['scripts/factory/', '.factory/adapter.json']);
  });

test('subtreeFiles lists every file under a trusted directory, and refuses it whole for one symlink in it', async () => {
  const p = await product();
  const files = await subtreeFiles({ repoDir: p.repoDir, base: p.base, dir: 'scripts/factory', what: 'w', git: REAL_GIT });
  assert.deepEqual(files.map((f) => [f.path, f.mode]), [['scripts/factory/changed-paths.sh', '100755'],
    ['scripts/factory/lib/common.sh', '100644'], ['scripts/factory/run-tests.sh', '100755']]);
  const [text] = await readBlobs({ repoDir: p.repoDir, oids: [files[1].oid], git: REAL_GIT, what: 'w' });
  assert.equal(text.toString(), 'common=1\n');
  const linked = await product({ links: { 'scripts/factory/lib/up.sh': '../../../README.md' } });
  await refused(subtreeFiles({ repoDir: linked.repoDir, base: linked.base, dir: 'scripts/factory',
    what: 'the adapter\'s trustedPaths[0]', git: REAL_GIT }),
  /^the adapter's trustedPaths\[0\] holds a symlink in the base: the directory is refused$/, ['up.sh', 'README']);
  await refused(read(linked), /trustedPaths\[0\] holds a symlink/);
});

test('a path is a pathspec of literal characters: a * names a file of that name, never a pattern', async () => {
  const p = await product({ files: { 'docs/a*.md': 'star\n', 'docs/abc.md': 'abc\n' } });
  await refused(resolveInBase({ repoDir: p.repoDir, base: p.base, path: 'docs/*', kind: 'file', what: 'x',
    git: REAL_GIT }), /^x is not in the base \(segment 2 of 2 is missing\)$/);
  const star = await resolveInBase({ repoDir: p.repoDir, base: p.base, path: 'docs/a*.md', kind: 'file', what: 'x',
    git: REAL_GIT });
  assert.equal((await readBlobs({ repoDir: p.repoDir, oids: [star.oid], git: REAL_GIT, what: 'x' }))[0].toString(),
    'star\n');
});
