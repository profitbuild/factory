/**
 * The build VM's places the task container is made of (incident-platform ADR-0062; backlog #0-277). They are the VM's
 * layout, made by its provisioning (incident-platform's provision.sh), not settings: as /usr/bin/git is, each is
 * named once, here.
 */

/** Where the task's work directories live: `factory`'s (700), never the dispatcher's (ADR-0062 point 2). */
export const TASKS_ROOT = '/home/factory/tasks';
/** Where a one-shot helper sees TASKS_ROOT. */
export const HELPER_TASKS = '/tasks';
/** The factory checkout, root's (0755), at FACTORY_COMMIT (ADR-0062 point 3) ... */
export const FACTORY_CHECKOUT = '/opt/factory-checkout';
/** ... and where the task container holds it, read-only. */
export const FACTORY_MOUNT = '/opt/factory';
/**
 * The factory's managed settings for Claude Code (incident-platform backlog #0-301, ADR-0064 point 1): the checkout's
 * claude-code/etc, mounted read-only on the whole of the task container's /etc/claude-code.
 */
export const MANAGED_SETTINGS_SOURCE = `${FACTORY_CHECKOUT}/claude-code/etc`;
export const MANAGED_SETTINGS_MOUNT = '/etc/claude-code';
/**
 * Where the task container holds its token's directory, read-only (incident-platform backlog #0-313, ADR-0064 point 5
 * as amended): the managed settings' apiKeyHelper prints `${TOKEN_MOUNT}/token`, as #0-313's measurement 1 had it.
 */
export const TOKEN_MOUNT = '/run/factory';
/**
 * The dispatcher's env file on the VM, which Node loads with --env-file (README, "Layout"): every command of the
 * dispatcher's that a refusal names gives it.
 */
export const DISPATCHER_ENV_FILE = '/home/dispatcher/.config/factory/env';
/** The one volume a sweep keeps: the shared Maven cache (stage-4.md "4.3": shared in v0). */
export const M2_VOLUME = 'factory-dispatcher-m2';
/** Where the task's clone is in its container. */
export const WORKSPACE = '/workspace';
/** The label every container, network and volume of a task carries, `factory.task=<runId>`. */
export const TASK_LABEL = 'factory.task';
/** The label a rollback's container carries (`factory.rollback=1`, incident-platform's rollback-start.sh). */
export const ROLLBACK_LABEL = 'factory.rollback';
/** The uid and gid the container's user maps to (ADR-0057), the owner of the clone. */
export const WORK_OWNER = '1000:1000';

const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;

/** The task's directory under TASKS_ROOT, and its clone `w` in it; `runId` is checked, so no path is built of others. */
export function taskPaths(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw new TypeError('taskPaths: runId is not one of newRunId\'s');
  }
  const dir = `${TASKS_ROOT}/${runId}`;
  return {
    dir,
    work: `${dir}/w`,
    override: `${dir}/devcontainer.json`,
    // The build's configuration, in a directory of its own (#0-284), and the image's name: unique to the run, in the
    // lower case a reference must be (a runId has T and Z).
    buildConfig: `${dir}/build/devcontainer.json`,
    image: `factory-task-${runId.toLowerCase()}`,
    network: `factory-task-${runId}`,
    claudeVolume: `factory-task-${runId}-claude`,
    // The token's directory (#0-313): made empty by the work directory's helper before `devcontainer up` (a bind's
    // source must exist), its file written by a helper of its own once the container is checked (work-dir.mjs).
    tokenDir: `${dir}/token`,
  };
}

export { RUN_ID };
