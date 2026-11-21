// `node dispatcher/src/cli.mjs` end to end, in a child process with the environment it is given (incident-platform
// backlog #0-275): every refusal is a line on stderr and the exit code 1, naming the variable and never its value
// (AC1, AC7); a second run while one holds the lock is refused, and a killed run's lock is free again (AC2); the
// breaker refuses a run (tripped, or unreadable). A run that gets as far as GitHub and factory's daemon (#0-277,
// #0-278) runs in this process, through main(), with the fake daemon as its sudo (CI has no factory and no sudo rule),
// the fake GitHub as builder-app's API and a loopback git server as GitHub's git: v0's run reads the adapter from
// FACTORY_REPO_DIR's main, brings main up to GitHub's with builder-app's token, reads the adapter again from the new
// base, checks the item's lock, sets up the state, the daemon and the task container, revokes the token, and stops
// (its phases are 4.4's); no product code runs as the dispatcher. `sweep` is the sweep alone, refused while a
// rollback runs, but with --force.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { writeJsonAtomic } from '../src/state/files.mjs';
import { ADAPTER, commit, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { APP_ID, INSTALLATION_ID, startBuilderGitHub, writeAppFiles } from '../testing/builder-github.mjs';
import { kill, run, startUntil } from '../testing/children.mjs';
import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { git } from '../testing/git-fixtures.mjs';
import { startGitFetchServer } from '../testing/git-fetch-server.mjs';
import { makeStateDir, validEnv } from '../testing/state-dir.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const HOLD_LOCK = fileURLToPath(new URL('../testing/hold-lock.mjs', import.meta.url));

// builder-app's API, and GitHub's git serving the product's main (git's own http-backend), for the runs that get there.
const github = await startBuilderGitHub();
const served = await makeStateDir();
await mkdir(join(served.dir, 'profitbuild'));
const gitServer = await startGitFetchServer({ root: served.dir, valid: github.tokenValid });
after(async () => {
  await github.close();
  await gitServer.close();
  await served.remove();
});
const ORIGIN = join(served.dir, 'profitbuild', 'incident-platform.git');
const ORIGIN_URL = `${gitServer.baseUrl}/profitbuild/incident-platform.git`;
/** A product's script that leaves a mark if anything runs it, on the host or anywhere. */
const marking = (mark) => `#!/bin/sh\ntouch '${mark}'\n`;

/** A state and a FACTORY_REPO_DIR, an empty bare repository in a directory of 700, for the runs refused early. */
async function setUp(t) {
  const state = await makeStateDir();
  const repo = await makeStateDir();
  t.after(state.remove);
  t.after(repo.remove);
  const repoDir = join(repo.dir, 'repo.git');
  git(repo.dir, ['init', '-q', '--bare', repoDir]);
  return { stateDir: state.dir, env: validEnv(state.dir, repoDir), repoParent: repo.dir };
}

const cli = (args, env) => run(CLI, args, { env });

/**
 * A state, a product whose main holds its adapter, the scripts it names (each leaving `mark` if run) and a task
 * configuration, served as GitHub's main and cloned bare as FACTORY_REPO_DIR (its origin the served URL), builder-app's
 * key, and the fake daemon, for main(). `advance` adds a commit to GitHub's main.
 */
async function setUpDaemon(t, initial, { product: productOptions = {} } = {}) {
  github.reset();
  const state = await makeStateDir();
  const scratch = await makeStateDir();
  t.after(state.remove);
  t.after(scratch.remove);
  const mark = join(scratch.dir, 'a-product-script-ran');
  const product = await makeAdapterProduct(scratch.dir, { ...productOptions, files: {
    'scripts/factory/run-tests.sh': marking(mark), 'scripts/factory/changed-paths.sh': marking(mark),
    ...productOptions.files } });
  await rm(ORIGIN, { recursive: true, force: true });
  git(served.dir, ['clone', '-q', '--bare', product.work, ORIGIN]);
  git(product.repoDir, ['config', 'remote.origin.url', ORIGIN_URL]);
  const app = await writeAppFiles(scratch.dir, github.privateKey);
  const fake = makeFakeDaemon(scratch.dir, initial);
  const env = { ...validEnv(state.dir, product.repoDir), BUILDER_APP_ID: String(APP_ID),
    BUILDER_APP_INSTALLATION_ID: String(INSTALLATION_ID), BUILDER_APP_KEY: app.keyPath };
  const lines = [];
  const call = (args) => main(args, { env, out: { write: (line) => lines.push(line) }, sudo: fake.sudo,
    apiBase: github.baseUrl, gitBase: gitServer.baseUrl });
  const advance = async (change = { files: { 'src/merged.txt': 'merged\n' } }) => {
    const sha = await commit(product.work, change);
    git(product.work, ['push', '-q', ORIGIN, 'HEAD:refs/heads/main']);
    return sha;
  };
  return { stateDir: state.dir, env, product, fake, call, lines, mark, advance };
}

const pullsAsked = (from) => github.requests.slice(from).filter((r) => r.path.endsWith('/pulls'));

function refusedWith({ code, stdout, stderr }, pattern, values = []) {
  assert.equal(code, 1, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, pattern);
  for (const value of values) {
    assert.ok(!stderr.includes(value), `stderr holds the value ${value}: ${stderr}`);
  }
}

test('run brings main up to GitHub\'s, reads the adapter from the new base, checks the item\'s lock, sets up a new '
  + 'task and its container, prints it, revokes the token, and stops with no phase run (v0)', async (t) => {
  const { stateDir, fake, call, lines, product, mark, advance } = await setUpDaemon(t);
  const head = await advance();
  const start = github.requests.length;
  const left = await call(['run', '--item', '0-275']);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(left.baseSha, head, 'the base is GitHub\'s main, fetched');
  assert.equal(git(product.repoDir, ['rev-parse', 'refs/heads/main']), head);
  assert.deepEqual(pullsAsked(start).map((r) => r.query.get('page')), ['1'], 'the open pull requests, every page');
  assert.deepEqual(github.state.revoked, github.state.minted, 'every token minted is revoked at the end');
  assert.equal(github.state.minted.length, 1, 'one token for the fetch and the list');
  assert.equal(existsSync(mark), false, 'no product code ran');
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
  const again = await call(['run', '--item', '0-276']);
  assert.equal(again.item, '0-276', 'the lock was released');
});

test('the command line is checked before anything else', async (t) => {
  const { stateDir, env } = await setUp(t);
  const usage = /^dispatcher: .*usage: cli\.mjs run --item 0-N \| cli\.mjs run --resume <branch> \| cli\.mjs sweep \[--force\]\n$/;
  refusedWith(await cli([], env), usage);
  refusedWith(await cli(['go', '--item', '0-1'], env), usage);
  refusedWith(await cli(['run'], env),
    /^dispatcher: run needs --item 0-N \(the owner names the item until stage 7\) or --resume <branch>; usage/);
  refusedWith(await cli(['run', '--item', '0-1', '--adapter', '/x/adapter.json'], env), /Unknown option '--adapter'/);
  refusedWith(await cli(['run', '--item', '0-1', '--forse'], env), /Unknown option '--forse'/);
  refusedWith(await cli(['run', '--item', '0-1', '--force'], env), /--force is sweep's/);
  refusedWith(await cli(['sweep', '--item', '0-1'], env), /sweep takes --force alone/);
  refusedWith(await cli(['run', '--item', '0-1', '--resume', 'factory/x'], env),
    /--item and --resume exclude each other/);
  refusedWith(await cli(['run', '--item', '275'], env), /--item must be a backlog item, 0-N/);
  for (const branch of ['main', '-x', 'factory/../main', 'factory/a b', 'feat/x.lock', 'feat/.x', 'feat/x.']) {
    refusedWith(await cli(['run', `--resume=${branch}`], env), /--resume must be a branch name/);
  }
  assert.deepEqual(await readdir(stateDir), [], 'a refused run touches no state');
});

test('AC1: a setting missing, malformed or unknown is refused by its name, never its value', async (t) => {
  const { stateDir, env } = await setUp(t);
  const args = ['run', '--item', '0-1'];
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
      refusedWith(await cli(['run', '--item', '0-1'], { ...env, [name]: secret }),
        new RegExp(`^dispatcher: ${name} holds a value shaped like a secret: .*; remove it\\n$`), [secret, 'ghs_']);
    }
    const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIE\n-----END ' + 'RSA PRIVATE KEY-----';
    refusedWith(await cli(['run', '--item', '0-1'], { ...env, FACTORY_UNKNOWN: pem }),
      /^dispatcher: FACTORY_UNKNOWN holds a value shaped like a secret/, ['MIIE', 'BEGIN']);
    assert.deepEqual(await readdir(stateDir), []);
  });

test('FACTORY_STATE_DIR open to others is refused, and left as it is', async (t) => {
  const { stateDir, env } = await setUp(t);
  await chmod(stateDir, 0o755);
  refusedWith(await cli(['run', '--item', '0-1'], env),
    /^dispatcher: FACTORY_STATE_DIR has mode 755: it must be 700\n$/, [stateDir]);
  await chmod(stateDir, 0o700);
  assert.deepEqual(await readdir(stateDir), []);
});

test('#0-278 AC7: a FACTORY_REPO_DIR not the dispatcher\'s alone is refused before the lock, and left as it is',
  async (t) => {
    const { stateDir, env, repoParent } = await setUp(t);
    await chmod(repoParent, 0o755);
    refusedWith(await cli(['run', '--item', '0-1'], env), /^dispatcher: FACTORY_REPO_DIR is not the dispatcher's alone: neither it nor its parent directory is owned by this process's user with mode 700/, [env.FACTORY_REPO_DIR]);
    await chmod(repoParent, 0o757);
    refusedWith(await cli(['run', '--item', '0-1'], env),
      /^dispatcher: a directory on the way to FACTORY_REPO_DIR, .*, has mode 757: the group and others may not write one\n$/);
    await chmod(repoParent, 0o700);
    assert.deepEqual(await readdir(stateDir), []);
  });

test('AC2: a second run while one holds the lock is refused; once that run is killed, a run goes ahead',
  async (t) => {
    const { stateDir, env, call } = await setUpDaemon(t);
    const holder = await startUntil(HOLD_LOCK, [stateDir], 'locked');
    try {
      refusedWith(await cli(['run', '--item', '0-1'], env),
        /^dispatcher: another run holds the dispatcher's lock \(.*\): one task at a time in v0\n$/);
      refusedWith(await cli(['sweep', '--force'], env), /^dispatcher: another run holds the dispatcher's lock/);
      assert.deepEqual(await readdir(stateDir), ['lock'], 'the refused run wrote no state');
    } finally {
      await kill(holder);
    }
    assert.equal((await call(['run', '--item', '0-1'])).status, 'running');
  });

/** Refused before any container, task or token: nothing on the daemon, no task, no token left unrevoked. */
async function refusedBeforeTask({ stateDir, fake, call }, args, pattern) {
  await assert.rejects(call(args), (error) => {
    assert.match(error.message, pattern);
    return true;
  });
  assert.ok(!(await readdir(stateDir)).includes('tasks'), 'no task is made');
  assert.deepEqual(fake.calls(), [], 'nothing reached the daemon');
  assert.deepEqual(github.state.revoked, github.state.minted, 'a token minted is revoked');
}

test('review round 1 c: a revoke that fails is one line on stderr naming its kind; the run keeps its result and frees '
  + 'the lock', async (t) => {
  const { env, fake, product, lines } = await setUpDaemon(t);
  github.state.failRevoke = true;
  const errors = [];
  const call = (args) => main(args, { env, out: { write: (line) => lines.push(line) },
    err: { write: (line) => errors.push(line) }, sudo: fake.sudo, apiBase: github.baseUrl, gitBase: gitServer.baseUrl });
  const left = await call(['run', '--item', '0-1']);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(left.baseSha, product.base);
  assert.deepEqual(errors, ['dispatcher: builder-app\'s token could not be revoked (Error); it expires within the hour\n']);
  assert.ok(!errors.join('').includes('Bad Gateway'), 'no text of GitHub\'s answer');
  assert.equal(JSON.parse(lines.at(-1)).runId, left.runId, 'the run printed its task');
  github.state.failRevoke = false;
  assert.equal((await call(['run', '--item', '0-2'])).status, 'running', 'the lock was released');
  assert.equal(errors.length, 1);
});

test('review round 2, 3: a write to stderr that throws, after a revoke that fails, still frees the lock', async (t) => {
  const { env, fake, product, lines } = await setUpDaemon(t);
  github.state.failRevoke = true;
  let writes = 0;
  const broken = { write: () => { writes += 1; throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); } };
  const call = (args, err) => main(args, { env, out: { write: (line) => lines.push(line) }, err, sudo: fake.sudo,
    apiBase: github.baseUrl, gitBase: gitServer.baseUrl });
  const left = await call(['run', '--item', '0-1'], broken);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(left.baseSha, product.base);
  assert.equal(writes, 1, 'the line was tried');
  github.state.failRevoke = false;
  assert.equal((await call(['run', '--item', '0-2'], broken)).status, 'running', 'the lock was released');
});

test('#0-278: an adapter of the base that breaks its schema, or its tree\'s rules, refuses the run before any task',
  async (t) => {
    const broken = { ...ADAPTER };
    delete broken.trustedPaths;
    const schema = await setUpDaemon(t, undefined, { product: { files: { '.factory/adapter.json': JSON.stringify(broken) } } });
    await refusedBeforeTask(schema, ['run', '--item', '0-1'], /^the adapter breaks its schema: \/trustedPaths: missing$/);
    const tree = await setUpDaemon(t, undefined, { product: { links: { 'BACKLOG.md': 'README.md' },
      files: { 'BACKLOG.md': null } } });
    await refusedBeforeTask(tree, ['run', '--item', '0-1'], /^the adapter's queue\.files\[0\] reaches a symlink in the base/);
  });

test('#0-278: a local main with no adapter is refused with the remedy; one GitHub moved to another repository too',
  async (t) => {
    const none = await setUpDaemon(t, undefined, { product: { files: { '.factory/adapter.json': null } } });
    await refusedBeforeTask(none, ['run', '--item', '0-1'], /^FACTORY_REPO_DIR's main holds no \.factory\/adapter\.json: once the product's pull request that adds it is merged, the build VM is provisioned again \(provision\.sh clones main afresh\)$/);
    assert.equal(github.state.minted.length, 0, 'no token before the adapter is read');
    const moved = await setUpDaemon(t);
    await moved.advance({ files: { '.factory/adapter.json': `${JSON.stringify({ ...ADAPTER,
      repository: 'profitbuild/other-product' })}\n` } });
    await refusedBeforeTask(moved, ['run', '--item', '0-1'], /^the adapter of the updated main names another repository/);
  });

test('#0-278 AC9: an item an open pull request holds is refused before any container; a list not read whole too',
  async (t) => {
    const held = await setUpDaemon(t);
    github.state.pulls = [...Array.from({ length: 100 }, (_, i) => `feat/0-${2000 + i}-x`), 'factory/feat/0-278-other'];
    const start = github.requests.length;
    await refusedBeforeTask(held, ['run', '--item', '0-278'], /^the item 0-278 is held by 1 open pull request/);
    assert.deepEqual(pullsAsked(start).map((r) => r.query.get('page')), ['1', '2']);
    const unread = await setUpDaemon(t);
    github.state.pullsPage = () => ({ status: 404, body: { message: 'Not Found' } });
    await refusedBeforeTask(unread, ['run', '--item', '0-278'], /^the open pull requests could not be read whole \(page 1/);
  });

test('#0-278 AC9: the dispatcher\'s own task holds its item while it runs on a branch; a killed run\'s with none does not',
  async (t) => {
    const { stateDir, call } = await setUpDaemon(t);
    const killed = await call(['run', '--item', '0-9']);
    assert.equal(killed.branch, null);
    const next = await call(['run', '--item', '0-9']);
    assert.equal(next.status, 'running', 'a task with no branch does not hold the item (#0-277 AC13)');
    const path = join(stateDir, 'tasks', next.runId, 'task.json');
    await writeJsonAtomic(path, { ...JSON.parse(await readFile(path, 'utf8')), branch: 'factory/0-9-x' });
    const minted = github.state.minted.length;
    await assert.rejects(call(['run', '--item', '0-9']), (error) => error.message === `the item 0-9 is held by the `
      + `dispatcher's own task ${next.runId}, still running on factory/0-9-x: take it up with \`run --resume factory/0-9-x\``);
    assert.equal(github.state.minted.length, minted, 'refused before any token or fetch');
    assert.equal((await call(['run', '--item', '0-10'])).status, 'running', 'another item goes ahead');
  });

test('the breaker tripped refuses the run; state.json unreadable tells the owner what to do', async (t) => {
  const { stateDir, env } = await setUp(t);
  await writeJsonAtomic(join(stateDir, 'state.json'),
    { consecutiveBlocked: 3, shippedSinceAudit: 0, lastAudit: null, history: [] });
  refusedWith(await cli(['run', '--item', '0-1'], env),
    /^dispatcher: the breaker has tripped: 3 tasks blocked in a row, FACTORY_MAX_BLOCKED is 3/);
  await writeFile(join(stateDir, 'state.json'), '{"consecutiveBlocked": ', { mode: 0o600 });
  refusedWith(await cli(['run', '--item', '0-1'], env),
    /cannot be read, so the breaker counts as tripped: repair the file .*, or delete it knowingly/);
  assert.equal(await readFile(join(stateDir, 'state.json'), 'utf8'), '{"consecutiveBlocked": ');
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json'], 'no task is made');
});

test('--resume <branch> takes the running task on it, in a container of the image it recorded, the adapter read from '
  + 'the base it recorded, with no fetch and no lock to check', async (t) => {
  const { stateDir, fake, call, product } = await setUpDaemon(t);
  const first = await call(['run', '--item', '0-9']);
  const path = join(stateDir, 'tasks', first.runId, 'task.json');
  const task = JSON.parse(await readFile(path, 'utf8'));
  await writeJsonAtomic(path, { ...task, branch: 'factory/0-9-resumed' });
  // FACTORY_REPO_DIR's main moves on to an adapter that breaks its schema: the task's base is what it reads.
  const later = await commit(product.work, { files: { '.factory/adapter.json': '{}\n' } });
  git(product.work, ['push', '-q', product.repoDir, `${later}:refs/heads/main`]);
  const start = github.requests.length;
  const resumed = await call(['run', '--resume', 'factory/0-9-resumed']);
  assert.deepEqual(pullsAsked(start), [], 'no lock to check: the task holds its item');
  assert.equal(git(product.repoDir, ['rev-parse', 'refs/heads/main']), later, 'no fetch');
  assert.equal(resumed.runId, first.runId);
  assert.equal(resumed.status, 'running', resumed.reason);
  assert.equal(resumed.imageId, first.imageId);
  const ups = fake.calls().filter((c) => c.program === 'devcontainer');
  assert.equal(ups.length, 2);
  await assert.rejects(call(['run', '--resume', 'factory/none']),
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
  const { stateDir, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'rollback',
    labels: { 'factory.rollback': '1' } })] });
  await assert.rejects(call(['run', '--item', '0-1']),
    /the run is refused: a running container carries factory\.rollback: rollback/);
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json']);
  assert.equal(fake.read().containers.length, 1);
});
