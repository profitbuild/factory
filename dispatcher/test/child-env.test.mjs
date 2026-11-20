// The one builder of a child's environment (incident-platform backlog #0-276 AC4): childEnv takes what the caller
// allows of the base environment and what it sets, nothing else; and end to end, a marker variable in process.env
// reaches no child of the dispatcher, not any git of a push (init, config, index-pack, cat-file, merge-base, push) nor
// flock(1). Wrappers ahead of the real git and flock record each child's environment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigError } from '../src/config/settings.mjs';
import { childEnv } from '../src/process/child-env.mjs';
import { pushTask } from '../src/github/push.mjs';
import { acquireLock, FLOCK } from '../src/state/lock.mjs';
import { REAL_GIT, makeProduct, makeTask } from '../testing/git-fixtures.mjs';
import { startGitServer } from '../testing/git-server.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);

test('childEnv: the allowed variables that are set, then what the caller sets; nothing else', () => {
  const baseEnv = { PATH: '/bin', HOME: '/home/d', SECRET: 's', EMPTY: '' };
  assert.deepEqual(childEnv({ allow: ['PATH', 'HOME', 'MISSING', 'EMPTY'], set: { LC_ALL: 'C', HOME: '/h' }, baseEnv }),
    { PATH: '/bin', HOME: '/h', EMPTY: '', LC_ALL: 'C' });
  assert.deepEqual(childEnv({ baseEnv }), {}, 'nothing allowed, nothing set: empty');
  assert.deepEqual(childEnv({ allow: [], baseEnv }), {});
  const env = childEnv({ allow: ['PATH'], baseEnv });
  env.PATH = 'changed';
  assert.equal(baseEnv.PATH, '/bin', 'a new object: the base is not changed');
});

test('childEnv: a name that is not one, or a value set that is not a string, is a TypeError', () => {
  for (const name of ['', '1X', 'A-B', 'A B', 'A=B']) {
    assert.throws(() => childEnv({ allow: [name], baseEnv: {} }), TypeError);
    assert.throws(() => childEnv({ set: { [name]: 'x' } }), TypeError);
  }
  assert.throws(() => childEnv({ set: { X: 1 } }), /X must be set to a string/);
});

test('childEnv: an inherited value shaped like a secret is refused by its name; one set by the caller is not checked',
  () => {
    const token = `${'ghs'}_${'x'.repeat(36)}`;
    assert.throws(() => childEnv({ allow: ['HOME'], baseEnv: { HOME: token } }), (error) => error instanceof ConfigError
      && /^HOME holds a value shaped like a secret/.test(error.message) && !error.message.includes(token));
    assert.deepEqual(childEnv({ allow: [], set: { FACTORY_PUSH_TOKEN: token }, baseEnv: { HOME: token } }),
      { FACTORY_PUSH_TOKEN: token }, 'a variable not allowed is not even read');
  });

test('AC4: a marker in process.env reaches no git of a push, nor flock(1); PATH and HOME do', async () => {
  const bin = join(root.dir, 'bin');
  const dumps = join(root.dir, 'dumps');
  await mkdir(bin);
  await mkdir(dumps);
  await writeFile(join(bin, 'git'), `#!/bin/sh\n{ echo "== git $*"; env; } >> ${join(dumps, 'git')}\n`
    + `exec ${REAL_GIT} "$@"\n`);
  await writeFile(join(root.dir, 'flock'), `#!/bin/sh\nenv > ${join(dumps, 'flock')}\nexec ${FLOCK} "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  await chmod(join(root.dir, 'flock'), 0o755);
  const product = await makeProduct(root.dir);
  const task = await makeTask(root.dir, product);
  const token = `push-token-${'y'.repeat(8)}`;
  const server = await startGitServer({ token });
  const stateDir = join(root.dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, MARKER: process.env.FACTORY_TEST_MARKER_276 };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FACTORY_TEST_MARKER_276 = 'marker-value-of-the-parent';
  try {
    acquireLock(stateDir, { flock: join(root.dir, 'flock') }).release();
    await pushTask({
      stateDir, repoDir: product.dir, task: { runId: '20261120T101500Z-000276', branch: 'feat/x', baseSha: product.base },
      bundle: task.bundle, sha: task.sha, branch: 'feat/x', repository: 'profitbuild/incident-platform',
      getToken: async () => token, url: server.url, allowProtocols: 'http:https',
    });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.MARKER === undefined) {
      delete process.env.FACTORY_TEST_MARKER_276;
    } else {
      process.env.FACTORY_TEST_MARKER_276 = saved.MARKER;
    }
    await server.close();
  }
  const gits = await readFile(join(dumps, 'git'), 'utf8');
  const flock = await readFile(join(dumps, 'flock'), 'utf8');
  for (const command of ['init', 'config', 'index-pack', 'cat-file', 'merge-base', 'push']) {
    assert.match(gits, new RegExp(`^== git .*${command}`, 'm'), `the wrapper saw git ${command}`);
  }
  assert.equal(gits.includes('marker-value-of-the-parent'), false, 'no git got the marker');
  assert.equal(gits.includes('FACTORY_TEST_MARKER_276'), false);
  assert.equal(flock.includes('FACTORY_TEST_MARKER_276'), false, 'flock got no marker');
  assert.match(gits, /^PATH=/m);
  assert.equal(flock.split('\n').filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line) && !/^(PWD|SHLVL|_)=/.test(line))
    .length, 0, 'flock gets no variable of the dispatcher\'s at all');
  assert.equal(gits.split('== git ').filter((block) => block.includes(`FACTORY_PUSH_TOKEN=${token}`)).length, 1,
    'the token is in one git\'s environment: the push\'s');
});
