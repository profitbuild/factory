// The product's commands run in the task container only, from the base's blobs of trustedPaths (incident-platform
// backlog #0-278 AC2, AC6; ADR-0060 D6 as amended), on the fake daemon, whose `docker exec` runs the call for real:
// the base's copy runs where the branch's differs, and where the container's copy was changed after the branch's last
// commit; the blobs go in as the dispatcher's own archive on stdin, unpacked into a fresh directory each run, the one a
// run before left removed; the clone is the working directory; two calls, the directory the first prints held to its
// pattern; what the command prints is returned, the agent's side, never quoted in a refusal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setUpTaskContainer } from '../src/container/environment.mjs';
import { readAdapter } from '../src/product/adapter-from-base.mjs';
import {
  ProductCommandError, TRUSTED_DIR, runProductCommand, trustedArchive, unpackedDir, ustar,
} from '../src/product/commands.mjs';
import { createTask } from '../src/state/tasks.mjs';
import { ADAPTER, commit, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { makeFakeDaemon } from '../testing/fake-daemon.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { HELPER_IMAGE, makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);
const RUN_ID = '20261121T101500Z-3f9a1c';
let n = 0;

async function setUp(productOptions) {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir, { mode: 0o700 });
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const product = await makeAdapterProduct(dir, productOptions);
  const fake = makeFakeDaemon(dir);
  const adapter = await readAdapter({ repoDir: product.repoDir, base: product.base, git: REAL_GIT });
  const ready = await setUpTaskContainer({ stateDir, repoDir: product.repoDir, adapter,
    task: await createTask(stateDir, { runId: RUN_ID, item: '0-278', baseSha: product.base }), helperImage: HELPER_IMAGE,
    sudo: fake.sudo, git: REAL_GIT });
  assert.ok(ready.container, ready.task.reason);
  const work = join(fake.tasks, RUN_ID, 'w');
  const run = (which = 'gate', extra = {}) => runProductCommand({ container: ready.container, repoDir: product.repoDir,
    base: product.base, adapter, which, limitS: 30, sudo: fake.sudo, git: REAL_GIT, ...extra });
  return { dir, product, fake, adapter, container: ready.container, work, run };
}

const lines = (result) => result.stdout.toString('utf8').trim().split('\n');
const execs = (fake) => fake.calls().filter((c) => c.args[0] === 'exec');

test('AC2: the gate runs the base\'s script, not the branch\'s: the clone\'s copy differs and is not run', async () => {
  const s = await setUp();
  // The branch's commit in the clone: the script changed to pass.
  await writeFile(join(s.work, 'scripts/factory/run-tests.sh'), '#!/bin/sh\necho "the branch\'s copy"\n');
  git(s.work, ['commit', '-q', '-am', 'the agent changes its judge']);
  const result = await s.run('gate');
  assert.equal(result.code, 0, result.stderr);
  const [name, cwd, dir, args] = lines(result);
  assert.equal(name, 'run-tests from the base');
  assert.equal(cwd, `cwd=${s.work}`, 'the clone is the working directory');
  assert.match(dir.slice('dir='.length), /^\/tmp\/factory-trusted\.[A-Za-z0-9]{8}\/scripts\/factory$/);
  assert.equal(args, 'args=');
});

test('AC2: the container\'s copy changed after the branch\'s last commit is not run either', async () => {
  const s = await setUp();
  await writeFile(join(s.work, 'scripts/factory/changed-paths.sh'), '#!/bin/sh\necho "changed after the commit"\n');
  const result = await s.run('changedPaths');
  assert.equal(lines(result)[0], 'changed-paths from the base');
});

test('G: two calls, the archive on the first\'s stdin; a fresh directory for each run, the last one removed', async () => {
  const s = await setUp();
  const before = execs(s.fake).length;
  const first = await s.run();
  const second = await s.run();
  const calls = execs(s.fake).slice(before);
  assert.equal(calls.length, 4);
  const archive = await trustedArchive({ repoDir: s.product.repoDir, base: s.product.base, adapter: s.adapter,
    git: REAL_GIT });
  assert.equal(calls[0].stdinBytes, archive.length, 'the dispatcher\'s archive, on stdin');
  assert.equal(calls[1].stdinBytes, 0, 'the command gets nothing on stdin');
  const tail = calls[1].args.slice(calls[1].args.indexOf('factory-run'));
  assert.equal(tail.length, 4, 'no arguments of its own: the adapter\'s command has none');
  assert.deepEqual([tail[0], tail[1], tail[3]], ['factory-run', '/workspace', 'scripts/factory/run-tests.sh']);
  assert.ok(TRUSTED_DIR.test(tail[2]), 'the directory the first call printed, held to its pattern');
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('timeout') + 6), ['sh', '-c',
    calls[0].args.at(-2), 'factory-unpack']);
  const dirOf = (r) => lines(r)[2].slice('dir='.length).replace(/\/scripts\/factory$/, '');
  assert.notEqual(dirOf(first), dirOf(second));
  assert.ok(TRUSTED_DIR.test(dirOf(second)));
  assert.equal(existsSync(dirOf(first)), false, 'the directory of the run before is removed');
  assert.equal(await readFile(join(dirOf(second), 'scripts/factory/lib/common.sh'), 'utf8'), 'common=1\n');
  assert.equal(existsSync(join(dirOf(second), 'src')), false, 'only the trusted paths');
});

test('G: the command\'s arguments are the base adapter\'s, and its exit code and output are the caller\'s to read',
  async () => {
    const adapter = { ...ADAPTER, gate: { ...ADAPTER.gate, command: ['scripts/factory/run-tests.sh', '--json', 'a b'] } };
    const s = await setUp({ adapter, files: { 'scripts/factory/run-tests.sh': '#!/bin/sh\necho "args=$*"\nexit 125\n' } });
    const result = await s.run('gate');
    assert.equal(result.code, 125, 'an exit of 125 is the product\'s, not taken for a failure to unpack');
    assert.equal(result.stdout.toString().trim(), 'args=--json a b');
  });

test('G: a failure to unpack, or no directory printed, is refused without the agent\'s stderr', async () => {
  const s = await setUp();
  const secret = 'ghs' + `_${'q'.repeat(36)}`;
  s.fake.update((state) => { state.scenario.execFails = { stderr: `tar: ${secret}`, code: 2 }; });
  await assert.rejects(s.run(), (error) => error instanceof ProductCommandError
    && error.message === 'the trusted paths could not be put into the task container (exit 2); its stderr, the '
      + 'agent\'s side\'s, is not quoted' && !error.message.includes(secret));
  s.fake.update((state) => { delete state.scenario.execFails; });
  const before = execs(s.fake).length;
  await assert.rejects(s.run('gate', { adapter: { ...s.adapter, gate: { ...s.adapter.gate, command: ['scripts/factory/../../x.sh'] } } }),
  /has an empty, \. or \.\. segment/);
  await assert.rejects(s.run('gate', { adapter: { ...s.adapter, gate: { ...s.adapter.gate,
    command: ['scripts/factory/.'] } } }), /gate\.command\[0\] has an empty, \. or \.\. segment \(segment 3\)/);
  await assert.rejects(s.run('gate', { adapter: { ...s.adapter, gate: { ...s.adapter.gate,
    command: ['bin/run.sh'] } } }), /gate\.command\[0\] is not under any of its trustedPaths/);
  await assert.rejects(s.run('queue'), TypeError);
  assert.equal(execs(s.fake).length, before, 'refused before any call in the container');
});

test('G: the archive holds directories and regular files alone, their git modes, read back by tar as such', async () => {
  const s = await setUp();
  const archive = await trustedArchive({ repoDir: s.product.repoDir, base: s.product.base, adapter: s.adapter,
    git: REAL_GIT });
  const listed = execFileSync('tar', ['-tvf', '-'], { input: archive, encoding: 'utf8' }).trim().split('\n')
    .map((line) => `${line.split(/\s+/)[0]} ${line.split(/\s+/).at(-1)}`);
  assert.deepEqual(listed, [
    'drwxr-xr-x .factory/', 'drwxr-xr-x scripts/', 'drwxr-xr-x scripts/factory/', 'drwxr-xr-x scripts/factory/lib/',
    '-rw-r--r-- .factory/adapter.json', '-rwxr-xr-x scripts/factory/changed-paths.sh',
    '-rw-r--r-- scripts/factory/lib/common.sh', '-rwxr-xr-x scripts/factory/run-tests.sh',
  ]);
  assert.throws(() => ustar([{ path: '/etc/passwd', mode: '100644', bytes: Buffer.from('x') }]), /empty, \. or \.\. segment/);
  assert.throws(() => ustar([{ path: 'a/../b', mode: '100644', bytes: Buffer.from('x') }]), /empty, \. or \.\. segment/);
  assert.throws(() => ustar([{ path: 'a\nb', mode: '100644', bytes: Buffer.from('x') }]), /control character/);
  assert.throws(() => ustar([{ path: `${'x'.repeat(101)}`, mode: '100644', bytes: Buffer.from('x') }]), /too long/);
});

test('G: a symlink put under a trusted directory of a later base refuses the command, and nothing runs', async () => {
  const s = await setUp();
  const later = await commit(s.product.work, { links: { 'scripts/factory/lib/up.sh': '../../../README.md' } });
  git(s.product.work, ['push', '-q', s.product.repoDir, 'HEAD:refs/heads/main']);
  const before = execs(s.fake).length;
  await assert.rejects(s.run('gate', { base: later }), /trustedPaths\[0\] holds a symlink in the base/);
  assert.equal(execs(s.fake).length, before);
});

test('G: the directory the first call prints is used only in TRUSTED_DIR\'s shape, after an exit of 0', () => {
  const out = (text, code = 0) => ({ code, stdout: Buffer.from(text) });
  assert.equal(unpackedDir(out('/tmp/factory-trusted.AbC123xY\n')), '/tmp/factory-trusted.AbC123xY');
  for (const text of ['/workspace\n', '/tmp/factory-trusted.AbC123xY/../x\n', '/tmp/factory-trusted.short\n',
    '/tmp/factory-trusted.AbC123xY\n/etc\n', '', '/tmp/factory-trusted.AbC123x \n']) {
    assert.throws(() => unpackedDir(out(text)), (error) => error instanceof ProductCommandError
      && /no directory of \/tmp\/factory-trusted\.XXXXXXXX printed/.test(error.message), JSON.stringify(text));
  }
  assert.throws(() => unpackedDir(out('/tmp/factory-trusted.AbC123xY\n', 1)), /\(exit 1\); its stderr/);
});
