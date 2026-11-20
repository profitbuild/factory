/**
 * A task's state, $FACTORY_STATE_DIR/tasks/<runId>/task.json (incident-platform backlog #0-275 AC3, #0-261), and the
 * runner of its phases.
 *
 *   { "version": 1, "runId", "item", "branch", "baseSha", "phase", "round", "calls": [], "status", "reason", "pr" }
 *
 * `phase` is the last phase completed. runPhases runs the phases after it, one at a time, and writes the task
 * (atomically, files.mjs) after each: a run killed between two phases resumes at the next one; a run killed inside a
 * phase, before its write, runs that phase again. A phase is therefore written to be safe to run twice: its result
 * depends on the task as the phase before left it and on the world, never on whether it ran before, and no field of
 * the task holds a time, so a phase run twice writes the same file.
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

async function writeTask(stateDir, task) {
  checkTask(task, `the task ${task.runId}`);
  await writeJsonAtomic(taskPath(stateDir, task.runId), task);
  return task;
}

/**
 * A new task, its directory made once (700) and its task.json written before any phase.
 *
 * @param {string} stateDir
 * @param {{ runId: string, item?: string | null }} options
 */
export async function createTask(stateDir, { runId, item = null }) {
  if (!RUN_ID.test(runId)) {
    throw new TypeError('createTask: runId is not one of newRunId\'s');
  }
  await ensureOwnDirectory(tasksDir(stateDir));
  await ensureOwnDirectory(join(tasksDir(stateDir), runId), { exclusive: true });
  return writeTask(stateDir, {
    version: 1, runId, item, branch: null, baseSha: null, phase: null, round: 0, calls: [], status: 'running',
    reason: null, pr: null,
  });
}

/** The task of `runId`, checked against its schema. */
export async function loadTask(stateDir, runId) {
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
 * The one running task on `branch`, for `run --resume <branch>`: refused when there is none, or more than one, or
 * when the task on it has ended.
 *
 * @param {string} stateDir
 * @param {string} branch
 */
export async function findTaskByBranch(stateDir, branch) {
  let names;
  try {
    names = await readdir(tasksDir(stateDir));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    names = [];
  }
  const found = [];
  for (const runId of names.filter((name) => RUN_ID.test(name)).sort()) {
    const task = await loadTask(stateDir, runId);
    if (task.branch === branch) {
      found.push(task);
    }
  }
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
        return blockTask(stateDir, current, `${phase.name}: ${error.message}`);
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
