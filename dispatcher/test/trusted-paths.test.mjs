// A task's branch that changes a path of the base's trustedPaths is refused before its gate, by the dispatcher's own
// check (incident-platform backlog #0-278 AC1, AC3, AC6): its commits read in from their bundle, as data, into a
// repository made for the check; the changed paths listed there by the dispatcher's git; held to the adapter read from
// the base, never the branch's. A change, an addition, a removal, a rename out, a file in place of a directory or a
// symlink in place of one is refused; a change elsewhere passes. No product code runs for it: the product's
// changed-paths script, which would leave a mark, never runs. A refusal names the field and the count, never a path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  TrustedPathsError, changedPathsOf, changesEntry, checkChangedPaths, checkTaskPaths,
} from '../src/product/trusted-paths.mjs';
import { ADAPTER, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);
const RUN_ID = '20261121T101500Z-3f9a1c';
const MARK = join(root.dir, 'a-product-script-ran');
let n = 0;

/** A product whose scripts leave MARK if run anywhere, and its base's adapter. */
async function setUp() {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir, { mode: 0o700 });
  const marking = `#!/bin/sh\ntouch '${MARK}'\n`;
  const product = await makeAdapterProduct(dir, { files: { 'scripts/factory/run-tests.sh': marking,
    'scripts/factory/changed-paths.sh': marking, 'src/app.txt': 'app\n' } });
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  return { dir, product, stateDir };
}

/** The task's branch: a clone of the product with one commit of `change`, and its bundle. */
async function branchOf({ dir, product }, change, name = `task-${n}`) {
  const work = join(dir, name);
  git(dir, ['clone', '-q', product.work, work]);
  git(work, ['checkout', '-q', '-b', 'feat/0-278-x']);
  await change(work);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '--allow-empty', '-m', 'the task\'s commit']);
  const sha = git(work, ['rev-parse', 'HEAD']);
  return { work, sha, bundle: git(work, ['bundle', 'create', '-', `${product.base}..feat/0-278-x`], { binary: true }) };
}

const task = (product) => ({ runId: RUN_ID, branch: 'feat/0-278-x', baseSha: product.base });
// No adapter is given: checkTaskPaths reads the one of the task's base itself (review round 1, e).
const check = (setup, branch) => checkTaskPaths({ stateDir: setup.stateDir, repoDir: setup.product.repoDir,
  task: task(setup.product), bundle: branch.bundle, sha: branch.sha, git: REAL_GIT });

async function refused(promise, pattern, values = [], what = 'the change') {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TrustedPathsError, `${error.constructor.name}: ${error.message}`);
    assert.match(error.message, pattern);
    for (const value of values) {
      assert.ok(!error.message.includes(value), `the refusal holds the path ${value}`);
    }
    return true;
  }, what);
}

const write = (path, text) => async (work) => {
  await mkdir(join(work, path, '..'), { recursive: true });
  await writeFile(join(work, path), text);
};

test('AC1, AC6: a branch that changes a trusted script is refused before its gate, and no product script runs',
  async () => {
    const setup = await setUp();
    const branch = await branchOf(setup, write('scripts/factory/run-tests.sh', '#!/bin/sh\necho pass\n'));
    await refused(check(setup, branch), /^the task's branch changes what judges it, refused before its gate: 1 path of the adapter's trustedPaths\[0\] \(the adapter is the base's\)$/,
      ['run-tests', 'scripts/factory']);
    assert.equal(existsSync(MARK), false, 'no product script ran: changed-paths is advisory and not the check');
    assert.deepEqual(await readdir(join(setup.stateDir, 'tasks', RUN_ID)), [], 'the check\'s repository is removed');
  });

test('AC1: an addition, a removal, the adapter changed, a rename out, a directory replaced: each refused', async () => {
  const cases = {
    'a new file in a trusted directory': write('scripts/factory/new.sh', 'x\n'),
    'a removal': (work) => rm(join(work, 'scripts/factory/lib/common.sh')),
    'the adapter changed': write('.factory/adapter.json', '{}\n'),
    'a rename out': (work) => { git(work, ['mv', 'scripts/factory/lib/common.sh', 'common.sh']); },
    'a file in place of the directory': async (work) => {
      await rm(join(work, 'scripts/factory'), { recursive: true });
      await writeFile(join(work, 'scripts/factory'), 'x\n');
    },
    'a symlink in place of the directory': async (work) => {
      await rm(join(work, 'scripts/factory'), { recursive: true });
      await symlink('../elsewhere', join(work, 'scripts/factory'));
    },
    'a mode changed': (work) => chmod(join(work, 'scripts/factory/run-tests.sh'), 0o644),
  };
  for (const [what, change] of Object.entries(cases)) {
    const setup = await setUp();
    const branch = await branchOf(setup, change);
    await refused(check(setup, branch), /^the task's branch changes what judges it, refused before its gate: \d+ paths? of the adapter's trustedPaths\[[01]\]/, [], what);
  }
});

test('AC1 control: a change outside the trusted paths passes, and the changed paths are returned for 4.5', async () => {
  const setup = await setUp();
  const branch = await branchOf(setup, async (work) => {
    await write('src/app.txt', 'changed\n')(work);
    await write('scripts/factory-notes.md', 'beside, not under\n')(work);
    await write('.factory-old/x', 'a name that only starts like it\n')(work);
  });
  assert.deepEqual((await check(setup, branch)).sort(), ['.factory-old/x', 'scripts/factory-notes.md', 'src/app.txt']);
  const empty = await branchOf(setup, async () => {}, 'empty');
  assert.deepEqual(await check(setup, empty), []);
});

test('AC3: the branch\'s adapter drops a trusted path, and the task still refuses a change to it: the base\'s rules '
  + '(no adapter can be handed in: the check reads the base\'s)',
  async () => {
    const setup = await setUp();
    const branch = await branchOf(setup, async (work) => {
      await write('.factory/adapter.json', `${JSON.stringify({ ...ADAPTER, trustedPaths: ['.factory/'] })}\n`)(work);
      await write('scripts/factory/run-tests.sh', '#!/bin/sh\necho pass\n')(work);
    });
    await refused(check(setup, branch), /1 path of the adapter's trustedPaths\[0\], 1 path of the adapter's trustedPaths\[1\]/);
    // An adapter handed in is not an option the check takes: the base's is read whatever the call says.
    await refused(checkTaskPaths({ stateDir: setup.stateDir, repoDir: setup.product.repoDir, task: task(setup.product),
      bundle: branch.bundle, sha: branch.sha, git: REAL_GIT, adapter: { trustedPaths: ['elsewhere/'] } }),
    /1 path of the adapter's trustedPaths\[0\], 1 path of the adapter's trustedPaths\[1\]/);
  });

test('a bundle not of the task, or a base not recorded, is refused before any path is listed', async () => {
  const setup = await setUp();
  const branch = await branchOf(setup, write('src/app.txt', 'x\n'));
  await assert.rejects(check(setup, { ...branch, sha: setup.product.base }), /the bundle's ref must be/);
  await assert.rejects(checkTaskPaths({ stateDir: setup.stateDir, repoDir: setup.product.repoDir,
    task: { ...task(setup.product), baseSha: null }, bundle: branch.bundle, sha: branch.sha, git: REAL_GIT }),
  (error) => error instanceof TrustedPathsError && /has no base recorded$/.test(error.message));
});

test('changesEntry: a directory entry, its own name, a file entry and a directory put in its place', () => {
  assert.ok(changesEntry('scripts/factory/', 'scripts/factory/a.sh'));
  assert.ok(changesEntry('scripts/factory/', 'scripts/factory'));
  assert.ok(!changesEntry('scripts/factory/', 'scripts/factory-x/a.sh'));
  assert.ok(!changesEntry('scripts/factory/', 'scripts/factor'));
  assert.ok(changesEntry('.factory/adapter.json', '.factory/adapter.json'));
  assert.ok(changesEntry('.factory/adapter.json', '.factory/adapter.json/x'));
  assert.ok(!changesEntry('.factory/adapter.json', '.factory/adapter.json5'));
  assert.doesNotThrow(() => checkChangedPaths({ adapter: ADAPTER, changed: ['src/x'] }));
  assert.throws(() => checkChangedPaths({ adapter: ADAPTER, changed: ['src/x', '.factory/a', '.factory/b'] }),
    /: 2 paths of the adapter's trustedPaths\[1\] \(the adapter/);
});

test('changedPathsOf lists names whole with -z, both sides of a rename, and refuses a sha not 40 hex', async () => {
  const setup = await setUp();
  const branch = await branchOf(setup, async (work) => {
    await write('src/a name\twith tab', 'x\n')(work);
    git(work, ['mv', 'src/app.txt', 'src/moved.txt']);
  });
  git(setup.product.repoDir, ['fetch', '-q', branch.work, 'feat/0-278-x:refs/heads/probe']);
  assert.deepEqual((await changedPathsOf({ gitDir: setup.product.repoDir, base: setup.product.base, head: branch.sha,
    git: REAL_GIT })).sort(), ['src/a name\twith tab', 'src/app.txt', 'src/moved.txt']);
  await assert.rejects(changedPathsOf({ gitDir: setup.product.repoDir, base: 'main', head: branch.sha }), TypeError);
});
