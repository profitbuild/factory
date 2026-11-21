// factory's daemon shared with the rollback by time (incident-platform ADR-0062 points 5 and 7; backlog #0-277 AC3,
// AC12, AC13), on the fake daemon: the sweep removes every container, then every user-defined network, then every
// volume but factory-dispatcher-m2, then every work directory, and checks it; a sweep out of that order fails, as
// docker refuses a volume a stopped container uses; a sweep that leaves something refuses the run, naming it and the
// sweep's command; a running factory.rollback container is a refusal, a stopped one is swept; docker's output is held
// to its patterns.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DockerOutputError, RollbackRunningError, SWEEP_COMMAND, SweepError, checkSwept, containers, killTask,
  refuseWhileRollback, removeOwnObjects, sweepDaemon,
} from '../src/container/daemon.mjs';
import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { HELPER_IMAGE, makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);
let n = 0;
const RUN_ID = '20261120T101500Z-3f9a1c';
const OLD_RUN = '20261119T090000Z-0a0b0c';
const ANONYMOUS = 'f'.repeat(64);

/** What a dispatcher killed during the gate leaves, and what a rollback stopped since leaves. */
function leftovers() {
  return {
    containers: [
      plantedContainer({ name: 'task-old', labels: { 'factory.task': OLD_RUN }, volumes: [`factory-task-${OLD_RUN}-claude`,
        'factory-dispatcher-m2'] }),
      plantedContainer({ name: 'testcontainers-postgres', anonymous: [ANONYMOUS] }),
      plantedContainer({ name: 'testcontainers-ryuk' }),
      plantedContainer({ name: 'rollback', labels: { 'factory.rollback': '1' }, running: false,
        volumes: ['incident-platform-gh', 'incident-platform-claude', 'incident-platform-m2'] }),
      plantedContainer({ name: 'compose-db', running: false, volumes: ['compose_data'] }),
    ],
    volumes: [`factory-task-${OLD_RUN}-claude`, 'factory-dispatcher-m2', ANONYMOUS, 'incident-platform-gh',
      'incident-platform-claude', 'incident-platform-m2', 'compose_data'].map((name) => ({ name, labels: {} })),
  };
}

async function setUp(initial = {}) {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir);
  const fake = makeFakeDaemon(dir, initial);
  fake.update((s) => {
    s.networks.push({ id: 'a'.repeat(64), name: `factory-task-${OLD_RUN}`, labels: { 'factory.task': OLD_RUN } },
      { id: 'b'.repeat(64), name: 'compose_default', labels: {} });
  });
  return fake;
}

const commands = (fake) => fake.calls().map((c) => `${c.args[0]} ${c.args[0] === 'run' ? 'helper' : c.args[1]}`);

test('AC13: a killed run\'s leftovers, labelled or not, and a stopped rollback\'s container and credential volumes are '
  + 'swept: containers, then networks, then volumes but factory-dispatcher-m2, then the work directories', async () => {
  const fake = await setUp(leftovers());
  await mkdir(join(fake.tasks, OLD_RUN, 'w', '.git'), { recursive: true });
  await writeFile(join(fake.tasks, OLD_RUN, '.x'), 'x');
  await refuseWhileRollback({ ...fake.runner, when: 'test' });
  const removed = await sweepDaemon({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner });
  assert.deepEqual(removed.containers.sort(), ['compose-db', 'rollback', 'task-old', 'testcontainers-postgres',
    'testcontainers-ryuk']);
  assert.deepEqual(removed.networks.sort(), ['compose_default', `factory-task-${OLD_RUN}`]);
  assert.deepEqual(removed.volumes.sort(), ['compose_data', `factory-task-${OLD_RUN}-claude`,
    'incident-platform-claude', 'incident-platform-gh', 'incident-platform-m2'].sort());
  const state = fake.read();
  assert.deepEqual(state.containers, []);
  assert.deepEqual(state.networks.map((x) => x.name).sort(), ['bridge', 'host', 'none']);
  assert.deepEqual(state.volumes.map((v) => v.name), ['factory-dispatcher-m2'],
    'an anonymous volume goes with its container (rm -v), the rest by name');
  assert.deepEqual(await readdir(fake.tasks), []);
  const order = commands(fake);
  const at = (c) => order.indexOf(c);
  assert.ok(at('rm -f') < at('network rm') && at('network rm') < at('volume rm') && at('volume rm') < at('run helper'),
    `the order: ${order.join(', ')}`);
  assert.deepEqual(order.slice(-3), ['ps -a', 'network ls', 'volume ls'], 'the result is checked after the helper');
});

test('AC13: a running container labelled factory.rollback refuses, naming it and the sweep; a stopped one does not',
  async () => {
    const fake = await setUp({ containers: [plantedContainer({ name: 'rollback-devcontainer',
      labels: { 'factory.rollback': '1' } }), plantedContainer({ name: 'unlabelled' })] });
    await assert.rejects(refuseWhileRollback({ ...fake.runner, when: 'the run is refused' }), (error) => {
      assert.ok(error instanceof RollbackRunningError);
      assert.match(error.message, /^the run is refused: a running container carries factory\.rollback: rollback-devcontainer \([0-9a-f]{12}\)\. If it is a rollback, end it .*; if it is not \(a killed run left it\), clear it with `node --env-file=\/home\/dispatcher\/\.config\/factory\/env \/opt\/factory-checkout\/dispatcher\/src\/cli\.mjs sweep --force`$/);
      return true;
    });
    assert.deepEqual(fake.calls().map((c) => c.args), [['ps', '--no-trunc', '--filter', 'label=factory.rollback',
      '--format', '{{.ID}} {{.Names}}']], 'running ones only, by the label\'s presence');
    fake.update((s) => { s.containers[0].running = false; });
    await refuseWhileRollback({ ...fake.runner, when: 'x' });
    fake.update((s) => { s.containers[0].labels = { 'factory.rollback': '' }; s.containers[0].running = true; });
    await assert.rejects(refuseWhileRollback({ ...fake.runner, when: 'x' }), RollbackRunningError,
      'the label is positive, whatever its value');
  });

test('a sweep out of order fails, since docker refuses a volume a stopped container uses', async () => {
  const fake = await setUp(leftovers());
  // The volumes first, as a wrong order would: docker refuses those still in use, and the check finds them.
  const { mustRun } = await import('../src/container/run-container.mjs');
  await assert.rejects(mustRun({ program: 'docker', ...fake.runner,
    args: ['volume', 'rm', 'incident-platform-gh', 'compose_data'] }),
  /docker volume rm failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in \S+$/);
  assert.ok(fake.read().volumes.some((v) => v.name === 'incident-platform-gh'));
});

test('a sweep that leaves something refuses the run, naming what is left and the sweep\'s command', async () => {
  const fake = await setUp(leftovers());
  fake.update((s) => { s.scenario.ignoreRm = true; });
  await assert.rejects(sweepDaemon({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner }), (error) => {
    assert.ok(error instanceof Error);
    return /^docker volume rm failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in \S+$/
      .test(error.message);
  });
  fake.update((s) => { s.volumes = s.volumes.filter((v) => v.name === 'factory-dispatcher-m2'); s.networks = s.networks
    .filter((x) => ['bridge', 'host', 'none'].includes(x.name)); });
  await assert.rejects(checkSwept({ ...fake.runner }), (error) => {
    assert.ok(error instanceof SweepError);
    // #0-284: by count and the daemon's IDs, never a name.
    assert.match(error.message, /^the sweep left containers \d+ \([0-9a-f]{12}(, [0-9a-f]{12})*\) on factory's daemon: the run is refused until `node --env-file=\/home\/dispatcher\/\.config\/factory\/env \/opt\/factory-checkout\/dispatcher\/src\/cli\.mjs sweep` leaves it empty$/);
    assert.ok(!error.message.includes('task-old') && !error.message.includes('testcontainers'), error.message);
    return true;
  });
  assert.equal(SWEEP_COMMAND,
    'node --env-file=/home/dispatcher/.config/factory/env /opt/factory-checkout/dispatcher/src/cli.mjs sweep');
  const empty = await setUp();
  fake.update(() => {});
  empty.update((s) => { s.networks = s.networks.filter((x) => ['bridge', 'host', 'none'].includes(x.name)); });
  await checkSwept({ ...empty.runner });
  empty.update((s) => { s.volumes.push({ name: 'left', labels: {} }); });
  await assert.rejects(checkSwept({ ...empty.runner }),
    /^Error: the sweep left volumes 1 \(by count: a volume's name is not quoted\) on/);
});

test('removeOwnObjects and killTask touch what carries the run\'s label, and nothing else', async () => {
  const fake = await setUp({
    containers: [plantedContainer({ name: 'mine', labels: { 'factory.task': RUN_ID } }),
      plantedContainer({ name: 'rollback', labels: { 'factory.rollback': '1' }, volumes: ['incident-platform-gh'] })],
    volumes: [{ name: `factory-task-${RUN_ID}-claude`, labels: { 'factory.task': RUN_ID } },
      { name: 'incident-platform-gh', labels: {} }],
  });
  fake.update((s) => { s.networks.push({ id: 'c'.repeat(64), name: `factory-task-${RUN_ID}`,
    labels: { 'factory.task': RUN_ID } }); });
  assert.deepEqual(await killTask({ runId: RUN_ID, ...fake.runner }), ['mine']);
  assert.deepEqual(fake.read().containers.map((c) => [c.name, c.running]), [['mine', false], ['rollback', true]]);
  await removeOwnObjects({ runId: RUN_ID, ...fake.runner });
  const state = fake.read();
  assert.deepEqual(state.containers.map((c) => c.name), ['rollback']);
  assert.deepEqual(state.volumes.map((v) => v.name), ['incident-platform-gh']);
  assert.ok(!state.networks.some((x) => x.name === `factory-task-${RUN_ID}`));
  assert.ok(state.networks.some((x) => x.name === `factory-task-${OLD_RUN}`), 'another run\'s is not this one\'s');
});

test('docker\'s output is untrusted: a line out of its pattern is refused', async () => {
  const { chmod } = await import('node:fs/promises');
  for (const line of ['not-an-id name', `${'a'.repeat(64)} name extra`, `${'a'.repeat(64)} -bad`, `${'a'.repeat(64)}`]) {
    n += 1;
    const sudo = join(root.dir, `liar-${n}`);
    await writeFile(sudo, `#!/bin/sh\nprintf '%s\\n' '${line}'\n`);
    await chmod(sudo, 0o755);
    await assert.rejects(containers({ sudo, stateDir: root.dir }), (error) => error instanceof DockerOutputError);
  }
});

test('#0-284 AC4: the sweep\'s refusals name what is left by count and the daemon\'s IDs, never a name: a container\'s, '
  + 'a network\'s or a volume\'s, which the agent\'s side chooses', async () => {
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'w'.repeat(36)}`;
  const fake = await setUp({
    containers: [plantedContainer({ name: `c-${secret}`, volumes: [`v-${secret}`] })],
    volumes: [{ name: `v-${secret}`, labels: {} }],
  });
  fake.update((s) => {
    s.networks.push({ id: 'e'.repeat(64), name: `n-${secret}`, labels: {} });
    s.scenario.ignoreRm = true;
  });
  const messages = [];
  await assert.rejects(sweepDaemon({ runId: RUN_ID, helperImage: HELPER_IMAGE, ...fake.runner }), (error) => {
    messages.push(error.message);
    return true;
  });
  // The sweep removed the network (only rm is ignored): one left, as a failed `network rm` would leave it.
  fake.update((s) => { s.containers = []; s.networks.push({ id: 'e'.repeat(64), name: `n-${secret}`, labels: {} }); });
  await assert.rejects(checkSwept({ ...fake.runner }), (error) => {
    assert.ok(error instanceof SweepError);
    messages.push(error.message);
    assert.match(error.message, /^the sweep left networks \d+ \([0-9a-f]{12}(, [0-9a-f]{12})*\); volumes 1 \(by count/);
    return true;
  });
  fake.update((s) => { s.containers = [plantedContainer({ name: `c-${secret}` })]; });
  await assert.rejects(checkSwept({ ...fake.runner }), (error) => {
    messages.push(error.message);
    assert.match(error.message, /^the sweep left containers 1 \([0-9a-f]{12}\); networks/);
    return true;
  });
  for (const message of messages) {
    assert.ok(!message.includes('ghs_') && !message.includes(secret), message);
  }
});
