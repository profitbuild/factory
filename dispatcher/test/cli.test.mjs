// `node dispatcher/src/cli.mjs` end to end, in a child process with the environment it is given (incident-platform
// backlog #0-275): every refusal is a line on stderr and the exit code 1, naming the variable and never its value
// (AC1, AC7); a second run waits for the dispatcher's lock another run holds, and is refused past its wait, and a
// killed run's lock is free again (AC2; #0-303); the
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
import { openBreaker } from '../src/state/breaker.mjs';
import { writeJsonAtomic } from '../src/state/files.mjs';
import { ADAPTER, commit, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { APP_ID, INSTALLATION_ID, startBuilderGitHub, writeAppFiles } from '../testing/builder-github.mjs';
import { kill, run, startUntil } from '../testing/children.mjs';
import { acquireLock, acquireTaskLock } from '../src/state/lock.mjs';
import { createTask } from '../src/state/tasks.mjs';
import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { git } from '../testing/git-fixtures.mjs';
import { startGitFetchServer } from '../testing/git-fetch-server.mjs';
import { makeStateDir, validEnv } from '../testing/state-dir.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const LOCK_MODULE = new URL('../src/state/lock.mjs', import.meta.url).href;

/** A process that takes the lock file it is given and holds it until it is killed (#0-303), in the test's directory. */
async function holderScript(dir) {
  const path = join(dir, 'holder.mjs');
  await writeFile(path, `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
await acquireLock(process.argv[2]);
process.stdout.write('locked\\n');
setInterval(() => {}, 60_000);
`);
  return path;
}

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
  // No phase unless a test gives some (#0-301: the build zone's phases are flow-phases.test.mjs's, with a fake agent).
  const call = (args, extra = {}) => main(args, { env, out: { write: (line) => lines.push(line) }, ...fake.runner,
    apiBase: github.baseUrl, gitBase: gitServer.baseUrl, phases: [], ...extra });
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
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json', 'state.lock', 'tasks']);
  assert.deepEqual(await readdir(join(stateDir, 'tasks')), [printed.runId]);
  const task = JSON.parse(await readFile(join(stateDir, 'tasks', printed.runId, 'task.json'), 'utf8'));
  assert.equal(task.item, '0-275');
  const again = await call(['run', '--item', '0-276']);
  assert.equal(again.item, '0-276', 'the lock was released');
});

test('the command line is checked before anything else', async (t) => {
  const { stateDir, env } = await setUp(t);
  const usage = /^dispatcher: .*usage: cli\.mjs run --item 0-N \| cli\.mjs run --resume <branch> \[--findings <file>\] \| cli\.mjs sweep \[--force\]\n$/;
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

test('AC2, #0-303: a run waits for the dispatcher\'s lock another process holds, and is refused past its wait; once '
  + 'that run is killed, a run goes ahead', async (t) => {
  const { stateDir, call } = await setUpDaemon(t);
  const holder = await startUntil(await holderScript(stateDir), [join(stateDir, 'lock')], 'locked');
  try {
    for (const args of [['run', '--item', '0-1'], ['sweep', '--force']]) {
      await assert.rejects(call(args, { dispatcherWaitS: 1 }),
        /^Error: another run has held the dispatcher's lock \(.*\/lock\) for 1 s: refused, not waited for any longer$/);
    }
    assert.deepEqual((await readdir(stateDir)).sort(), ['holder.mjs', 'lock'], 'the refused runs wrote no state');
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
  const call = (args) => main(args, { env, out: { write: (line) => lines.push(line) }, phases: [],
    err: { write: (line) => errors.push(line) }, ...fake.runner, apiBase: github.baseUrl, gitBase: gitServer.baseUrl });
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
  const call = (args, err) => main(args, { env, out: { write: (line) => lines.push(line) }, err, phases: [], ...fake.runner,
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
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json', 'state.lock'], 'no task is made');
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
  // #0-284: one build, the new task's; both runs up from the image's ID.
  const devcontainer = fake.calls().filter((c) => c.program === 'devcontainer').map((c) => c.args[0]);
  assert.deepEqual(devcontainer, ['build', 'up', 'up']);
  await assert.rejects(call(['run', '--resume', 'factory/none']),
    /no task is on the branch factory\/none/);
});

test('#0-277: sweep removes a killed run\'s leftovers; it refuses while a rollback runs, naming it, and --force sweeps '
  + 'that too', async (t) => {
  const rollback = plantedContainer({ name: 'planted-rollback', labels: { 'factory.rollback': '1' } });
  const leftover = plantedContainer({ name: 'leftover' });
  const { call, lines, fake } = await setUpDaemon(t, { containers: [rollback, leftover],
    volumes: [{ name: 'incident-platform-gh', labels: {} }] });
  await assert.rejects(call(['sweep']), (error) => {
    assert.match(error.message, /^the sweep is refused: a running container carries factory\.rollback: planted-rollback \(/);
    assert.match(error.message, /clear it with `node --env-file=\/home\/dispatcher\/\.config\/factory\/env \/opt\/factory-checkout\/dispatcher\/src\/cli\.mjs sweep --force`$/);
    return true;
  });
  assert.equal(fake.read().containers.length, 2, 'nothing removed');
  const removed = await call(['sweep', '--force']);
  assert.deepEqual(JSON.parse(lines.at(-1)), { swept: removed });
  // #0-284 (review round 1 of factory#22): the daemon's IDs, short, and a count of volumes; never a name.
  assert.deepEqual([...removed.containers].sort(), [rollback.id.slice(0, 12), leftover.id.slice(0, 12)].sort());
  assert.equal(removed.volumes, 1);
  assert.deepEqual(fake.read().containers, []);
  assert.deepEqual((await call(['sweep'])).containers, [], 'an empty daemon sweeps to nothing');
});

test('#0-277: a run refused by a running rollback makes no task and removes nothing', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'rollback',
    labels: { 'factory.rollback': '1' } })] });
  await assert.rejects(call(['run', '--item', '0-1']),
    /the run is refused: a running container carries factory\.rollback: rollback/);
  // #0-303 (review round 1 of factory#25, decision 2): the task is made only once every refusal of the slot is past.
  assert.deepEqual((await readdir(stateDir)).sort(), ['lock', 'state.json', 'state.lock']);
  assert.equal(fake.read().containers.length, 1);
});

test('#0-284, review round 1 of factory#22: sweep prints the daemon\'s IDs of the containers and networks it removed and '
  + 'how many volumes, never a name', async (t) => {
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'n'.repeat(36)}`;
  const container = plantedContainer({ name: `c-${secret}`, running: false, volumes: [`v-${secret}`] });
  const { call, lines, fake } = await setUpDaemon(t, { containers: [container],
    volumes: [{ name: `v-${secret}`, labels: {} }, { name: 'factory-dispatcher-m2', labels: {} }] });
  const network = { id: '9'.repeat(64), name: `n-${secret}`, labels: {} };
  fake.update((s) => { s.networks.push(network); });
  // A volume is removed by its name, the one docker gives it, and the starter refuses an argument shaped like a
  // secret (sudo logs them): the sweep is refused, naming the argument's position, never the name.
  await assert.rejects(call(['sweep']), (error) => {
    assert.match(error.message, /^docker volume rm: argument \d+ holds a value shaped like a secret/);
    assert.ok(!error.message.includes('ghs_'), error.message);
    return true;
  });
  // The container and the network were removed by their IDs; a volume of an ordinary name is counted.
  fake.update((s) => {
    s.volumes = s.volumes.filter((v) => !v.name.includes(secret));
    s.containers.push(container);
    s.networks.push(network);
    s.volumes.push({ name: 'left-by-a-test', labels: {} });
  });
  const removed = await call(['sweep']);
  assert.deepEqual(removed, { containers: [container.id.slice(0, 12)], networks: [network.id.slice(0, 12)], volumes: 1 });
  assert.ok(!lines.join('').includes('ghs_'), lines.join(''));
});

test('#0-284, review round 1 of factory#22 (decision 1): sweep and run on a daemon off the VM\'s options are refused '
  + 'before any container, the sweep\'s helper included', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'leftover' })] });
  fake.update((s) => { s.scenario.info = { SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'] }; });
  for (const args of [['sweep'], ['sweep', '--force'], ['run', '--item', '0-1']]) {
    await assert.rejects(call(args), /^Error: factory's daemon's security options are not the VM's .*missing name=rootless.*: no container is made on it$/);
  }
  assert.ok(!fake.calls().some((c) => c.program === 'devcontainer' || c.args[0] === 'run'),
    'no helper, no container of a task');
  assert.deepEqual(fake.read().containers.map((c) => c.name), ['leftover'], 'nothing swept');
  assert.ok(!(await readdir(stateDir)).includes('tasks'), 'no task made');
});

// incident-platform backlog #0-303: a lock per task, the dispatcher's only for a slot and the sweeps.

const OTHER_RUN = '20261122T090000Z-0b0303';

/** A live task of another run's: its record, and its lock held by this process until `release`. */
async function liveOtherTask(stateDir, runId = OTHER_RUN) {
  await createTask(stateDir, { runId, item: '0-8' });
  return acquireTaskLock(stateDir, runId);
}

const gate = () => {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, opened };
};

test('#0-303 AC1: a run whose FACTORY_SLOTS every live task takes is refused before it touches the daemon', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'leftover' })] });
  const other = await liveOtherTask(stateDir);
  try {
    await assert.rejects(call(['run', '--item', '0-1']), (error) => {
      assert.equal(error.message, `every slot is taken: 1 task is live (${OTHER_RUN}), FACTORY_SLOTS is 1: the run is `
        + 'refused');
      return true;
    });
    assert.deepEqual(fake.calls(), [], 'nothing reached the daemon');
    assert.deepEqual(await readdir(join(stateDir, 'tasks')), [OTHER_RUN], 'the refused run made no task');
  } finally {
    other.release();
  }
  assert.equal((await call(['run', '--item', '0-1'])).status, 'running', 'the other task dead, the slot is free');
});

test('#0-303 AC3: with another task live, a run sweeps only its own labelled objects, at its start and its end; with '
  + 'none, the whole daemon', async (t) => {
  const { stateDir, env, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'leftover' })] });
  const other = await liveOtherTask(stateDir);
  let left;
  try {
    left = await call(['run', '--item', '0-1'], { env: { ...env, FACTORY_SLOTS: '2' } });
    assert.equal(left.status, 'running', left.reason);
    assert.deepEqual(fake.read().containers.map((c) => c.name), ['leftover'], 'the other task\'s daemon is not swept');
    // Its own objects listed by their label once before its container starts (the sweep at the start) and once after
    // its container's last call (the sweep at its end), and only then.
    const calls = fake.calls();
    const own = calls.map((c, i) => (c.args[0] === 'ps' && c.args.includes(`label=factory.task=${left.runId}`) ? i : -1))
      .filter((i) => i >= 0);
    const up = calls.findIndex((c) => c.program === 'devcontainer' && c.args[0] === 'up');
    const lastExec = calls.map((c) => c.args[0]).lastIndexOf('exec');
    assert.equal(own.length, 2, `two lists of its own containers: ${own}`);
    assert.ok(own[0] < up && own[1] > lastExec, `one before up (${up}), one after the last exec (${lastExec}): ${own}`);
    assert.ok(!fake.calls().some((c) => c.args[0] === 'run' && c.args.join(' ').includes('find "$1" -mindepth 1')),
      'no sweep of every work directory');
  } finally {
    other.release();
  }
  await call(['run', '--item', '0-2']);
  assert.deepEqual(fake.read().containers, [], 'no other task live: the whole daemon swept');
});

test('#0-303 AC3: sweep and sweep --force are refused while a task is live, naming it', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t, { containers: [plantedContainer({ name: 'leftover' })] });
  const other = await liveOtherTask(stateDir);
  try {
    for (const args of [['sweep'], ['sweep', '--force']]) {
      await assert.rejects(call(args), (error) => {
        assert.equal(error.message, `the sweep is refused: the task ${OTHER_RUN} is live (its lock held by a run); a `
          + 'live task is no killed run\'s, and --force does not pass this');
        return true;
      });
    }
    assert.deepEqual(fake.calls(), [], 'nothing reached the daemon');
  } finally {
    other.release();
  }
  assert.deepEqual((await call(['sweep'])).containers.length, 1, 'no task live: the sweep goes ahead');
});

test('#0-303: a second run of an item whose first run is live, on its branch, is refused: the item is held',
  async (t) => {
    const { call, fake } = await setUpDaemon(t);
    const hold = gate();
    const inPhase = gate();
    const phases = [
      { name: 'branch', run: async () => ({ branch: 'factory/0-9-held' }) },
      { name: 'hold', run: async () => { inPhase.open(); await hold.opened; return {}; } },
    ];
    const first = call(['run', '--item', '0-9'], { phases });
    await inPhase.opened;
    const before = fake.calls().length;
    try {
      await assert.rejects(call(['run', '--item', '0-9'], { phases }), (error) => {
        assert.match(error.message, /^the item 0-9 is held by the dispatcher's own task \d{8}T\d{6}Z-[0-9a-f]{6}, still running on factory\/0-9-held: take it up with `run --resume factory\/0-9-held`$/);
        return true;
      });
      assert.equal(fake.calls().length, before, 'the second run touched no daemon');
    } finally {
      hold.open();
    }
    assert.equal((await first).phase, 'hold');
  });

test('#0-303: a second run\'s fetch of main does not start while the first is in its slot section', async (t) => {
  const { call, advance } = await setUpDaemon(t);
  await advance();
  const leaveSlot = gate();
  const secondWaits = gate();
  const hold = gate();
  const inPhase = gate();
  let second;
  let fetchesInSlot;
  let fetchesAsTheFirstLeaves;
  const first = call(['run', '--item', '0-1'], {
    hooks: { inSlot: async () => {
      fetchesInSlot = gitServer.authorizations.length;
      // The second run, started now, is about to ask for the dispatcher's lock when its hook fires; the first holds
      // that lock until it leaves this hook and its slot section, so the count as it leaves is the second's proof.
      second = call(['run', '--item', '0-2'], { hooks: { beforeDispatcherLock: async () => { secondWaits.open(); } } })
        .then(() => null, (error) => error);
      await secondWaits.opened;
      await leaveSlot.opened;
      fetchesAsTheFirstLeaves = gitServer.authorizations.length;
    } },
    phases: [{ name: 'hold', run: async () => { inPhase.open(); await hold.opened; return {}; } }],
  });
  await secondWaits.opened;
  leaveSlot.open();
  await inPhase.opened;
  const refused = await second;
  assert.ok(fetchesInSlot > 0, 'the first run fetched main in its slot section');
  assert.equal(fetchesAsTheFirstLeaves, fetchesInSlot, 'no fetch of the second run while the first is in its slot');
  assert.ok(gitServer.authorizations.length > fetchesInSlot, 'the second run fetched once the first left its slot');
  assert.match(refused?.message ?? '', /^every slot is taken: 1 task is live \(.*\), FACTORY_SLOTS is 1: the run is refused$/,
    'and then found the slot taken, the first task live');
  hold.open();
  assert.equal((await first).phase, 'hold');
});

test('#0-303, review round 1 of factory#25 (decision 1): with two slots, a second run of an item whose first run is '
  + 'live with no branch yet is refused: the item is held', async (t) => {
  const { env, call, fake } = await setUpDaemon(t);
  const slots = { env: { ...env, FACTORY_SLOTS: '2' } };
  const hold = gate();
  const inPhase = gate();
  const first = call(['run', '--item', '0-9'], { ...slots,
    phases: [{ name: 'hold', run: async () => { inPhase.open(); await hold.opened; return {}; } }] });
  await inPhase.opened;
  const before = fake.calls().length;
  try {
    await assert.rejects(call(['run', '--item', '0-9'], slots), (error) => {
      assert.match(error.message, /^the item 0-9 is held by the dispatcher's own task \d{8}T\d{6}Z-[0-9a-f]{6}, live and still running with no branch yet: the run is refused until that task's run ends$/);
      return true;
    });
    assert.equal(fake.calls().length, before, 'the second run touched no daemon');
  } finally {
    hold.open();
  }
  const done = await first;
  assert.equal(done.branch, null);
  assert.equal((await call(['run', '--item', '0-9'], slots)).status, 'running',
    'its run ended, the task is not live, and with no branch it holds the item no longer (#0-277 AC13)');
});

test('#0-303, review round 1 of factory#25 (decision 2): --resume of a task whose lock another run holds is refused, '
  + 'its record as it was', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t);
  const first = await call(['run', '--item', '0-9']);
  const path = join(stateDir, 'tasks', first.runId, 'task.json');
  await writeJsonAtomic(path, { ...JSON.parse(await readFile(path, 'utf8')), branch: 'factory/0-9-live' });
  const record = await readFile(path, 'utf8');
  const held = await acquireTaskLock(stateDir, first.runId);
  const before = fake.calls().length;
  try {
    await assert.rejects(call(['run', '--resume', 'factory/0-9-live']), (error) => {
      assert.match(error.message, new RegExp(`^the task ${first.runId} is live: another run holds its lock \\(`));
      return true;
    });
  } finally {
    held.release();
  }
  assert.equal(await readFile(path, 'utf8'), record, 'the record unchanged');
  assert.ok(!fake.calls().slice(before).some((c) => c.args[0] === 'rm' || c.args[0] === 'run'
    || c.program === 'devcontainer'), 'no sweep, no container');
});

test('#0-303, review round 1 of factory#25 (security 1): a run that cannot take the dispatcher\'s lock at its end '
  + 'removes its own objects under its task\'s lock, and is refused with the lock\'s reason', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t);
  let other;
  const phases = [{ name: 'grab', run: async () => {
    // Another run's slot section, as far as this run can tell: the dispatcher's lock taken while it works.
    other = await acquireLock(join(stateDir, 'lock'));
    return {};
  } }];
  let runId;
  try {
    await assert.rejects(call(['run', '--item', '0-1'], { phases, dispatcherWaitS: 1 }), (error) => {
      assert.match(error.message, /^another run has held the dispatcher's lock \(.*\/lock\) for 1 s: refused, not waited for any longer$/);
      return true;
    });
    [runId] = await readdir(join(stateDir, 'tasks'));
    const state = fake.read();
    const mine = (labels) => labels?.['factory.task'] === runId;
    assert.deepEqual(state.containers.filter((c) => mine(c.labels)), [], 'no container of the run left');
    assert.deepEqual(state.networks.filter((n) => mine(n.labels)), [], 'no network of the run left');
    assert.deepEqual(state.volumes.filter((v) => mine(v.labels)), [], 'no volume of the run left');
  } finally {
    other?.release();
  }
  assert.ok(runId, 'the run made its task');
});

test('#0-303, review round 2 of factory#25, 3: a new task whose lock cannot be taken right after its record ends '
  + 'BLOCKED with a fixed reason, the details in the refusal', async (t) => {
  const { stateDir, call, fake } = await setUpDaemon(t);
  let held;
  try {
    await assert.rejects(call(['run', '--item', '0-1'], { hooks: { taskMade: async (runId) => {
      held = await acquireTaskLock(stateDir, runId);
    } } }), (error) => {
      assert.match(error.message, /^the task \d{8}T\d{6}Z-[0-9a-f]{6} is live: another run holds its lock \(/);
      return true;
    });
  } finally {
    held?.release();
  }
  const [runId] = await readdir(join(stateDir, 'tasks'));
  const task = JSON.parse(await readFile(join(stateDir, 'tasks', runId, 'task.json'), 'utf8'));
  assert.equal(task.status, 'blocked');
  assert.equal(task.reason, 'refused before its container: its task lock could not be taken');
  assert.ok(!fake.calls().some((c) => c.args[0] === 'rm' || c.args[0] === 'run' || c.program === 'devcontainer'),
    'no sweep, no container');
});

// incident-platform backlog #0-301 (M2.3): whole runs of the build zone, a fake agent (the fake daemon's Claude Code,
// testing/stream-json.mjs), the product's gate and changedPaths reading what the "agent" wrote in the clone.

const GATE = (status, artifact = null) => JSON.stringify({ status, exitCode: status === 'pass' ? 0 : 1, modules: 'm',
  log: '', head: '', artifact, summary: ['agent-words of the build'] });
const FLOW_FILES = {
  'BACKLOG.md': '# Backlog\n\n## Open\n\n### 0-9. A medium thing\n**Autopilot:** yes · **Risk:** low · '
    + '**Complexity:** medium · **Depends on:** none\n\nAC1. It works.\n\n### 0-7. A small thing\n**Autopilot:** yes · '
    + '**Complexity:** low\n\n**Acceptance criteria.**\nAC1. It is small.\n\n### 0-5. No complexity\n\nAC1. x\n',
  'scripts/factory/run-tests.sh': `#!/bin/sh\nif [ -f .gate ]; then cat .gate; else printf '%s\\n' '${GATE('fixable')}'; fi\n`,
  'scripts/factory/changed-paths.sh': '#!/bin/sh\nif [ -f .path-refused ]; then exit 3; fi\necho advisory\n',
};

/** A run of the build zone on `item`, the fake agent answering with `calls` in order. */
async function flowRun(t, item, calls, { args = ['run', '--item', item] } = {}) {
  const setup = await setUpDaemon(t, undefined, { product: { files: FLOW_FILES } });
  setup.fake.update((s) => { s.scenario.claude = calls; });
  const left = await setup.call(args, { phases: undefined });
  return { ...setup, left };
}

const answers = async () => (await import('../testing/stream-json.mjs'));

test('#0-301 AC2: a whole run plans, implements, passes the path gate and the test gate, with every call recorded and '
  + 'the commit message kept for #0-302', async (t) => {
  const { stream, ARCHITECT_ANSWER, IMPLEMENTER_ANSWER } = await answers();
  const { left, fake, stateDir } = await flowRun(t, '0-9', [
    { stream: stream('architect', ARCHITECT_ANSWER) },
    { stream: stream('implementer', IMPLEMENTER_ANSWER), files: { '.gate': GATE('pass', 'app.jar') } },
  ]);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(left.phase, 'test-gate');
  const task = JSON.parse(await readFile(join(stateDir, 'tasks', left.runId, 'task.json'), 'utf8'));
  assert.deepEqual(task.calls.map((c) => [c.n, c.agent, c.mode, c.outcome]), [[1, 'architect', 'plan', 'answered'],
    [2, 'implementer', 'implement', 'answered']]);
  assert.equal(task.calls[1].agentText.commitMessage, IMPLEMENTER_ANSWER.commitMessage);
  assert.deepEqual(fake.claudeCalls().map((c) => c.argv[c.argv.indexOf('--agent') + 1]),
    ['factory:architect', 'factory:implementer']);
  assert.match(fake.claudeCalls()[0].stdin, /^Mode: plan\. The item: 0-9, in BACKLOG\.md /);
  assert.match(fake.claudeCalls()[1].stdin, /^Mode: implement\./);
});

test('#0-301 AC2: an item rated Complexity low is implemented by implementer-light', async (t) => {
  const { stream, ARCHITECT_ANSWER, IMPLEMENTER_ANSWER } = await answers();
  const { left, fake } = await flowRun(t, '0-7', [
    { stream: stream('architect', ARCHITECT_ANSWER) },
    { stream: stream('implementer-light', IMPLEMENTER_ANSWER), files: { '.gate': GATE('pass', 'app.jar') } },
  ]);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(fake.claudeCalls()[1].argv[fake.claudeCalls()[1].argv.indexOf('--agent') + 1],
    'factory:implementer-light');
});

test('#0-301 AC2, AC3: every stop of the build zone ends the task BLOCKED through stopItem, with its stage in the '
  + 'reason and in the breaker, quoting nothing of the agent', async (t) => {
  const { stream, ARCHITECT_ANSWER, IMPLEMENTER_ANSWER } = await answers();
  const ok = (agent, answer, files) => ({ stream: stream(agent, answer), ...(files ? { files } : {}) });
  const blocked = (agent, answer) => ok(agent, { ...answer, blocked: true, reason: 'agent-words of the agent' });
  const cases = [
    ['0-9', [blocked('architect', ARCHITECT_ANSWER)], 'plan', /^plan: the architect answered blocked \(its answer: .*\/calls\/1-architect\.answer\.json\)$/],
    ['0-9', [ok('architect', ARCHITECT_ANSWER), blocked('implementer', IMPLEMENTER_ANSWER)], 'implement',
      /^implement: the implementer answered blocked \(its answer: .*2-implementer\.answer\.json\)$/],
    ['0-9', [{ stream: stream('architect', ARCHITECT_ANSWER, { init: { model: 'claude-sonnet-5-5' } }) }], 'plan',
      /^plan: the call's init event is not the one expected: model \(/],
    ['0-9', [ok('architect', ARCHITECT_ANSWER), ok('implementer', IMPLEMENTER_ANSWER, { '.path-refused': '1' })],
      'path-gate', /^path-gate: the adapter's changedPaths refused the task's changes \(exit 3\)$/],
    ['0-9', [ok('architect', ARCHITECT_ANSWER), ok('implementer', IMPLEMENTER_ANSWER, { '.gate': GATE('stop') })],
      'test-gate', /^test-gate: the gate stopped: the environment failed, a human looks$/],
    ['0-9', [ok('architect', ARCHITECT_ANSWER), ok('implementer', IMPLEMENTER_ANSWER, { '.gate': GATE('pass') })],
      'test-gate', /^test-gate: the gate passed with no artifact$/],
    ['0-9', [ok('architect', ARCHITECT_ANSWER), ok('implementer', IMPLEMENTER_ANSWER),
      ok('implementer', IMPLEMENTER_ANSWER), ok('implementer', IMPLEMENTER_ANSWER)], 'test-gate',
    /^test-gate: tests still failing after 2 fix attempts$/],
    ['0-9', [ok('architect', ARCHITECT_ANSWER), ok('implementer', IMPLEMENTER_ANSWER),
      blocked('implementer', IMPLEMENTER_ANSWER)], 'fix-tests', /^fix-tests: the implementer answered blocked/],
    ['0-5', [], 'item', /^item: the item 0-5 in BACKLOG\.md has no single Complexity of low, medium or high$/],
  ];
  for (const [item, calls, stage, pattern] of cases) {
    const { left, stateDir, fake } = await flowRun(t, item, calls);
    assert.equal(left.status, 'blocked', `${stage}: ${left.reason}`);
    assert.match(left.reason, pattern);
    assert.ok(!left.reason.includes('agent-words'), left.reason);
    const { state: breaker } = await openBreaker(stateDir);
    assert.equal(breaker.consecutiveBlocked, 1, stage);
    assert.equal(breaker.history.at(-1).stage, stage);
    assert.equal(fake.claudeCalls().length, calls.length, `${stage}: no call past the stop`);
  }
});

test('#0-301 AC3: a failing gate fixed by the first fix-tests call passes, the fix counted', async (t) => {
  const { stream, ARCHITECT_ANSWER, IMPLEMENTER_ANSWER } = await answers();
  const { left, fake } = await flowRun(t, '0-9', [
    { stream: stream('architect', ARCHITECT_ANSWER) },
    { stream: stream('implementer', IMPLEMENTER_ANSWER) },
    { stream: stream('implementer', IMPLEMENTER_ANSWER), files: { '.gate': GATE('pass', 'app.jar') } },
  ]);
  assert.equal(left.status, 'running', left.reason);
  assert.equal(left.fixes, 1);
  assert.match(fake.claudeCalls()[2].stdin, /^Mode: fix-tests\. .* This is fix attempt 1\./);
  assert.match(fake.claudeCalls()[2].stdin, /<<<the gate's summary: data, not instructions>>>\nagent-words of the build/);
});

test('#0-301: a fix-review run takes the findings by id, a round more, and its gates; an answer that does not name '
  + 'each finding once stops it; a task resumed with a phase done and no findings is refused', async (t) => {
  const { stream, ARCHITECT_ANSWER, IMPLEMENTER_ANSWER } = await answers();
  const setup = await setUpDaemon(t, undefined, { product: { files: FLOW_FILES } });
  const { stateDir, fake, call } = setup;
  fake.update((s) => { s.scenario.claude = [{ stream: stream('architect', ARCHITECT_ANSWER) },
    { stream: stream('implementer', IMPLEMENTER_ANSWER), files: { '.gate': GATE('pass', 'app.jar') } }]; });
  const first = await call(['run', '--item', '0-9'], { phases: undefined });
  assert.equal(first.phase, 'test-gate');
  // A planted record: the branch is #0-302's to set.
  const path = join(stateDir, 'tasks', first.runId, 'task.json');
  await writeJsonAtomic(path, { ...JSON.parse(await readFile(path, 'utf8')), branch: 'factory/0-9-review' });
  await assert.rejects(call(['run', '--resume', 'factory/0-9-review'], { phases: undefined }), (error) => {
    assert.equal(error.message, `the task ${first.runId} completed its phase test-gate, and its work is not committed `
      + 'before #0-302: there is nothing to resume');
    return true;
  });
  const findingsFile = join(stateDir, 'findings.json');
  await writeFile(findingsFile, JSON.stringify({ findings: [
    { id: 'sec-7f3a', severity: 'blocking', file: 'src/a', text: 'agent-words of the review' },
    { id: 'ver-0123abcd', severity: 'blocking', file: 'src/b', text: 'a refuted claim' }] }), { mode: 0o600 });
  const review = (fixed, disputed) => ({ stream: stream('implementer', { ...IMPLEMENTER_ANSWER, fixed, disputed }),
    files: { '.gate': GATE('pass', 'app.jar') } });
  fake.update((s) => { s.scenario.claude = [review(['sec-7f3a'], [{ id: 'ver-0123abcd', reason: 'x' }])]; });
  const reviewed = await call(['run', '--resume', 'factory/0-9-review', '--findings', findingsFile],
    { phases: undefined });
  assert.equal(reviewed.status, 'running', reviewed.reason);
  assert.equal(reviewed.round, 1);
  assert.equal(reviewed.phase, 'test-gate');
  const prompt = fake.claudeCalls().at(-1).stdin;
  assert.match(prompt, /^Mode: fix-review\./);
  assert.match(prompt, /- sec-7f3a \(src\/a\): agent-words of the review/);
  fake.update((s) => { s.scenario.claude = [review(['sec-7f3a'], [])]; });
  const stopped = await call(['run', '--resume', 'factory/0-9-review', '--findings', findingsFile],
    { phases: undefined });
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.reason, 'fix-review: the answer names 1 finding(s) in neither fixed nor disputed, 0 id(s) it '
    + 'was not given, and 0 twice');
  assert.equal(stopped.round, 2);
});
