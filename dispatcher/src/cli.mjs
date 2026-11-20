#!/usr/bin/env node
/**
 * The dispatcher's entry point (incident-platform backlog #0-275, step 4.3a; stage-4.md "4.3"):
 *
 *   node --env-file=/home/dispatcher/.config/factory/env dispatcher/src/cli.mjs run \
 *     [--item 0-N | --resume <branch>] --adapter <product>/.factory/adapter.json
 *
 * Its settings come from the environment only (ADR-0055): FACTORY_* (config/factory-env.mjs) and BUILDER_APP_*
 * (config/builder-env.mjs). The environment holds no secret, of any variable: one shaped like a secret is refused by
 * its name (config/settings.mjs). `run`, in this order:
 *   1. the settings, every refusal by the variable's name, never its value;
 *   2. $FACTORY_STATE_DIR: a directory of this user's, 700 (made by the provisioning); $FACTORY_REPO_DIR a directory;
 *   3. the lock ($FACTORY_STATE_DIR/lock): another run holding it refuses this one (state/lock.mjs);
 *   4. the adapter, against schemas/adapter.schema.json;
 *   5. the breaker (state.json): tripped, or unreadable, refuses the run;
 *   6. the task: a new one (`--item`, or none, which 4.4's pick fills), or the running one on `--resume`'s branch;
 *   7. its phases, from the one after the last completed (state/tasks.mjs). v0 has none: they are 4.4's.
 * It prints the task as one JSON line and releases the lock; a refusal is a line on stderr, and the exit code 1.
 */
import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadAdapter } from './adapter.mjs';
import { readBuilderEnv } from './config/builder-env.mjs';
import { readFactoryEnv } from './config/factory-env.mjs';
import { ConfigError, refuseSecretShaped } from './config/settings.mjs';
import { checkTaskBranch } from './github/builder-token.mjs';
import { breakerRefusal, openBreaker } from './state/breaker.mjs';
import { checkStateDir } from './state/files.mjs';
import { acquireLock } from './state/lock.mjs';
import { createTask, findTaskByBranch, newRunId, runPhases } from './state/tasks.mjs';

/** The phases of a task, in order: none in v0 (4.4 ports them from today's autopilot). */
export const PHASES = Object.freeze([]);

/** The command line is wrong. */
export class UsageError extends Error {}

const USAGE = 'usage: cli.mjs run [--item 0-N | --resume <branch>] --adapter <path>';
const ITEM = /^[0-9]+-[0-9]+$/;

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { item: { type: 'string' }, resume: { type: 'string' }, adapter: { type: 'string' } },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError(`${error.message}; ${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || positionals[0] !== 'run') {
    throw new UsageError(USAGE);
  }
  if (values.adapter === undefined) {
    throw new UsageError(`--adapter is required; ${USAGE}`);
  }
  if (values.item !== undefined && values.resume !== undefined) {
    throw new UsageError(`--item and --resume exclude each other; ${USAGE}`);
  }
  if (values.item !== undefined && !ITEM.test(values.item)) {
    throw new UsageError('--item must be a backlog item, 0-N');
  }
  if (values.resume !== undefined) {
    // The one rule of a task's branch, the push's own (incident-platform backlog #0-276).
    try {
      checkTaskBranch(values.resume);
    } catch {
      throw new UsageError('--resume must be a branch name, <type>/<name>');
    }
  }
  return values;
}

async function checkRepoDir(path) {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new ConfigError('FACTORY_REPO_DIR is not a directory');
  }
}

/**
 * @param {string[]} argv the arguments after the script
 * @param {{ env?: Record<string, string | undefined>, out?: { write: (text: string) => void },
 *   now?: () => number, random?: (size: number) => Buffer, phases?: typeof PHASES }} [options] all but argv for
 *   the tests
 * @returns {Promise<object>} the task as it was left
 */
export async function main(argv, { env = process.env, out = process.stdout, now, random, phases = PHASES } = {}) {
  const args = parse(argv);
  refuseSecretShaped(env);
  const settings = readFactoryEnv(env);
  readBuilderEnv(env);
  await checkStateDir(settings.stateDir);
  await checkRepoDir(settings.repoDir);
  const lock = acquireLock(settings.stateDir);
  try {
    await loadAdapter(args.adapter);
    const refusal = breakerRefusal(await openBreaker(settings.stateDir), settings.maxBlocked);
    if (refusal) {
      throw new Error(refusal);
    }
    const task = args.resume === undefined
      ? await createTask(settings.stateDir, { runId: newRunId({ now, random }), item: args.item ?? null })
      : await findTaskByBranch(settings.stateDir, args.resume);
    const left = await runPhases(settings.stateDir, task, phases);
    out.write(`${JSON.stringify({ runId: left.runId, item: left.item, branch: left.branch, phase: left.phase,
      status: left.status, reason: left.reason })}\n`);
    return left;
  } finally {
    lock.release();
  }
}

const isMain = import.meta.main
  ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`dispatcher: ${error.message}\n`);
    process.exitCode = 1;
  });
}
