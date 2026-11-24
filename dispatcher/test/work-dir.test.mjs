// The task's work directory by one-shot helpers (incident-platform ADR-0062 point 2; backlog #0-277 AC7, AC10, AC12),
// on the fake daemon, whose helper runs its script for real: the clone is made from the base's bundle (made by the
// dispatcher's runGit in FACTORY_REPO_DIR) and shares no inode with FACTORY_REPO_DIR; the helper is the pinned image,
// with no network and three capabilities, the bundle on its stdin and nothing of a product's in its command; the
// dispatcher writes nothing under the tasks' directory; a planted link is not written through; the removal leaves
// nothing, dot entries and the directory itself included.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { BASE_REF, makeBaseBundle } from '../src/git/base-bundle.mjs';
import {
  HELPER_IMAGE, SCRIPTS, WorkDirError, helperArgs, makeWorkDir, removeAllWorkDirs, removeWorkDir, writeOverride,
  writeTokenFile,
} from '../src/container/work-dir.mjs';
import { makeFakeDaemon } from '../testing/fake-daemon.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { HELPER_IMAGE as IMAGE, makeStateDir } from '../testing/state-dir.mjs';
import { makeTaskProduct } from '../testing/task-product.mjs';

const root = await makeStateDir();
after(root.remove);
let n = 0;
const RUN_ID = '20261120T101500Z-3f9a1c';

async function setUp() {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir);
  const product = await makeTaskProduct(dir);
  return { dir, product, fake: makeFakeDaemon(dir) };
}

/** Every inode under `dir`, files only. */
async function inodes(dir) {
  const found = new Set();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const s = await stat(join(entry.parentPath, entry.name));
      found.add(`${s.dev}:${s.ino}`);
    }
  }
  return found;
}

test('AC7: the base\'s bundle is refs/heads/base at the base, made in FACTORY_REPO_DIR; the clone shares no inode '
  + 'with it', async () => {
  const { product, fake } = await setUp();
  const bundle = await makeBaseBundle({ repoDir: product.repoDir, baseSha: product.base, git: REAL_GIT });
  assert.ok(bundle.subarray(0, 80).toString().startsWith(`# v2 git bundle\n${product.base} ${BASE_REF}\n\n`));
  await makeWorkDir({ runId: RUN_ID, bundle, image: IMAGE, ...fake.runner });
  const work = join(fake.tasks, RUN_ID, 'w');
  assert.equal(git(work, ['rev-parse', 'HEAD']), product.base);
  assert.equal(git(work, ['symbolic-ref', 'HEAD']), 'refs/heads/base', 'checked out, by the branch named');
  assert.equal(await readFile(join(work, '.devcontainer', 'Dockerfile'), 'utf8'), 'FROM scratch\n');
  // The bundle removed; `token/` the token's directory, empty until the container is checked (#0-313).
  assert.deepEqual((await readdir(join(fake.tasks, RUN_ID))).sort(), ['token', 'w'], 'the bundle file is removed');
  assert.deepEqual(await readdir(join(fake.tasks, RUN_ID, 'token')), [], 'no token before the container is checked');
  assert.equal((await stat(join(fake.tasks, RUN_ID))).mode & 0o777, 0o700);
  const repo = await inodes(join(product.repoDir, 'objects'));
  const clone = await inodes(join(work, '.git', 'objects'));
  assert.ok(repo.size > 0 && clone.size > 0);
  assert.deepEqual([...clone].filter((inode) => repo.has(inode)), [],
    'no file of the clone\'s objects/ is one of FACTORY_REPO_DIR\'s');
  assert.deepEqual(fake.chowns(), [`-R -h 1000:1000 -- ${join(fake.tasks, RUN_ID, 'w')}`]);
  await assert.rejects(makeBaseBundle({ repoDir: product.repoDir, baseSha: 'f'.repeat(40), git: REAL_GIT }),
    /git update-ref in FACTORY_REPO_DIR failed/);
});

test('AC10: the helper is the pinned image, no network, three capabilities, the bundle on stdin; its command is a '
  + 'constant and the runId', async () => {
  const { product, fake } = await setUp();
  const bundle = await makeBaseBundle({ repoDir: product.repoDir, baseSha: product.base, git: REAL_GIT });
  await makeWorkDir({ runId: RUN_ID, bundle, image: IMAGE, ...fake.runner });
  const [call] = fake.calls();
  assert.deepEqual(call.args, helperArgs({ runId: RUN_ID, image: IMAGE, script: 'make' }));
  assert.deepEqual(call.args.slice(0, 22), ['run', '--rm', '-i', '--pull=never', '--network', 'none', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt',
    'no-new-privileges', '--label', `factory.task=${RUN_ID}`, '--mount',
    'type=bind,source=/home/factory/tasks,target=/tasks']);
  assert.deepEqual(call.args.slice(22), ['--entrypoint', '/bin/sh', IMAGE, '-c', SCRIPTS.make, 'helper', '/tasks', RUN_ID]);
  assert.equal(call.stdinBytes, bundle.length);
  assert.equal(call.stdinSha, createHash('sha256').update(bundle).digest('hex'));
  for (const bad of [{ image: 'buildpack-deps:noble-scm' }, { image: `x@sha256:${'a'.repeat(63)}` },
    { runId: '../../etc' }, { runId: `${RUN_ID} ; rm -rf /` }]) {
    assert.throws(() => helperArgs({ runId: RUN_ID, image: IMAGE, script: 'make', ...bad }), TypeError);
  }
  assert.ok(HELPER_IMAGE.test(IMAGE));
});

test('AC10: the override is written by a helper from stdin; a link planted in its place is not written through, '
  + 'nor is a work directory that exists already', async () => {
  const { product, fake } = await setUp();
  const bundle = await makeBaseBundle({ repoDir: product.repoDir, baseSha: product.base, git: REAL_GIT });
  await makeWorkDir({ runId: RUN_ID, bundle, image: IMAGE, ...fake.runner });
  await writeOverride({ runId: RUN_ID, override: { a: 1 }, image: IMAGE, ...fake.runner });
  const written = join(fake.tasks, RUN_ID, 'devcontainer.json');
  assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), { a: 1 });
  assert.equal((await stat(written)).mode & 0o777, 0o600);
  await assert.rejects(writeOverride({ runId: RUN_ID, override: { a: 2 }, image: IMAGE, ...fake.runner }),
    WorkDirError, 'noclobber: a file there is not written over');
  const other = '20261120T101500Z-0000aa';
  const target = join(root.dir, `outside-${n}`);
  await mkdir(join(fake.tasks, other));
  await symlink(target, join(fake.tasks, other, 'devcontainer.json'));
  await assert.rejects(writeOverride({ runId: other, override: { a: 3 }, image: IMAGE, ...fake.runner }), WorkDirError);
  await assert.rejects(lstat(target), { code: 'ENOENT' }, 'the link is not written through');
  await assert.rejects(makeWorkDir({ runId: RUN_ID, bundle, image: IMAGE, ...fake.runner }),
    /the work directory of .* could not be made: docker run failed/);
  const linked = '20261120T101500Z-0000bb';
  await symlink(target, join(fake.tasks, linked));
  await assert.rejects(writeOverride({ runId: linked, override: {}, image: IMAGE, ...fake.runner }), WorkDirError);
  await assert.rejects(makeWorkDir({ runId: linked, bundle, image: IMAGE, ...fake.runner }), WorkDirError);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  // A link to a directory that exists: `mkdir` (no -p) refuses it, so nothing is written through it.
  const outside = join(root.dir, `outside-dir-${n}`);
  await mkdir(outside);
  const pointing = '20261120T101500Z-0000cc';
  await symlink(outside, join(fake.tasks, pointing));
  await assert.rejects(makeWorkDir({ runId: pointing, bundle, image: IMAGE, ...fake.runner }), WorkDirError);
  assert.deepEqual(await readdir(outside), [], 'no bundle, no clone written through the link');
});

test('AC12: the work directory is removed whole, dot entries and the directory itself; at a run\'s start, every one',
  async () => {
    const { fake } = await setUp();
    const dir = join(fake.tasks, RUN_ID);
    await mkdir(join(dir, 'w', '.git', 'objects'), { recursive: true });
    // devcontainer.json and devcontainer-lock.json: the override and the lockfile `devcontainer up --config` writes.
    for (const name of ['.hidden', '..double', 'devcontainer.json', 'devcontainer-lock.json', 'w/.git/config', 'w/.env',
      'w/x']) {
      await writeFile(join(dir, name), 'x');
    }
    await symlink('/etc', join(dir, 'w', 'link'));
    await removeWorkDir({ runId: RUN_ID, image: IMAGE, ...fake.runner });
    await assert.rejects(lstat(dir), { code: 'ENOENT' });
    await removeWorkDir({ runId: RUN_ID, image: IMAGE, ...fake.runner });
    for (const name of ['20261120T000000Z-aaaaaa', '.left', '..also']) {
      await mkdir(join(fake.tasks, name, '.git'), { recursive: true });
      await writeFile(join(fake.tasks, name, '.git', 'HEAD'), 'x');
      await writeFile(join(fake.tasks, name, 'devcontainer-lock.json'), '{}');
    }
    await writeFile(join(fake.tasks, '.dotfile'), 'x');
    await removeAllWorkDirs({ runId: RUN_ID, image: IMAGE, ...fake.runner });
    assert.deepEqual(await readdir(fake.tasks), []);
    assert.ok((await stat('/etc')).isDirectory(), 'a link is removed, not followed');
    fake.update((s) => { s.scenario.helperFails = true; });
    await assert.rejects(removeAllWorkDirs({ runId: RUN_ID, image: IMAGE, ...fake.runner }),
      /the work directories could not be removed: docker run failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in \S+$/);
  });

test('#0-313: the task\'s token is written from stdin into token/token, 444, never over a file or a link there, and '
  + 'never as an argument', async () => {
  const { product, fake } = await setUp();
  const bundle = await makeBaseBundle({ repoDir: product.repoDir, baseSha: product.base, git: REAL_GIT });
  await makeWorkDir({ runId: RUN_ID, bundle, image: IMAGE, ...fake.runner });
  const token = 'T'.repeat(43);
  await writeTokenFile({ runId: RUN_ID, token, image: IMAGE, ...fake.runner });
  const file = join(fake.tasks, RUN_ID, 'token', 'token');
  assert.equal(await readFile(file, 'utf8'), token);
  assert.equal((await stat(file)).mode & 0o777, 0o444);
  const call = fake.calls().at(-1);
  assert.equal(call.stdinBytes, 43);
  assert.ok(!call.args.join(' ').includes(token), 'the token in no argument');
  // Again, a file there: refused, never written over (noclobber); and a link an agent planted, never followed.
  await assert.rejects(writeTokenFile({ runId: RUN_ID, token: 'U'.repeat(43), image: IMAGE, ...fake.runner }),
    WorkDirError);
  assert.equal(await readFile(file, 'utf8'), token);
  const other = join(fake.tasks, RUN_ID, 'w', 'planted');
  await writeFile(other, 'planted\n');
  const { unlink, chmod } = await import('node:fs/promises');
  await chmod(join(fake.tasks, RUN_ID, 'token'), 0o755);
  await unlink(file).catch(async () => { await chmod(file, 0o644); await unlink(file); });
  await symlink(other, file);
  await assert.rejects(writeTokenFile({ runId: RUN_ID, token: 'V'.repeat(43), image: IMAGE, ...fake.runner }),
    WorkDirError);
  assert.equal(await readFile(other, 'utf8'), 'planted\n', 'the link\'s target untouched');
  assert.throws(() => writeTokenFile({ runId: RUN_ID, token: 'short', image: IMAGE, ...fake.runner }), TypeError);
});
