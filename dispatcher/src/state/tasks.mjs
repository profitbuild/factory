/**
 * A task's state, $FACTORY_STATE_DIR/tasks/<runId>/task.json (incident-platform backlog #0-275 AC3, #0-261), and the
 * runner of its phases.
 *
 *   { "version": 1, "runId", "item", "branch", "baseSha", "phase", "round", "calls": [], "status", "reason", "pr",
 *     "imageId" }
 *
 * `imageId` is the task image's ID (sha256:<64 hex>), recorded once `devcontainer up` has built it (incident-platform
 * backlog #0-277 AC5): every container of the task runs from it.
 *
 * `phase` is the last phase completed. runPhases runs the phases after it, one at a time, and writes the task
 * (atomically, files.mjs) after each: a run killed between two phases resumes at the next one; a run killed inside a
 * phase, before its write, runs that phase again. A phase is therefore written to be safe to run twice: its result
 * depends on the task as the phase before left it and on the world, never on whether it ran before, and no field of
 * the task holds a time, so a phase run twice writes the same file.
 *
 * Every read and write of a task's record runs under the state's lock (incident-platform backlog #0-303, lock.mjs's
 * withStateLock), each whole: listTasks and findTaskByBranch read every record under one hold of it. The task's own
 * lock, tasks/<runId>/lock (lock.mjs), and liveTasks, which tries each, are what says a task is live.
 *
 * GitHub out of reach (retry.mjs's GitHubUnavailableError, ten transient failures in a row) blocks the task with the
 * reason; the breaker's count of it is the flow's (4.4's stopItem), as are the phases themselves: v0 has none.
 */
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { GitHubUnavailableError } from '../github/retry.mjs';
import { validate } from '../schema/validate.mjs';
import { ensureOwnDirectory, readJson, StateError, writeJsonAtomic } from './files.mjs';
import { recordOutcomeHeld } from './breaker.mjs';
import { isLive, taskLockPath, withStateLock } from './lock.mjs';
import taskSchema from './task.schema.json' with { type: 'json' };

const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
/** What a phase may not set: the task's identity, and the phase the runner records. */
const RUNNER_FIELDS = ['version', 'runId', 'phase'];

/**
 * A new run's id: the UTC time to the second, then six hex digits of randomness (20261120T101500Z-3f9a1c).
 *
 * @param {{ now?: () => number, random?: (size: number) => Buffer }} [options]
 */
export function newRunId({ now = Date.now, random = randomBytes } = {}) {
  const time = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${time}-${random(3).toString('hex')}`;
}

const tasksDir = (stateDir) => join(stateDir, 'tasks');
const taskPath = (stateDir, runId) => join(tasksDir(stateDir), runId, 'task.json');

function checkTask(task, where) {
  const errors = validate(taskSchema, task);
  if (errors.length > 0) {
    throw new StateError(`${where} is not a task's state: ${errors.join('; ')}`);
  }
  return task;
}

function writeTask(stateDir, task) {
  checkTask(task, `the task ${task.runId}`);
  return withStateLock(stateDir, async () => {
    await writeJsonAtomic(taskPath(stateDir, task.runId), task);
    return task;
  });
}

/**
 * A new task, its directory made once (700) and its task.json written before any phase.
 *
 * @param {string} stateDir
 * @param {{ runId: string, item?: string | null, baseSha?: string | null }} options `baseSha` the base the run read
 *   the adapter from (incident-platform backlog #0-278), recorded before the task container is set up
 */
export async function createTask(stateDir, { runId, item = null, baseSha = null }) {
  if (!RUN_ID.test(runId)) {
    throw new TypeError('createTask: runId is not one of newRunId\'s');
  }
  const task = checkTask({
    version: 1, runId, item, branch: null, baseSha, phase: null, round: 0, calls: [], status: 'running',
    reason: null, pr: null, imageId: null,
  }, `the task ${runId}`);
  return withStateLock(stateDir, async () => {
    await ensureOwnDirectory(tasksDir(stateDir));
    await ensureOwnDirectory(join(tasksDir(stateDir), runId), { exclusive: true });
    await writeJsonAtomic(taskPath(stateDir, runId), task);
    return task;
  });
}

/** The task of `runId`, checked against its schema. */
export function loadTask(stateDir, runId) {
  if (!RUN_ID.test(runId)) {
    throw new TypeError('loadTask: runId is not one of newRunId\'s');
  }
  return withStateLock(stateDir, () => loadUnlocked(stateDir, runId));
}

async function loadUnlocked(stateDir, runId) {
  if (!RUN_ID.test(runId)) {
    throw new TypeError('loadTask: runId is not one of newRunId\'s');
  }
  const path = taskPath(stateDir, runId);
  const task = await readJson(path);
  if (task === undefined) {
    throw new StateError(`no task ${runId}`);
  }
  checkTask(task, path);
  if (task.runId !== runId) {
    throw new StateError(`${path} names the run ${task.runId}`);
  }
  return task;
}

/**
 * Every task of $FACTORY_STATE_DIR/tasks/, by its runId, each checked against its schema.
 *
 * @param {string} stateDir
 * @returns {Promise<object[]>}
 */
export function listTasks(stateDir) {
  return withStateLock(stateDir, () => listUnlocked(stateDir));
}

/** The runIds of $FACTORY_STATE_DIR/tasks/, sorted. */
async function runIds(stateDir) {
  let names;
  try {
    names = await readdir(tasksDir(stateDir));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    names = [];
  }
  return names.filter((name) => RUN_ID.test(name)).sort();
}

async function listUnlocked(stateDir) {
  const tasks = [];
  for (const runId of await runIds(stateDir)) {
    tasks.push(await loadUnlocked(stateDir, runId));
  }
  return tasks;
}

/**
 * The runIds of the live tasks (#0-303): those whose lock a run holds, each tried once (isLive), but `except` (the
 * caller's own, which it holds). A task's directory with no lock file is no live run's. Under the dispatcher's lock
 * only (lock.mjs: isLive's try takes a free lock for an instant).
 *
 * @param {string} stateDir
 * @param {{ except?: string | null }} [options]
 * @returns {Promise<string[]>}
 */
export async function liveTasks(stateDir, { except = null } = {}) {
  const live = [];
  for (const runId of await runIds(stateDir)) {
    if (runId !== except && await isLive(taskLockPath(stateDir, runId))) {
      live.push(runId);
    }
  }
  return live;
}

/**
 * The one running task on `branch`, for `run --resume <branch>`: refused when there is none, or more than one, or
 * when the task on it has ended.
 *
 * @param {string} stateDir
 * @param {string} branch
 */
export async function findTaskByBranch(stateDir, branch) {
  const found = (await listTasks(stateDir)).filter((task) => task.branch === branch);
  if (found.length === 0) {
    throw new StateError(`no task is on the branch ${branch}`);
  }
  if (found.length > 1) {
    throw new StateError(`${found.length} tasks are on the branch ${branch}: ${found.map((t) => t.runId).join(', ')}`);
  }
  const [task] = found;
  if (task.status !== 'running') {
    throw new StateError(`the task ${task.runId} on ${branch} is ${task.status}: there is nothing to resume`);
  }
  return task;
}

/**
 * Writes the task with `changes`, which may not touch what the runner sets (the identity, the phase): the task's
 * container records its base and its image this way (container/environment.mjs).
 */
export async function updateTask(stateDir, task, changes) {
  const set = RUNNER_FIELDS.filter((field) => Object.hasOwn(changes, field));
  if (set.length > 0) {
    throw new TypeError(`updateTask: ${set.join(', ')} are the runner's to set`);
  }
  return writeTask(stateDir, { ...task, ...changes });
}

/**
 * A phase stops the item (incident-platform backlog #0-301, today's autopilot's stopItem): `stage` the phase it stopped
 * in, `reason` the dispatcher's own words (never the agent's), `task` the task as the phase last wrote it.
 */
export class StopError extends Error {
  constructor(stage, reason, task = null) {
    super(`${stage}: ${reason}`);
    this.stage = stage;
    this.reason = reason;
    this.task = task;
  }
}

/**
 * Stops the item (#0-301): the task BLOCKED with "<stage>: <reason>", and the breaker's count of it with its stage,
 * both under one hold of the state's lock.
 */
export function stopItem(stateDir, task, { stage, reason }) {
  const stopped = checkTask({ ...task, status: 'blocked', reason: `${stage}: ${reason}` }, `the task ${task.runId}`);
  return withStateLock(stateDir, async () => {
    await writeJsonAtomic(taskPath(stateDir, task.runId), stopped);
    await recordOutcomeHeld(stateDir, { outcome: 'blocked', item: task.item ?? '', stage });
    return stopped;
  });
}

/** Ends the task as BLOCKED, with the reason. */
export async function blockTask(stateDir, task, reason) {
  return writeTask(stateDir, { ...task, status: 'blocked', reason });
}

/**
 * Runs the phases after `task.phase`, in order, writing the task after each; a task that is not running is returned
 * as it is.
 *
 * @param {string} stateDir
 * @param {object} task
 * @param {{ name: string, run: (task: object) => Promise<object> }[]} phases `run` returns the fields it changes
 * @returns {Promise<object>} the task after the last phase run
 */
export async function runPhases(stateDir, task, phases) {
  const names = phases.map((phase) => phase.name);
  if (new Set(names).size !== names.length) {
    throw new TypeError('runPhases: two phases have the same name');
  }
  let start = 0;
  if (task.phase !== null) {
    const done = names.indexOf(task.phase);
    if (done < 0) {
      throw new StateError(`the task ${task.runId} completed the phase ${task.phase}, which is not one of `
        + `this dispatcher's (${names.join(', ') || 'none'})`);
    }
    start = done + 1;
  }
  let current = task;
  for (const phase of phases.slice(start)) {
    if (current.status !== 'running') {
      break;
    }
    let changes;
    try {
      changes = await phase.run(current);
    } catch (error) {
      if (error instanceof GitHubUnavailableError) {
        // Through stopItem, so that the breaker counts it (review round 1 of factory#26, arc-5c1e).
        return stopItem(stateDir, current, { stage: phase.name, reason: error.message });
      }
      if (error instanceof StopError) {
        return stopItem(stateDir, error.task ?? current, { stage: error.stage, reason: error.reason });
      }
      throw error;
    }
    const set = RUNNER_FIELDS.filter((field) => Object.hasOwn(changes ?? {}, field));
    if (set.length > 0) {
      throw new TypeError(`the phase ${phase.name} sets ${set.join(', ')}, which only the runner sets`);
    }
    current = await writeTask(stateDir, { ...current, ...changes, phase: phase.name });
  }
  return current;
}
