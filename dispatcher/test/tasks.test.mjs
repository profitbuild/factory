// A task's state and the runner of its phases (incident-platform backlog #0-275 AC3, #0-261): a run killed (SIGKILL)
// between two phases resumes at the next one, without running a completed phase again; a run killed inside a phase,
// after its effect and before its write, runs it again and writes byte for byte what a run never killed writes;
// GitHub out of reach (ten transient failures in a row) blocks the task with the reason. The phases are fakes
// (testing/fake-phases.mjs), run in a child process that the test kills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitHubUnavailableError } from '../src/github/retry.mjs';
import { writeJsonAtomic } from '../src/state/files.mjs';
import {
  blockTask, createTask, findTaskByBranch, loadTask, newRunId, runPhases,
} from '../src/state/tasks.mjs';
import { kill, run, startUntil } from '../testing/children.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const FAKE_PHASES = fileURLToPath(new URL('../testing/fake-phases.mjs', import.meta.url));
const RUN_ID = '20261120T101500Z-3f9a1c';
const taskFile = (stateDir) => join(stateDir, 'tasks', RUN_ID, 'task.json');
const lines = async (path) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);

/** A run of the three fake phases never killed: what every interrupted run must end with. */
async function uninterrupted(t) {
  const state = await makeStateDir();
  t.after(state.remove);
  const log = join(state.dir, 'log');
  const { code, stderr } = await run(FAKE_PHASES, [state.dir, RUN_ID, log]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(await lines(log), ['A', 'B', 'C']);
  return readFile(taskFile(state.dir), 'utf8');
}

test('newRunId: the UTC second and six hex digits; createTask writes the task before any phase', async (t) => {
  assert.equal(newRunId({ now: () => Date.parse('2026-11-20T10:15:00.789Z'), random: () => Buffer.from('3f9a1c', 'hex') }),
    RUN_ID);
  assert.match(newRunId(), /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/);
  const state = await makeStateDir();
  t.after(state.remove);
  const task = await createTask(state.dir, { runId: RUN_ID, item: '0-275' });
  assert.deepEqual(task, { version: 1, runId: RUN_ID, item: '0-275', branch: null, baseSha: null, phase: null,
    round: 0, calls: [], status: 'running', reason: null, pr: null });
  assert.deepEqual(await loadTask(state.dir, RUN_ID), task);
  assert.equal((await stat(join(state.dir, 'tasks'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(state.dir, 'tasks', RUN_ID))).mode & 0o777, 0o700);
  assert.equal((await stat(taskFile(state.dir))).mode & 0o777, 0o600);
  await assert.rejects(createTask(state.dir, { runId: RUN_ID }), { code: 'EEXIST' }, 'a run id is used once');
});

test('AC3: a run killed between two phases resumes at the next one, and runs no completed phase again', async (t) => {
  const expected = await uninterrupted(t);
  const state = await makeStateDir();
  t.after(state.remove);
  const log = join(state.dir, 'log');
  await kill(await startUntil(FAKE_PHASES, [state.dir, RUN_ID, log, 'C:start'], 'paused'));
  assert.equal((await loadTask(state.dir, RUN_ID)).phase, 'B', 'killed after B was written');
  assert.deepEqual(await lines(log), ['A', 'B']);

  const { code, stderr } = await run(FAKE_PHASES, [state.dir, RUN_ID, log]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(await lines(log), ['A', 'B', 'C'], 'the restart ran C alone');
  assert.equal(await readFile(taskFile(state.dir), 'utf8'), expected);
});

test('AC3: a run killed inside a phase runs it again, and the phase run twice writes the same state', async (t) => {
  const expected = await uninterrupted(t);
  const state = await makeStateDir();
  t.after(state.remove);
  const log = join(state.dir, 'log');
  await kill(await startUntil(FAKE_PHASES, [state.dir, RUN_ID, log, 'B:effect'], 'paused'));
  assert.equal((await loadTask(state.dir, RUN_ID)).phase, 'A', 'B\'s effect happened, its write did not');
  assert.deepEqual(await lines(log), ['A', 'B']);

  const { code, stderr } = await run(FAKE_PHASES, [state.dir, RUN_ID, log]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(await lines(log), ['A', 'B', 'B', 'C'], 'B ran twice, A once');
  assert.equal(await readFile(taskFile(state.dir), 'utf8'), expected, 'byte for byte the run never killed');
});

test('AC4/#0-261: GitHub out of reach in a phase blocks the task with the reason; no later phase runs', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const ran = [];
  const phases = [
    { name: 'pick', run: async () => { ran.push('pick'); return { branch: 'factory/0-1-x' }; } },
    { name: 'ship', run: async () => { throw new GitHubUnavailableError('GitHub failed 10 times in a row: 503'); } },
    { name: 'after', run: async () => { ran.push('after'); return {}; } },
  ];
  const left = await runPhases(state.dir, await createTask(state.dir, { runId: RUN_ID }), phases);
  assert.deepEqual(ran, ['pick']);
  assert.equal(left.status, 'blocked');
  assert.equal(left.reason, 'ship: GitHub failed 10 times in a row: 503');
  assert.equal(left.phase, 'pick');
  assert.deepEqual(await loadTask(state.dir, RUN_ID), left);
  assert.deepEqual(await runPhases(state.dir, left, phases), left, 'a blocked task runs nothing more');
  assert.deepEqual(ran, ['pick']);
});

test('any other error of a phase is thrown, and the task stays at its last completed phase', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const task = await createTask(state.dir, { runId: RUN_ID });
  await assert.rejects(runPhases(state.dir, task, [{ name: 'p', run: async () => { throw new Error('bug'); } }]),
    /^Error: bug$/);
  assert.deepEqual(await loadTask(state.dir, RUN_ID), task);
});

test('a phase may not set the runner\'s fields, nor leave the task out of its schema', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const task = await createTask(state.dir, { runId: RUN_ID });
  for (const field of ['phase', 'runId', 'version']) {
    await assert.rejects(runPhases(state.dir, task, [{ name: 'p', run: async () => ({ [field]: 'x' }) }]),
      new RegExp(`sets ${field}, which only the runner sets`));
  }
  await assert.rejects(runPhases(state.dir, task, [{ name: 'p', run: async () => ({ round: -1 }) }]),
    /\/round: must be at least 0/);
  await assert.rejects(runPhases(state.dir, task, [{ name: 'p', run: async () => ({ extra: 1 }) }]),
    /\/extra: unknown field/);
  assert.deepEqual(await loadTask(state.dir, RUN_ID), task);
});

test('a task whose completed phase this dispatcher does not have is refused, not run from the start', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const task = { ...await createTask(state.dir, { runId: RUN_ID }), phase: 'gone' };
  await assert.rejects(runPhases(state.dir, task, [{ name: 'p', run: async () => ({}) }]),
    /completed the phase gone, which is not one of this dispatcher's \(p\)/);
});

test('--resume finds the one running task on the branch, and refuses none, two, or an ended one', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  await assert.rejects(findTaskByBranch(state.dir, 'factory/0-1-x'), /no task is on the branch factory\/0-1-x/);
  const a = await createTask(state.dir, { runId: RUN_ID });
  await writeJsonAtomic(taskFile(state.dir), { ...a, branch: 'factory/0-1-x', phase: 'pick' });
  assert.equal((await findTaskByBranch(state.dir, 'factory/0-1-x')).runId, RUN_ID);
  await blockTask(state.dir, await loadTask(state.dir, RUN_ID), 'why');
  await assert.rejects(findTaskByBranch(state.dir, 'factory/0-1-x'), /is blocked: there is nothing to resume/);
  const other = '20261120T101501Z-000000';
  const b = await createTask(state.dir, { runId: other });
  await writeJsonAtomic(join(state.dir, 'tasks', other, 'task.json'), { ...b, branch: 'factory/0-1-x' });
  await assert.rejects(findTaskByBranch(state.dir, 'factory/0-1-x'), /2 tasks are on the branch/);
});

test('a task.json edited out of its schema is refused when it is loaded', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const task = await createTask(state.dir, { runId: RUN_ID });
  await writeJsonAtomic(taskFile(state.dir), { ...task, status: 'done', baseSha: 'short' });
  await assert.rejects(loadTask(state.dir, RUN_ID),
    /is not a task's state: \/baseSha: must match .*; \/status: must be one of "running", "blocked", "stopped", "shipped"/);
});
