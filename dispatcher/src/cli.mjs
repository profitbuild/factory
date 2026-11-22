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
 *   3. the dispatcher's lock ($FACTORY_STATE_DIR/lock), waited for while another run takes its slot or sweeps
 *      (state/lock.mjs, incident-platform backlog #0-303): from here to step 6, the run's slot section, and only for
 *      it;
 *   4. the breaker (state.json, under the state's lock): tripped, or unreadable, refuses the run;
 *   5. the item and its base (incident-platform backlog #0-278, ADR-0060 D6 and D8 as amended). A new task
 *      (`--item`, which v0 requires: the owner names the item) is refused when one of the dispatcher's own tasks
 *      holds the item (running, with a branch); the adapter is read from FACTORY_REPO_DIR's main as it is, for the
 *      repository builder-app's token is narrowed to; main is brought up to GitHub's with that token, fast-forward
 *      only (git/main-fetch.mjs); the base is main's commit, and the adapter is read again from it, the one every
 *      later read of the task uses, its repository the same; the item is refused when an open pull request holds it
 *      (github/item-lock.mjs, every page). A task resumed reads the adapter from the base it recorded. The adapter,
 *      always a blob of the base, never a file of a checkout nor of a branch: .factory/adapter.json, checked against
 *      schemas/adapter.schema.json and against the base's tree (product/adapter-from-base.mjs);
 *   6. the slot (#0-303, ADR-0060 D7 as amended): the task, a new one with its item and base recorded, or the running
 *      one on `--resume`'s branch; its lock (tasks/<runId>/lock), held for the whole run (a resumed task whose lock
 *      another run holds is live, and refused); the other live tasks counted (state/tasks.mjs liveTasks), and the run
 *      refused when FACTORY_SLOTS of them are live, before it touches the daemon; then factory's daemon
 *      (container/environment.mjs, #0-277, ADR-0062): its options, refused while a rollback runs, and swept, the whole
 *      daemon when no other task is live (in M2, always), only the run's own labelled objects when one is. Then the
 *      dispatcher's lock is released. A new task refused in this step ends BLOCKED, with the reason;
 *   7. under the task's lock alone: the run's network, the rollback checked again; its container, from a fresh clone
 *      of the base (a refusal there ends the task BLOCKED, with the reason); its phases, from the one after the last
 *      completed (state/tasks.mjs). v0 has none: they are 4.4's;
 *   8. the dispatcher's lock again, the live tasks counted again, the daemon swept as in 6, the task BLOCKED or not;
 *      then the task's lock released, and the dispatcher's last.
 * The locks are taken in the order dispatcher, task, state, never the other way (state/lock.mjs says why the task's,
 * held while the run waits for the dispatcher's at its end, cannot make a cycle). It prints the task as one JSON line,
 * revokes builder-app's token if one was minted, and releases every lock it holds, each in a finally of its own; a
 * refusal is a line on stderr, and the exit code 1. No product code runs as `dispatcher` (ADR-0060 D6 as amended): what the
 * dispatcher reads of the product is blobs of its base, and the product's commands run in the task container only.
 *
 * `sweep` is the sweep alone, for what a killed run left (ADR-0062 point 5): under the dispatcher's lock, refused while
 * any task is live, naming it (#0-303: `--force` does not pass that, a live task is no killed run's), it removes every
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
import { inTaskEnvironment, setUpTaskContainer, startTaskEnvironment, sweepForRun } from './container/environment.mjs';
import { checkDaemonOptions, refuseWhileRollback, sweepDaemon } from './container/daemon.mjs';
import { mainCommit } from './git/base-bundle.mjs';
import { fetchMain } from './git/main-fetch.mjs';
import { checkRepoDir } from './git/task-objects.mjs';
import { GITHUB_API } from './github/app-token.mjs';
import { GIT_HOST, checkTaskBranch, createBuilderTokenSource } from './github/builder-token.mjs';
import { openPullHeads, refuseHeldByPull, refuseHeldByTask } from './github/item-lock.mjs';
import { ADAPTER_PATH, readAdapter } from './product/adapter-from-base.mjs';
import { breakerRefusal, openBreaker } from './state/breaker.mjs';
import { checkStateDir } from './state/files.mjs';
import { DISPATCHER_WAIT_S, acquireDispatcherLock, acquireTaskLock } from './state/lock.mjs';
import { blockTask, createTask, findTaskByBranch, listTasks, liveTasks, newRunId, runPhases } from './state/tasks.mjs';

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

/** `sweep [--force]`: the sweep alone, under the dispatcher's lock, refused while a task is live (#0-303). */
async function sweep(settings, { force, runId, sudo }) {
  const { stateDir } = settings;
  const live = await liveTasks(stateDir);
  if (live.length > 0) {
    throw new Error(`the sweep is refused: the task${live.length === 1 ? '' : 's'} ${live.join(', ')} `
      + `${live.length === 1 ? 'is' : 'are'} live (${live.length === 1 ? 'its' : 'their'} lock held by a run); `
      + 'a live task is no killed run\'s, and --force does not pass this');
  }
  // The sweep's helper is a container: none on a daemon off the VM's options (#0-284, review round 1 of factory#22).
  await checkDaemonOptions({ sudo, stateDir });
  if (!force) {
    await refuseWhileRollback({ sudo, stateDir, when: 'the sweep is refused' });
  }
  return sweepDaemon({ runId, helperImage: settings.helperImage, sudo, stateDir });
}

/** The other live tasks fill every slot: the run is refused before it touches the daemon (#0-303). */
function refuseFullSlots(others, slots) {
  if (others.length >= slots) {
    throw new Error(`every slot is taken: ${others.length} task${others.length === 1 ? ' is' : 's are'} live `
      + `(${others.join(', ')}), FACTORY_SLOTS is ${slots}: the run is refused`);
  }
}

/**
 * @param {string[]} argv the arguments after the script
 * @param {{ env?: Record<string, string | undefined>, out?: { write: (text: string) => void },
 *   now?: () => number, random?: (size: number) => Buffer, phases?: typeof PHASES, sudo?: string, apiBase?: string,
 *   gitBase?: string, fetchImpl?: typeof fetch, err?: { write: (text: string) => void }, dispatcherWaitS?: number,
 *   hooks?: { inSlot?: () => Promise<void> } }} [options] all but argv for the tests (`sudo`: the fake daemon's;
 *   `apiBase`, `gitBase`, `fetchImpl`: the fake GitHub's; `dispatcherWaitS` the wait for the dispatcher's lock;
 *   `hooks.inSlot` runs in the slot section, once the slot is counted, for a test that holds a run there)
 * @returns {Promise<object>} the task as it was left (`run`), or what the sweep removed (`sweep`)
 */
export async function main(argv, {
  env = process.env, out = process.stdout, err = process.stderr, now, random, phases = PHASES, sudo,
  apiBase = GITHUB_API, gitBase = GIT_HOST, fetchImpl, dispatcherWaitS = DISPATCHER_WAIT_S, hooks = {},
} = {}) {
  const args = parse(argv);
  refuseSecretShaped(env);
  const settings = readFactoryEnv(env);
  const builder = readBuilderEnv(env);
  const { stateDir } = settings;
  await checkStateDir(stateDir);
  await checkRepoDir(settings.repoDir);
  // The locks this run holds, each released in a finally of its own (#0-303): the dispatcher's for the slot section
  // and the sweep at the end only, the task's for the whole run.
  let dispatcher = await acquireDispatcherLock(stateDir, { wait: dispatcherWaitS });
  let taskLock = null;
  let tokens = null;
  const keep = (source) => { tokens = source; return source; };
  try {
    if (args.command === 'sweep') {
      const removed = await sweep(settings, { force: args.force, runId: newRunId({ now, random }), sudo });
      out.write(`${JSON.stringify({ swept: removed })}\n`);
      return removed;
    }
    // The slot section (#0-303), under the dispatcher's lock: a. the breaker; b. the fetch of main (FACTORY_REPO_DIR
    // is shared, and two fetches at once collide on git's own locks); c. the item and the base, the item's check
    // against the dispatcher's own tasks and the task made, so that two new runs of one item cannot both pass it;
    // d. the task's lock; e. the slots; f. the daemon's start.
    const refusal = breakerRefusal(await openBreaker(stateDir), settings.maxBlocked);
    if (refusal) {
      throw new Error(refusal);
    }
    const { resumed, base, adapter } = await itemAndBase(settings, args,
      { builder, apiBase, gitBase, fetchImpl, keep });
    const runId = resumed?.runId ?? newRunId({ now, random });
    let task = resumed ?? await createTask(stateDir, { runId, item: args.item, baseSha: base });
    try {
      taskLock = await acquireTaskLock(stateDir, runId);
      const others = await liveTasks(stateDir, { except: runId });
      refuseFullSlots(others, settings.slots);
      await hooks.inSlot?.();
      await startTaskEnvironment({ runId, helperImage: settings.helperImage, stateDir, sudo, othersLive: others });
    } catch (error) {
      // A new task refused before its container ends BLOCKED, with the reason; a resumed one is left as it was.
      if (resumed === null) {
        task = await blockTask(stateDir, task, `refused before its container: ${error.message}`);
      }
      throw error;
    }
    dispatcher.release();
    dispatcher = null;
    const left = await inTaskEnvironment({ runId, stateDir, sudo, sweepAtEnd: async () => {
      dispatcher = await acquireDispatcherLock(stateDir, { wait: dispatcherWaitS });
      return sweepForRun({ runId, helperImage: settings.helperImage, stateDir, sudo,
        othersLive: await liveTasks(stateDir, { except: runId }) });
    } }, async () => {
      const ready = await setUpTaskContainer({ stateDir, repoDir: settings.repoDir, task, adapter,
        helperImage: settings.helperImage, sudo });
      return ready.container === null ? ready.task : runPhases(stateDir, ready.task, phases);
    });
    out.write(`${JSON.stringify({ runId: left.runId, item: left.item, branch: left.branch, phase: left.phase,
      status: left.status, reason: left.reason })}\n`);
    return left;
  } finally {
    // A failed revoke changes neither what the run did nor the locks' release: one line on stderr, naming the kind
    // of failure (its kind, or its class), never GitHub's answer; the token expires within the hour. Each lock is
    // released in a finally of its own, whatever the revoke or that line do (a write to stderr can throw: EPIPE;
    // review round 2 of factory#20, 3), the task's before the dispatcher's (#0-303).
    try {
      await tokens?.revoke().catch((error) => {
        const kind = error?.kind ?? error?.constructor?.name ?? 'unknown';
        try {
          err.write(`dispatcher: builder-app's token could not be revoked (${kind}); it expires within the hour\n`);
        } catch {
          // stderr is gone: the line is lost, the run's result and the locks are not.
        }
      });
    } finally {
      try {
        taskLock?.release();
      } finally {
        dispatcher?.release();
      }
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
