// `node dispatcher/src/cli.mjs run` end to end, in a child process with the environment it is given (incident-platform
// backlog #0-275): v0's run sets up the adapter and the state and stops (its phases are 4.4's); every refusal is a
// line on stderr and the exit code 1, naming the variable and never its value (AC1, AC7); a second run while one holds
// the lock is refused, and a killed run's lock is free again (AC2); the breaker refuses a run (tripped, or unreadable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from '../src/state/files.mjs';
import { kill, run, startUntil } from '../testing/children.mjs';
import { makeStateDir, validEnv } from '../testing/state-dir.mjs';

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

function refusedWith({ code, stdout, stderr }, pattern, values = []) {
  assert.equal(code, 1, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, pattern);
  for (const value of values) {
    assert.ok(!stderr.includes(value), `stderr holds the value ${value}: ${stderr}`);
  }
}

test('run sets up the state and a new task, prints it, and stops with no phase run (v0)', async (t) => {
  const { stateDir, env } = await setUp(t);
  const result = await cli(['run', '--item', '0-275', '--adapter', ADAPTER], env);
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.match(printed.runId, /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/);
  assert.deepEqual({ ...printed, runId: undefined }, { runId: undefined, item: '0-275', branch: null, phase: null,
    status: 'running', reason: null });
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json', 'tasks']);
  assert.deepEqual(await readdir(join(stateDir, 'tasks')), [printed.runId]);
  const task = JSON.parse(await readFile(join(stateDir, 'tasks', printed.runId, 'task.json'), 'utf8'));
  assert.equal(task.item, '0-275');
  const again = await cli(['run', '--adapter', ADAPTER], env);
  assert.equal(again.code, 0, `the lock was released: ${again.stderr}`);
  assert.equal(JSON.parse(again.stdout).item, null, 'without --item, the pick (4.4) fills the item');
});

test('the command line is checked before anything else', async (t) => {
  const { stateDir, env } = await setUp(t);
  const usage = /^dispatcher: .*usage: cli\.mjs run \[--item 0-N \| --resume <branch>\] --adapter <path>\n$/;
  refusedWith(await cli([], env), usage);
  refusedWith(await cli(['go', '--adapter', ADAPTER], env), usage);
  refusedWith(await cli(['run'], env), /--adapter is required/);
  refusedWith(await cli(['run', '--adapter', ADAPTER, '--force'], env), /Unknown option '--force'/);
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
    const { stateDir, env } = await setUp(t);
    const holder = await startUntil(HOLD_LOCK, [stateDir], 'locked');
    try {
      refusedWith(await cli(['run', '--adapter', ADAPTER], env),
        /^dispatcher: another run holds the dispatcher's lock \(.*\): one task at a time in v0\n$/);
      assert.deepEqual(await readdir(stateDir), ['lock'], 'the refused run wrote no state');
    } finally {
      await kill(holder);
    }
    const result = await cli(['run', '--adapter', ADAPTER], env);
    assert.equal(result.code, 0, result.stderr);
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

test('--resume <branch> takes the running task on it; with no phase left, it is printed as it was', async (t) => {
  const { stateDir, env } = await setUp(t);
  const first = JSON.parse((await cli(['run', '--item', '0-9', '--adapter', ADAPTER], env)).stdout);
  const path = join(stateDir, 'tasks', first.runId, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  await writeJsonAtomic(path, { ...task, branch: 'factory/0-9-resumed' });
  const result = await cli(['run', '--resume', 'factory/0-9-resumed', '--adapter', ADAPTER], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runId, first.runId);
  refusedWith(await cli(['run', '--resume', 'factory/none', '--adapter', ADAPTER], env),
    /no task is on the branch factory\/none/);
});
