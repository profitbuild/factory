/**
 * A run's task environment, in ADR-0062's order (incident-platform backlog #0-277; points 2, 4 to 7). Steps 1 and 2
 * are the run's slot section's, under the dispatcher's lock (refuseOffEnvironment, sweepForRun); 3 to 7 run under
 * the task's lock alone; 8 under the dispatcher's again (#0-303, ADR-0062 point 7 as amended; cli.mjs takes and
 * releases the locks):
 *
 *  1. a running container labelled `factory.rollback` refuses the run (the rollback shares the VM by time);
 *  2. the sweep (sweepForRun), its result checked: the whole daemon when no other task is live (a killed run's
 *     leftovers, labelled or not, a stopped rollback's container and its credential volumes, every work directory),
 *     and only the run's own labelled objects when another task is live;
 *  3. the task's network, labelled `factory.task=<runId>`: the run is visible to a rollback that starts from here on;
 *  4. the rollback checked again: one still building its image when the run started is seen by this check or by
 *     rollback-start.sh's own second one. A refusal here removes the run's own labelled objects, and nothing else:
 *     the rollback is running, so the daemon is not the run's to sweep;
 *  5. the task: made, or the one resumed (the caller's);
 *  6. its container (setUpTaskContainer), checked before anything runs in it (#0-284, ADR-0062 points 4 and 6 as
 *     amended): the base (FACTORY_REPO_DIR's main in v0) recorded; the configuration read from the base and checked;
 *     the work directory cloned from the base's bundle by a helper, the task's
 *     volumes; for a new task, the build configuration written by a helper and `devcontainer build` as a call of its
 *     own, to the name factory-task-<runId>, and the image's ID read once from that name; for a task resumed, the ID
 *     it recorded. The same way for both from there: the image's devcontainer.metadata label held to the list, the ID
 *     recorded in task.json, the override `{ image: <ID> }` written by a helper (no build, no feature), `devcontainer
 *     up`, the container checked (its image the ID, its HostConfig to the closed table, its mounts), the probes of
 *     `timeout` and of the tools the product's commands run with (#0-278). Any refusal there ends the task BLOCKED,
 *     with the reason, and a label off the list ends it before any container of the task's is made;
 *  7. the phases (4.4's; none in v0), given the container;
 *  8. at the end, BLOCKED or not, the same sweep as in 2 (the live tasks counted again), its result checked.
 * Before 1, the daemon's options (`docker info`: rootless, seccomp's builtin profile, cgroup namespaces, runc), checked
 * before the run's first container, the sweep's helper included: a daemon off them refuses the run, and no sweep
 * follows (#0-284; review round 1 of factory#22). Every refusal of 1 and 4 names what it found and the sweep's
 * command (daemon.mjs).
 */
import { BaseBundleError, mainCommit, makeBaseBundle } from '../git/base-bundle.mjs';
import { GitRunError } from '../git/run-git.mjs';
import { blockTask, updateTask } from '../state/tasks.mjs';
import {
  DockerOutputError, SweepError, checkDaemonOptions, createTaskNetwork, createTaskVolumes,
  refuseWhileRollback, removeOwnObjects, sweepDaemon,
} from './daemon.mjs';
import { JsoncError } from './jsonc.mjs';
import { ContainerRunError } from './run-container.mjs';
import { BaseTreeError } from '../product/base-tree.mjs';
import {
  CallTimeoutError, TaskContainerError, buildImage, checkImage, imageIdOf, probeTimeout, probeTools, readTaskConfig,
  upContainer,
} from './task-container.mjs';
import { TaskConfigError, buildOverride, imageBuildConfig } from './task-config.mjs';
import { WorkDirError, makeWorkDir, writeBuildConfig, writeOverride } from './work-dir.mjs';

/** What ends a task BLOCKED when its container cannot be set up: the product's, the daemon's or the image's fault. */
const BLOCKING = [TaskConfigError, TaskContainerError, JsoncError, ContainerRunError, WorkDirError, BaseBundleError,
  DockerOutputError, CallTimeoutError, GitRunError, BaseTreeError];

/**
 * Steps 6: the task's container, or the task BLOCKED with the reason.
 *
 * @param {{ stateDir: string, repoDir: string, task: object, adapter: { taskImage: string }, helperImage: string,
 *   sudo?: string, git?: string }} options `sudo` and `git` for the tests only
 * @returns {Promise<{ task: object, container: object | null }>}
 */
export async function setUpTaskContainer({ stateDir, repoDir, task, adapter, helperImage, sudo, git }) {
  let current = task;
  const run = { sudo, stateDir };
  try {
    const { runId } = current;
    if (current.baseSha === null) {
      current = await updateTask(stateDir, current, { baseSha: await mainCommit(repoDir, { git }) });
    }
    const carried = await readTaskConfig({ repoDir, base: current.baseSha, path: adapter.taskImage, git });
    await makeWorkDir({ runId, bundle: await makeBaseBundle({ repoDir, baseSha: current.baseSha, git }),
      image: helperImage, ...run });
    await createTaskVolumes({ runId, ...run });
    let { imageId } = current;
    if (imageId === null) {
      await writeBuildConfig({ runId, config: imageBuildConfig(carried, { runId }), image: helperImage, ...run });
      imageId = await imageIdOf({ name: await buildImage({ runId, ...run }), ...run });
    }
    await checkImage({ imageId, carried, ...run });
    if (current.imageId === null) {
      current = await updateTask(stateDir, current, { imageId });
    }
    await writeOverride({ runId, override: buildOverride(carried, { runId, imageId }), image: helperImage, ...run });
    const container = await upContainer({ runId, carried, imageId, ...run });
    await probeTimeout({ container, sudo });
    await probeTools({ container, sudo });
    // The carried configuration too: an agent's call takes the containerEnv it accepted (#0-301, flow/call.mjs).
    return { task: current, container, carried };
  } catch (error) {
    if (BLOCKING.some((kind) => error instanceof kind)) {
      return { task: await blockTask(stateDir, current, `the task container: ${error.message}`), container: null };
    }
    throw error;
  }
}

/**
 * The sweep of a run's slot section and of its end (incident-platform backlog #0-303, ADR-0062 point 7 as amended),
 * under the dispatcher's lock its caller holds: the whole daemon when no other task is live (in M2, always), and
 * otherwise only the objects that carry this run's label, since the daemon holds a live task's too. What the sweep of
 * a shared daemon removes when two tasks are live is #0-285's (M3.4), not this one's.
 *
 * @param {{ runId: string, helperImage: string, stateDir: string, sudo?: string, othersLive: string[] }} options
 *   `othersLive` the runIds of the other live tasks, counted under the same lock
 * @returns {Promise<{ scope: 'daemon' | 'own', removed: object | null }>}
 */
export async function sweepForRun({ runId, helperImage, stateDir, sudo, othersLive }) {
  if (othersLive.length === 0) {
    return { scope: 'daemon', removed: await sweepDaemon({ runId, helperImage, sudo, stateDir }) };
  }
  await removeOwnObjects({ runId, sudo, stateDir });
  return { scope: 'own', removed: null };
}

/**
 * The checks of a run's slot section before its task is made (#0-303; review round 1 of factory#25, decision 2),
 * under the dispatcher's lock: the daemon's options before the run's first container, the sweep's helper included (a
 * daemon off the VM's options refuses the run, and no sweep follows: review round 1 of factory#22, decision 1), and
 * a running rollback refusing the run. The sweep (sweepForRun) follows once the task and its lock are taken.
 *
 * @param {{ stateDir: string, sudo?: string }} options
 */
export async function refuseOffEnvironment({ stateDir, sudo }) {
  await checkDaemonOptions({ sudo, stateDir });
  await refuseWhileRollback({ sudo, stateDir, when: 'the run is refused' });
}

/**
 * Steps 3 to 8 around `inside`, which sets up the task's container and runs its phases, under the task's lock alone
 * (#0-303): the run's network, the rollback checked again, `inside`, then `sweepAtEnd` (the caller's: it takes the
 * dispatcher's lock, counts the live tasks again and sweeps as sweepForRun does). A rollback seen by the second check
 * refuses the run, its own objects removed, and no sweep follows, as before #0-303.
 *
 * @param {{ runId: string, stateDir: string, sudo?: string, sweepAtEnd: () => Promise<unknown> }} options `stateDir`
 *   where every container call's stderr is kept (run-container.mjs)
 * @param {() => Promise<T>} inside
 * @returns {Promise<T>}
 * @template T
 */
export async function inTaskEnvironment({ runId, stateDir, sudo, sweepAtEnd }, inside) {
  let result;
  let failure = null;
  try {
    await createTaskNetwork({ runId, sudo, stateDir });
    try {
      await refuseWhileRollback({ sudo, stateDir, when: 'the run is refused after its network was made' });
    } catch (error) {
      // The refusal wins, whatever the removal of the run's own objects does: a rollback is running, so no sweep
      // may follow (review round 1 gen-5c1e). A failure of that removal is told in the refusal, and the next run's
      // sweep, once the rollback has ended, removes what is left.
      error.noSweepAfter = true;
      try {
        await removeOwnObjects({ runId, sudo, stateDir });
      } catch (removal) {
        error.message = `${error.message}; and the run's own objects could not all be removed: ${removal.message}`;
      }
      throw error;
    }
    result = await inside();
  } catch (error) {
    failure = error;
  }
  if (failure?.noSweepAfter) {
    throw failure;
  }
  try {
    await sweepAtEnd();
  } catch (error) {
    if (failure === null) {
      throw error;
    }
    const kind = error instanceof SweepError ? '' : 'the sweep at the end failed: ';
    failure.message = `${failure.message}; and ${kind}${error.message}`;
  }
  if (failure !== null) {
    throw failure;
  }
  return result;
}
