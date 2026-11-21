#!/usr/bin/env node
/**
 * The dispatcher's entry point (incident-platform backlog #0-275, step 4.3a; stage-4.md "4.3"):
 *
 *   node --env-file=/home/dispatcher/.config/factory/env dispatcher/src/cli.mjs run --item 0-N | --resume <branch>
 *   node --env-file=... dispatcher/src/cli.mjs sweep [--force]
 *
 * Its settings come from the environment only (ADR-0055): FACTORY_* (config/factory-env.mjs) and BUILDER_APP_*
 * (config/builder-env.mjs). The environment holds no secret, of any variable: one shaped like a secret is refused by
 * its name (config/settings.mjs). `run`, in this order:
 *   1. the settings, every refusal by the variable's name, never its value;
 *   2. $FACTORY_STATE_DIR: a directory of this user's, 700 (made by the provisioning); $FACTORY_REPO_DIR a directory,
 *      its objects the dispatcher's and the clone the dispatcher's alone, every directory on the way to it its
 *      user's or root's and writable by no one else (git/task-objects.mjs checkRepoDir, #0-278 AC7);
 *   3. the lock ($FACTORY_STATE_DIR/lock): another run holding it refuses this one (state/lock.mjs);
 *   4. the breaker (state.json): tripped, or unreadable, refuses the run;
 *   5. the item and its base (incident-platform backlog #0-278, ADR-0060 D6 and D8 as amended). A new task
 *      (`--item`, which v0 requires: the owner names the item) is refused when one of the dispatcher's own tasks
 *      holds the item (running, with a branch); the adapter is read from FACTORY_REPO_DIR's main as it is, for the
 *      repository builder-app's token is narrowed to; main is brought up to GitHub's with that token, fast-forward
 *      only (git/main-fetch.mjs); the base is main's commit, and the adapter is read again from it, the one every
 *      later read of the task uses, its repository the same; the item is refused when an open pull request holds it
 *      (github/item-lock.mjs, every page). A task resumed reads the adapter from the base it recorded. The adapter,
 *      always a blob of the base, never a file of a checkout nor of a branch: .factory/adapter.json, checked against
 *      schemas/adapter.schema.json and against the base's tree (product/adapter-from-base.mjs);
 *   6. factory's daemon (container/environment.mjs, incident-platform backlog #0-277, ADR-0062): refused while a
 *      rollback runs; swept, the sweep checked; the run's network made; the rollback checked again;
 *   7. the task: a new one, its item and base recorded, or the running one on `--resume`'s branch;
 *   8. its container, from a fresh clone of the base (a refusal there ends the task BLOCKED, with the reason);
 *   9. its phases, from the one after the last completed (state/tasks.mjs). v0 has none: they are 4.4's;
 *  10. the daemon swept again, the task BLOCKED or not.
 * It prints the task as one JSON line, revokes builder-app's token if one was minted, and releases the lock; a refusal
 * is a line on stderr, and the exit code 1. No product code runs as `dispatcher` (ADR-0060 D6 as amended): what the
 * dispatcher reads of the product is blobs of its base, and the product's commands run in the task container only.
 *
 * `sweep` is the sweep alone, for what a killed run left (ADR-0062 point 5): under the lock, it removes every
 * container, user-defined network and volume of factory's daemon but factory-dispatcher-m2, and every work directory,
 * and checks the result. It refuses while a running container carries `factory.rollback`, naming it: a rollback is
 * ended by its owner, never swept. `sweep --force` sweeps that container too: one a task's code started with the
 * label, which a killed run left running (ADR-0062's Consequences: a refusal cleared with `cli.mjs sweep`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readBuilderEnv } from './config/builder-env.mjs';
import { readFactoryEnv } from './config/factory-env.mjs';
import { refuseSecretShaped } from './config/settings.mjs';
import { inTaskEnvironment, setUpTaskContainer } from './container/environment.mjs';
import { refuseWhileRollback, sweepDaemon } from './container/daemon.mjs';
import { mainCommit } from './git/base-bundle.mjs';
import { fetchMain } from './git/main-fetch.mjs';
import { checkRepoDir } from './git/task-objects.mjs';
import { GITHUB_API } from './github/app-token.mjs';
import { GIT_HOST, checkTaskBranch, createBuilderTokenSource } from './github/builder-token.mjs';
import { openPullHeads, refuseHeldByPull, refuseHeldByTask } from './github/item-lock.mjs';
import { ADAPTER_PATH, readAdapter } from './product/adapter-from-base.mjs';
import { breakerRefusal, openBreaker } from './state/breaker.mjs';
import { checkStateDir } from './state/files.mjs';
import { acquireLock } from './state/lock.mjs';
import { createTask, findTaskByBranch, listTasks, newRunId, runPhases } from './state/tasks.mjs';

/** The phases of a task, in order: none in v0 (4.4 ports them from today's autopilot). */
export const PHASES = Object.freeze([]);

/** The command line is wrong. */
export class UsageError extends Error {}

const USAGE = 'usage: cli.mjs run --item 0-N | cli.mjs run --resume <branch> | cli.mjs sweep [--force]';
const ITEM = /^[0-9]+-[0-9]+$/;

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { item: { type: 'string' }, resume: { type: 'string' }, force: { type: 'boolean' } },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError(`${error.message}; ${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !['run', 'sweep'].includes(positionals[0])) {
    throw new UsageError(USAGE);
  }
  const command = positionals[0];
  if (command === 'sweep') {
    if (values.item !== undefined || values.resume !== undefined) {
      throw new UsageError(`sweep takes --force alone; ${USAGE}`);
    }
    return { command, force: values.force === true };
  }
  if (values.force !== undefined) {
    throw new UsageError(`--force is sweep's; ${USAGE}`);
  }
  if (values.item !== undefined && values.resume !== undefined) {
    throw new UsageError(`--item and --resume exclude each other; ${USAGE}`);
  }
  if (values.item === undefined && values.resume === undefined) {
    // v0: the owner names the item (ADR-0060 D8 as amended, incident-platform backlog #0-278); the dispatcher picks
    // none until stage 7.
    throw new UsageError('run needs --item 0-N (the owner names the item until stage 7) or --resume <branch>; '
      + USAGE);
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
  return { command, ...values };
}

/** The adapter of FACTORY_REPO_DIR's main as it is, before the update: the repository the token is narrowed to. */
async function currentAdapter(repoDir) {
  try {
    return await readAdapter({ repoDir, base: await mainCommit(repoDir) });
  } catch (error) {
    if (error.missing === true) {
      error.message = `FACTORY_REPO_DIR's main holds no ${ADAPTER_PATH}: once the product's pull request that adds it `
        + 'is merged, the build VM is provisioned again (provision.sh clones main afresh)';
    }
    throw error;
  }
}

/**
 * Step 5: the base and its adapter, the item's lock checked for a new task; the token source made, never minted
 * before main is fetched.
 */
async function itemAndBase(settings, args, { builder, apiBase, gitBase, fetchImpl, keep }) {
  const tokenSource = (repository) => keep(createBuilderTokenSource({ env: builder, repository, baseUrl: apiBase,
    fetchImpl }));
  if (args.resume !== undefined) {
    const resumed = await findTaskByBranch(settings.stateDir, args.resume);
    const base = resumed.baseSha ?? await mainCommit(settings.repoDir);
    const adapter = await readAdapter({ repoDir: settings.repoDir, base });
    return { resumed, base, adapter, tokens: tokenSource(adapter.repository) };
  }
  refuseHeldByTask({ item: args.item, tasks: await listTasks(settings.stateDir) });
  const current = await currentAdapter(settings.repoDir);
  const tokens = tokenSource(current.repository);
  await fetchMain({ stateDir: settings.stateDir, repoDir: settings.repoDir, repository: current.repository, tokens,
    gitBase });
  const base = await mainCommit(settings.repoDir);
  const adapter = await readAdapter({ repoDir: settings.repoDir, base });
  if (adapter.repository !== current.repository) {
    throw new Error('the adapter of the updated main names another repository than the one the token was minted for: '
      + 'the run is refused (a product moved is provisioned again)');
  }
  refuseHeldByPull({ item: args.item, heads: await openPullHeads({ repository: adapter.repository, tokens, apiBase,
    fetchImpl }) });
  return { resumed: null, base, adapter, tokens };
}

/** `sweep [--force]`: the sweep alone, under the lock. */
async function sweep(settings, { force, runId, sudo }) {
  const { stateDir } = settings;
  if (!force) {
    await refuseWhileRollback({ sudo, stateDir, when: 'the sweep is refused' });
  }
  return sweepDaemon({ runId, helperImage: settings.helperImage, sudo, stateDir });
}

/**
 * @param {string[]} argv the arguments after the script
 * @param {{ env?: Record<string, string | undefined>, out?: { write: (text: string) => void },
 *   now?: () => number, random?: (size: number) => Buffer, phases?: typeof PHASES, sudo?: string, apiBase?: string,
 *   gitBase?: string, fetchImpl?: typeof fetch, err?: { write: (text: string) => void } }} [options] all but argv for
 *   the tests (`sudo`: the fake daemon's;
 *   `apiBase`, `gitBase`, `fetchImpl`: the fake GitHub's)
 * @returns {Promise<object>} the task as it was left (`run`), or what the sweep removed (`sweep`)
 */
export async function main(argv, {
  env = process.env, out = process.stdout, err = process.stderr, now, random, phases = PHASES, sudo,
  apiBase = GITHUB_API, gitBase = GIT_HOST, fetchImpl,
} = {}) {
  const args = parse(argv);
  refuseSecretShaped(env);
  const settings = readFactoryEnv(env);
  const builder = readBuilderEnv(env);
  await checkStateDir(settings.stateDir);
  await checkRepoDir(settings.repoDir);
  const lock = acquireLock(settings.stateDir);
  let tokens = null;
  const keep = (source) => { tokens = source; return source; };
  try {
    if (args.command === 'sweep') {
      const removed = await sweep(settings, { force: args.force, runId: newRunId({ now, random }), sudo });
      out.write(`${JSON.stringify({ swept: removed })}\n`);
      return removed;
    }
    const refusal = breakerRefusal(await openBreaker(settings.stateDir), settings.maxBlocked);
    if (refusal) {
      throw new Error(refusal);
    }
    const { resumed, base, adapter } = await itemAndBase(settings, args,
      { builder, apiBase, gitBase, fetchImpl, keep });
    const runId = resumed?.runId ?? newRunId({ now, random });
    const { result: left } = await inTaskEnvironment({ runId, helperImage: settings.helperImage,
      stateDir: settings.stateDir, sudo }, async () => {
      const task = resumed ?? await createTask(settings.stateDir, { runId, item: args.item, baseSha: base });
      const ready = await setUpTaskContainer({ stateDir: settings.stateDir, repoDir: settings.repoDir, task, adapter,
        helperImage: settings.helperImage, sudo });
      return ready.container === null ? ready.task : runPhases(settings.stateDir, ready.task, phases);
    });
    out.write(`${JSON.stringify({ runId: left.runId, item: left.item, branch: left.branch, phase: left.phase,
      status: left.status, reason: left.reason })}\n`);
    return left;
  } finally {
    // A failed revoke changes neither what the run did nor the lock's release: one line on stderr, naming the kind
    // of failure (its kind, or its class), never GitHub's answer; the token expires within the hour. The lock is
    // released in a finally of its own, whatever the revoke or that line do (a write to stderr can throw: EPIPE;
    // review round 2 of factory#20, 3).
    try {
      await tokens?.revoke().catch((error) => {
        const kind = error?.kind ?? error?.constructor?.name ?? 'unknown';
        try {
          err.write(`dispatcher: builder-app's token could not be revoked (${kind}); it expires within the hour\n`);
        } catch {
          // stderr is gone: the line is lost, the run's result and the lock are not.
        }
      });
    } finally {
      lock.release();
    }
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
