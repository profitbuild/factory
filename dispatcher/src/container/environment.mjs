/**
 * A run's task environment, in ADR-0062's order (incident-platform backlog #0-277; points 2, 4 to 7):
 *
 *  1. a running container labelled `factory.rollback` refuses the run (the rollback shares the VM by time);
 *  2. the sweep of the whole daemon (daemon.mjs), its result checked: a killed run's leftovers, labelled or not, a
 *     stopped rollback's container and its credential volumes, every work directory;
 *  3. the task's network, labelled `factory.task=<runId>`: the run is visible to a rollback that starts from here on;
 *  4. the rollback checked again: one still building its image when the run started is seen by this check or by
 *     rollback-start.sh's own second one. A refusal here removes the run's own labelled objects, and nothing else:
 *     the rollback is running, so the daemon is not the run's to sweep;
 *  5. the task: made, or the one resumed (the caller's);
 *  6. its container (setUpTaskContainer): the base (FACTORY_REPO_DIR's main in v0) recorded, the work directory
 *     cloned from the base's bundle by a helper, the task's volumes, the configuration read from the base and
 *     checked, the override written by a helper, `devcontainer up`, the container and the image checked, the image's
 *     ID recorded, the probes of `timeout` and of the tools the product's commands run with (#0-278). Any refusal
 *     there ends the task BLOCKED, with the reason;
 *  7. the phases (4.4's; none in v0), given the container;
 *  8. at the end, BLOCKED or not, the same sweep as in 2, its result checked.
 * Every refusal of 1 and 4 names what it found and the sweep's command (daemon.mjs).
 */
import { BaseBundleError, mainCommit, makeBaseBundle } from '../git/base-bundle.mjs';
import { GitRunError } from '../git/run-git.mjs';
import { blockTask, updateTask } from '../state/tasks.mjs';
import {
  DockerOutputError, SweepError, createTaskNetwork, createTaskVolumes, refuseWhileRollback, removeOwnObjects,
  sweepDaemon,
} from './daemon.mjs';
import { JsoncError } from './jsonc.mjs';
import { ContainerRunError } from './run-container.mjs';
import { BaseTreeError } from '../product/base-tree.mjs';
import {
  CallTimeoutError, TaskContainerError, probeTimeout, probeTools, readTaskConfig, upContainer,
} from './task-container.mjs';
import { TaskConfigError, buildOverride } from './task-config.mjs';
import { WorkDirError, makeWorkDir, writeOverride } from './work-dir.mjs';

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
  try {
    const { runId } = current;
    if (current.baseSha === null) {
      current = await updateTask(stateDir, current, { baseSha: await mainCommit(repoDir, { git }) });
    }
    const carried = await readTaskConfig({ repoDir, base: current.baseSha, path: adapter.taskImage, git });
    await makeWorkDir({ runId, bundle: await makeBaseBundle({ repoDir, baseSha: current.baseSha, git }),
      image: helperImage, sudo });
    await createTaskVolumes({ runId, sudo });
    await writeOverride({ runId, override: buildOverride(carried, { runId, imageId: current.imageId }),
      image: helperImage, sudo });
    const container = await upContainer({ runId, carried, imageId: current.imageId, sudo });
    if (current.imageId === null) {
      current = await updateTask(stateDir, current, { imageId: container.imageId });
    }
    await probeTimeout({ container, sudo });
    await probeTools({ container, sudo });
    return { task: current, container };
  } catch (error) {
    if (BLOCKING.some((kind) => error instanceof kind)) {
      return { task: await blockTask(stateDir, current, `the task container: ${error.message}`), container: null };
    }
    throw error;
  }
}

/**
 * Steps 1 to 8 around `inside`, which makes or loads the task (5) and runs its phases (7).
 *
 * @param {{ runId: string, helperImage: string, sudo?: string }} options
 * @param {() => Promise<T>} inside
 * @returns {Promise<{ result: T, swept: object }>} `swept`: what the sweep at the start removed
 * @template T
 */
export async function inTaskEnvironment({ runId, helperImage, sudo }, inside) {
  await refuseWhileRollback({ sudo, when: 'the run is refused' });
  const swept = await sweepDaemon({ runId, helperImage, sudo });
  let result;
  let failure = null;
  try {
    await createTaskNetwork({ runId, sudo });
    try {
      await refuseWhileRollback({ sudo, when: 'the run is refused after its network was made' });
    } catch (error) {
      // The refusal wins, whatever the removal of the run's own objects does: a rollback is running, so no sweep
      // may follow (review round 1 gen-5c1e). A failure of that removal is told in the refusal, and the next run's
      // sweep, once the rollback has ended, removes what is left.
      error.noSweepAfter = true;
      try {
        await removeOwnObjects({ runId, sudo });
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
    await sweepDaemon({ runId, helperImage, sudo });
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
  return { result, swept };
}
