// `node dispatcher/src/cli.mjs` end to end, in a child process with the environment it is given (incident-platform
// backlog #0-275): every refusal is a line on stderr and the exit code 1, naming the variable and never its value
// (AC1, AC7); a second run while one holds the lock is refused, and a killed run's lock is free again (AC2); the
// breaker refuses a run (tripped, or unreadable). A run that gets as far as factory's daemon (#0-277) runs in this
// process, through main(), with the fake daemon as its sudo (CI has no factory and no sudo rule): v0's run sets up
// the adapter, the state, the daemon and the task container, and stops (its phases are 4.4's); `sweep` is the sweep
// alone, refused while a rollback runs, but with --force.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { writeJsonAtomic } from '../src/state/files.mjs';
import { kill, run, startUntil } from '../testing/children.mjs';
import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { makeStateDir, validEnv } from '../testing/state-dir.mjs';
import { CONFIG_PATH, makeTaskProduct } from '../testing/task-product.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const HOLD_LOCK = fileURLToPath(new URL('../testing/hold-lock.mjs', import.meta.url));
const ADAPTER = fileURLToPath(new URL('../testing/fixtures/incident-platform.adapter.json', import.meta.url));

async function setUp(t) {
  const state = await makeStateDir();
  const repo = await makeStateDir();
  t.after(state.remove);
  t.after(repo.remove);
  return { stateDir: state.dir, env: validEnv(state.dir, repo.dir) };
}

const cli = (args, env) => run(CLI, args, { env });

/** A state, a product whose main holds a task configuration, its adapter, and the fake daemon, for main(). */
async function setUpDaemon(t, initial) {
  const state = await makeStateDir();
  const scratch = await makeStateDir();
  t.after(state.remove);
  t.after(scratch.remove);
  const product = await makeTaskProduct(scratch.dir);
  const adapter = join(scratch.dir, 'adapter.json');
  await writeFile(adapter, JSON.stringify({ ...JSON.parse(await readFile(ADAPTER, 'utf8')), taskImage: CONFIG_PATH }));
  const fake = makeFakeDaemon(scratch.dir, initial);
  const env = validEnv(state.dir, product.repoDir);
  const lines = [];
  const call = (args) => main(args, { env, out: { write: (line) => lines.push(line) }, sudo: fake.sudo });
  return { stateDir: state.dir, env, product, adapter, fake, call, lines };
}

function refusedWith({ code, stdout, stderr }, pattern, values = []) {
  assert.equal(code, 1, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, pattern);
  for (const value of values) {
    assert.ok(!stderr.includes(value), `stderr holds the value ${value}: ${stderr}`);
  }
}

test('run sets up the state, the daemon, a new task and its container, prints it, and stops with no phase run (v0)',
  async (t) => {
  const { stateDir, adapter, fake, call, lines, product } = await setUpDaemon(t);
  const left = await call(['run', '--item', '0-275', '--adapter', adapter]);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(left.baseSha, product.base);
  assert.match(left.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.ok(fake.calls().some((c) => c.program === 'devcontainer' && c.args[0] === 'up'));
  assert.deepEqual(fake.read().containers, [], 'the daemon swept at the end');
  const printed = JSON.parse(lines.join(''));
  assert.match(printed.runId, /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/);
  assert.deepEqual({ ...printed, runId: undefined }, { runId: undefined, item: '0-275', branch: null, phase: null,
    status: 'running', reason: null });
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json', 'tasks']);
  assert.deepEqual(await readdir(join(stateDir, 'tasks')), [printed.runId]);
  const task = JSON.parse(await readFile(join(stateDir, 'tasks', printed.runId, 'task.json'), 'utf8'));
  assert.equal(task.item, '0-275');
  const again = await call(['run', '--adapter', adapter]);
  assert.equal(again.item, null, 'the lock was released; without --item, the pick (4.4) fills the item');
});

test('the command line is checked before anything else', async (t) => {
  const { stateDir, env } = await setUp(t);
  const usage = /^dispatcher: .*usage: cli\.mjs run \[--item 0-N \| --resume <branch>\] --adapter <path> \| cli\.mjs sweep \[--force\]\n$/;
  refusedWith(await cli([], env), usage);
  refusedWith(await cli(['go', '--adapter', ADAPTER], env), usage);
  refusedWith(await cli(['run'], env), /--adapter is required/);
  refusedWith(await cli(['run', '--adapter', ADAPTER, '--forse'], env), /Unknown option '--forse'/);
  refusedWith(await cli(['run', '--adapter', ADAPTER, '--force'], env), /--force is sweep's/);
  refusedWith(await cli(['sweep', '--adapter', ADAPTER], env), /sweep takes --force alone/);
  refusedWith(await cli(['sweep', '--item', '0-1'], env), /sweep takes --force alone/);
  refusedWith(await cli(['run', '--adapter', ADAPTER, '--item', '0-1', '--resume', 'factory/x'], env),
    /--item and --resume exclude each other/);
  refusedWith(await cli(['run', '--adapter', ADAPTER, '--item', '275'], env), /--item must be a backlog item, 0-N/);
  for (const branch of ['main', '-x', 'factory/../main', 'factory/a b', 'feat/x.lock', 'feat/.x', 'feat/x.']) {
    refusedWith(await cli(['run', '--adapter', ADAPTER, `--resume=${branch}`], env), /--resume must be a branch name/);
  }
  assert.deepEqual(await readdir(stateDir), [], 'a refused run touches no state');
});

test('AC1: a setting missing, malformed or unknown is refused by its name, never its value', async (t) => {
  const { stateDir, env } = await setUp(t);
  const args = ['run', '--adapter', ADAPTER];
  for (const name of Object.keys(env)) {
    const partial = { ...env };
    delete partial[name];
    refusedWith(await cli(args, partial), new RegExp(`^dispatcher: ${name} is not set`));
  }
  refusedWith(await cli(args, { ...env, FACTORY_MAX_BLOCKED: 'many' }),
    /^dispatcher: FACTORY_MAX_BLOCKED must be a positive integer\n$/, ['many']);
  refusedWith(await cli(args, { ...env, FACTORY_MAX_BLOKED: 'typo-value' }),
    /^dispatcher: unknown variable FACTORY_MAX_BLOKED /, ['typo-value']);
  refusedWith(await cli(args, { ...env, FACTORY_PROXY_ADDR: '10.0.0.1:3128' }),
    /^dispatcher: unknown variable FACTORY_PROXY_ADDR /, ['10.0.0.1']);
  refusedWith(await cli(args, { ...env, BUILDER_APP_INSTALATION_ID: 'typo-value' }),
    /^dispatcher: unknown variable BUILDER_APP_INSTALATION_ID /, ['typo-value']);
  refusedWith(await cli(args, { ...env, FACTORY_REPO_DIR: join(stateDir, 'none') }),
    /^dispatcher: FACTORY_REPO_DIR is not a directory\n$/, [stateDir]);
  assert.deepEqual(await readdir(stateDir), []);
});

test('AC7: a value shaped like a secret in any variable is refused by its name, before any other setting',
  async (t) => {
    const { stateDir, env } = await setUp(t);
    // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
    const secret = 'ghs' + `_${'x'.repeat(36)}`;
    for (const name of ['GH_TOKEN', 'FACTORY_REPO_DIR', 'BUILDER_APP_KEY']) {
      refusedWith(await cli(['run', '--adapter', ADAPTER], { ...env, [name]: secret }),
        new RegExp(`^dispatcher: ${name} holds a value shaped like a secret: .*; remove it\\n$`), [secret, 'ghs_']);
    }
    const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIE\n-----END ' + 'RSA PRIVATE KEY-----';
    refusedWith(await cli(['run', '--adapter', ADAPTER], { ...env, FACTORY_UNKNOWN: pem }),
      /^dispatcher: FACTORY_UNKNOWN holds a value shaped like a secret/, ['MIIE', 'BEGIN']);
    assert.deepEqual(await readdir(stateDir), []);
  });

test('FACTORY_STATE_DIR open to others is refused, and left as it is', async (t) => {
  const { stateDir, env } = await setUp(t);
  await chmod(stateDir, 0o755);
  refusedWith(await cli(['run', '--adapter', ADAPTER], env),
    /^dispatcher: FACTORY_STATE_DIR has mode 755: it must be 700\n$/, [stateDir]);
  await chmod(stateDir, 0o700);
  assert.deepEqual(await readdir(stateDir), []);
});

test('AC2: a second run while one holds the lock is refused; once that run is killed, a run goes ahead',
  async (t) => {
    const { stateDir, env, adapter, call } = await setUpDaemon(t);
    const holder = await startUntil(HOLD_LOCK, [stateDir], 'locked');
    try {
      refusedWith(await cli(['run', '--adapter', adapter], env),
        /^dispatcher: another run holds the dispatcher's lock \(.*\): one task at a time in v0\n$/);
      refusedWith(await cli(['sweep', '--force'], env), /^dispatcher: another run holds the dispatcher's lock/);
      assert.deepEqual(await readdir(stateDir), ['lock'], 'the refused run wrote no state');
    } finally {
      await kill(holder);
    }
    assert.equal((await call(['run', '--adapter', adapter])).status, 'running');
  });

test('an adapter that breaks its schema is refused, and no task is made', async (t) => {
  const { stateDir, env } = await setUp(t);
  const adapter = JSON.parse(await readFile(ADAPTER, 'utf8'));
  delete adapter.trustedPaths;
  const path = join(stateDir, '..', `${stateDir.split('/').pop()}-adapter.json`);
  await writeFile(path, JSON.stringify(adapter));
  t.after(() => rm(path, { force: true }));
  refusedWith(await cli(['run', '--adapter', path], env),
    /^dispatcher: the adapter breaks its schema: \/trustedPaths: missing\n$/);
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock']);
});

test('the breaker tripped refuses the run; state.json unreadable tells the owner what to do', async (t) => {
  const { stateDir, env } = await setUp(t);
  await writeJsonAtomic(join(stateDir, 'state.json'),
    { consecutiveBlocked: 3, shippedSinceAudit: 0, lastAudit: null, history: [] });
  refusedWith(await cli(['run', '--adapter', ADAPTER], env),
    /^dispatcher: the breaker has tripped: 3 tasks blocked in a row, FACTORY_MAX_BLOCKED is 3/);
  await writeFile(join(stateDir, 'state.json'), '{"consecutiveBlocked": ', { mode: 0o600 });
  refusedWith(await cli(['run', '--adapter', ADAPTER], env),
    /cannot be read, so the breaker counts as tripped: repair the file .*, or delete it knowingly/);
  assert.equal(await readFile(join(stateDir, 'state.json'), 'utf8'), '{"consecutiveBlocked": ');
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json'], 'no task is made');
});

test('--resume <branch> takes the running task on it, in a container of the image it recorded', async (t) => {
  const { stateDir, adapter, fake, call } = await setUpDaemon(t);
  const first = await call(['run', '--item', '0-9', '--adapter', adapter]);
  const path = join(stateDir, 'tasks', first.runId, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  await writeJsonAtomic(path, { ...task, branch: 'factory/0-9-resumed' });
  const resumed = await call(['run', '--resume', 'factory/0-9-resumed', '--adapter', adapter]);
  assert.equal(resumed.runId, first.runId);
  assert.equal(resumed.status, 'running', resumed.reason);
  assert.equal(resumed.imageId, first.imageId);
  const ups = fake.calls().filter((c) => c.program === 'devcontainer');
  assert.equal(ups.length, 2);
  await assert.rejects(call(['run', '--resume', 'factory/none', '--adapter', adapter]),
    /no task is on the branch factory\/none/);
});

test('#0-277: sweep removes a killed run\'s leftovers; it refuses while a rollback runs, naming it, and --force sweeps '
  + 'that too', async (t) => {
  const rollback = plantedContainer({ name: 'planted-rollback', labels: { 'factory.rollback': '1' } });
  const { call, lines, fake } = await setUpDaemon(t, { containers: [rollback, plantedContainer({ name: 'leftover' })],
    volumes: [{ name: 'incident-platform-gh', labels: {} }] });
  await assert.rejects(call(['sweep']), (error) => {
    assert.match(error.message, /^the sweep is refused: a running container carries factory\.rollback: planted-rollback \(/);
    assert.match(error.message, /clear it with `node --env-file=\/home\/dispatcher\/\.config\/factory\/env \/opt\/factory-checkout\/dispatcher\/src\/cli\.mjs sweep --force`$/);
    return true;
  });
  assert.equal(fake.read().containers.length, 2, 'nothing removed');
  const removed = await call(['sweep', '--force']);
  assert.deepEqual(JSON.parse(lines.at(-1)), { swept: removed });
  assert.deepEqual([...removed.containers].sort(), ['leftover', 'planted-rollback']);
  assert.deepEqual(removed.volumes, ['incident-platform-gh']);
  assert.deepEqual(fake.read().containers, []);
  assert.deepEqual((await call(['sweep'])).containers, [], 'an empty daemon sweeps to nothing');
});

test('#0-277: a run refused by a running rollback makes no task and removes nothing', async (t) => {
  const { stateDir, adapter, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'rollback',
    labels: { 'factory.rollback': '1' } })] });
  await assert.rejects(call(['run', '--item', '0-1', '--adapter', adapter]),
    /the run is refused: a running container carries factory\.rollback: rollback/);
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json']);
  assert.equal(fake.read().containers.length, 1);
});
