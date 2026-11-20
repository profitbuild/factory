/**
 * The task's work directory lives and dies by one-shot containers of `factory`'s daemon (incident-platform ADR-0062
 * point 2; backlog #0-277 AC7, AC10, AC12): the dispatcher writes nothing in a directory of `factory`'s, and no git
 * runs as `factory` on its agent-writable ~/.gitconfig. Each helper:
 *
 *   docker run --rm -i --pull=never --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE
 *     --cap-add FOWNER --security-opt no-new-privileges --label factory.task=<runId>
 *     --mount type=bind,source=/home/factory/tasks,target=/tasks --entrypoint /bin/sh <helper image by digest>
 *     -c <a script of this module's> helper /tasks <runId>
 *
 * - the image is FACTORY_HELPER_IMAGE, buildpack-deps:noble-scm pinned by digest (ADR-0062 point 8: git 2.43,
 *   coreutils), never pulled here (`--pull=never`: the provisioning pulls it at its digest);
 * - the script is a constant of this module; what varies reaches it only as positional arguments (the mount's target,
 *   and the runId, checked against newRunId's pattern) or on stdin (the bundle, the override): no text of a product's
 *   or of an agent's is ever part of a command;
 * - in the container it runs as root, which the rootless daemon maps to `factory` (so it can `chown` to the uid the
 *   container's `dev` maps to, and remove what `dev` wrote), with no network and only the three capabilities it needs;
 * - a write never follows a link an agent could have planted: `mkdir` (no -p) refuses a directory that exists, and the
 *   files are written with noclobber (`set -C`), which refuses any name that exists, a link included.
 * makeWorkDir: `<runId>/`, the bundle from stdin into `<runId>/base.bundle` (git reads no bundle from a pipe),
 * `git clone -b base` into `<runId>/w` with no system or global config and no hooks, the bundle removed, and
 * `chown -R -h 1000:1000 <runId>/w`. writeOverride: `<runId>/devcontainer.json` from stdin, outside the clone the
 * container mounts. removeWorkDir: `rm -rf <runId>`, the directory itself and every entry, dot entries included, and
 * then nothing is there. removeAllWorkDirs: the same for every entry under /tasks (what a killed run left).
 */
import { RUN_ID, TASKS_ROOT, HELPER_TASKS, TASK_LABEL, WORK_OWNER } from './paths.mjs';
import { ContainerRunError, mustRun } from './run-container.mjs';

/** A helper image: a name, an optional tag, and always a digest. */
export const HELPER_IMAGE = /^[a-z0-9]+(?:[._/:-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
/** The longest a helper may run: a clone of the product. */
export const HELPER_TIMEOUT_MS = 10 * 60 * 1000;

const SCRIPTS = Object.freeze({
  make: [
    'set -euC',
    'root=$1; run=$2',
    'umask 077',
    'mkdir -- "$root/$run"',
    'cat > "$root/$run/base.bundle"',
    'umask 022',
    'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null HOME=/nonexistent git -c core.hooksPath=/dev/null '
      + '-c core.fsmonitor= clone -q -b base -- "$root/$run/base.bundle" "$root/$run/w"',
    'rm -f -- "$root/$run/base.bundle"',
    `chown -R -h ${WORK_OWNER} -- "$root/$run/w"`,
  ].join('\n'),
  override: [
    'set -euC',
    'umask 077',
    'test -d "$1/$2" && test ! -L "$1/$2"',
    'cat > "$1/$2/devcontainer.json"',
  ].join('\n'),
  remove: [
    'set -eu',
    'rm -rf -- "$1/$2"',
    'test ! -e "$1/$2" && test ! -L "$1/$2"',
  ].join('\n'),
  removeAll: [
    'set -eu',
    'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
    'test -z "$(find "$1" -mindepth 1 -maxdepth 1)"',
  ].join('\n'),
});

/** The work directory could not be made, written or removed. */
export class WorkDirError extends Error {}

/** The argv of a helper run for `runId`, its label's value. */
export function helperArgs({ runId, image, script }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw new TypeError('helperArgs: runId is not one of newRunId\'s');
  }
  if (typeof image !== 'string' || !HELPER_IMAGE.test(image)) {
    throw new TypeError('helperArgs: the helper image must be pinned by its digest, <name>[:tag]@sha256:<64 hex>');
  }
  return ['run', '--rm', '-i', '--pull=never', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges',
    '--label', `${TASK_LABEL}=${runId}`, '--mount', `type=bind,source=${TASKS_ROOT},target=${HELPER_TASKS}`,
    '--entrypoint', '/bin/sh', image, '-c', SCRIPTS[script], 'helper', HELPER_TASKS, runId];
}

async function helper(what, { runId, image, script, input, sudo }) {
  try {
    await mustRun({ program: 'docker', args: helperArgs({ runId, image, script }), input, timeoutMs: HELPER_TIMEOUT_MS,
      sudo });
  } catch (error) {
    if (error instanceof ContainerRunError) {
      throw new WorkDirError(`${what}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The task's work directory, `<runId>/w`, a clone of `bundle` (base-bundle.mjs) owned by the container's user.
 *
 * @param {{ runId: string, bundle: Buffer, image: string, sudo?: string }} options `sudo` for the tests only
 */
export function makeWorkDir({ runId, bundle, image, sudo }) {
  if (!Buffer.isBuffer(bundle) || bundle.length === 0) {
    throw new TypeError('makeWorkDir: bundle must be the base bundle\'s bytes');
  }
  return helper(`the work directory of ${runId} could not be made`, { runId, image, script: 'make', input: bundle, sudo });
}

/**
 * `<runId>/devcontainer.json`, the override `devcontainer up` reads, from `override` (task-config.mjs's), as JSON.
 *
 * @param {{ runId: string, override: object, image: string, sudo?: string }} options
 */
export function writeOverride({ runId, override, image, sudo }) {
  return helper(`the configuration of ${runId} could not be written`,
    { runId, image, script: 'override', input: `${JSON.stringify(override, null, 2)}\n`, sudo });
}

/** Removes `<runId>/` whole, and checks that nothing is left of it. */
export function removeWorkDir({ runId, image, sudo }) {
  return helper(`the work directory of ${runId} could not be removed`, { runId, image, script: 'remove', sudo });
}

/** Removes everything under the tasks' directory (a killed run's work directory), and checks it is empty. */
export function removeAllWorkDirs({ runId, image, sudo }) {
  return helper('the work directories could not be removed', { runId, image, script: 'removeAll', sudo });
}

export { SCRIPTS };
