/**
 * The task container (incident-platform ADR-0062 points 4, 6 and 7; backlog #0-277 AC5, AC6, AC9, AC11).
 *
 * readTaskConfig: the product's task configuration, `taskImage` in its adapter, read from the task's base in the
 * dispatcher's own FACTORY_REPO_DIR through runGit, as data: its path bounded (relative, not an option, in the clone,
 * a .json); every file it needs (itself, its devcontainer-lock.json, the Dockerfile) a blob of the base that is not a
 * symlink, and its build context a directory that is not one (a symlink would point the build outside the clone);
 * parsed by jsonc.mjs and checked by task-config.mjs.
 *
 * The image is checked before any container is made of it (incident-platform backlog #0-284, ADR-0062 point 4 as
 * amended): buildImage is `devcontainer build --config <the build configuration> --image-name factory-task-<runId>`,
 * a call of its own, its name unique to the run; imageIdOf reads the image's ID from that name once; from there on
 * the image is named by its ID alone: checkImage holds its devcontainer.metadata label to the list (no lifecycle
 * command and no entry of the label runs before), environment.mjs records the ID in task.json, and upContainer is
 * `devcontainer up --config <the override> --workspace-folder <the clone> --id-label factory.task=<runId>`, the
 * override `{ image: <ID> }` with neither a build nor a feature (`--config`, not `--override-config`: see
 * upContainer and work-dir.mjs). Then the container is inspected and held to what the dispatcher asked for: its label,
 * its image the ID (a container of another image is refused), its HostConfig field by field to host-config.mjs's
 * closed table (not privileged, runc, its capabilities the configuration's, a feature's security options, Docker's
 * defaults for the rest), its mounts exactly the dispatcher's and the listed features' (so /opt/factory read-only, and
 * no mount the product or its image chose); and `timeout` must be in the image (a probe through it). A refusal names
 * a position, a count or an ID the daemon gave (hex), never a value it returned: a label's key, a mount's target, a
 * capability's name, a container's name are the agent's side's to choose (#0-284).
 *
 * execInTask: every call in the container is `docker exec ... /usr/bin/timeout -s TERM -k <grace>s <limit>s
 * <command>` (by its full path: #0-301, ADR-0064 point 2), since `docker exec` without a tty forwards no signal to
 * what it started (probed 2026-11-20). Past the limit (timeout's 124,
 * or 137 once it had to kill), or past the dispatcher's own timer (limit, grace and a margin), the task's containers
 * are killed by their label, the output is no longer read, and the call is a CallTimeoutError: the task ends BLOCKED
 * (callInTask).
 *
 * This module names factory's paths and touches no file: the dispatcher writes nothing in a directory of factory's
 * (AC10; test/child-process-static.test.mjs). The bundle a call hands over is task-bundle.mjs's.
 */
import { basename, posix } from 'node:path';

import { childEnv } from '../process/child-env.mjs';
import { MODES, blobOf, treeEntry } from '../product/base-tree.mjs';
import { blockTask } from '../state/tasks.mjs';
import { killTask } from './daemon.mjs';
import { parseJsonc } from './jsonc.mjs';
import { hostConfigViolations } from './host-config.mjs';
import { expectedMounts, mountKey } from './mounts.mjs';
import { TASK_LABEL, WORKSPACE, taskPaths } from './paths.mjs';
import { ContainerTimeoutError, StderrKeepError, mustRun, runContainerCommand, stderrNote } from './run-container.mjs';
import { checkImageMetadata, checkTaskConfig } from './task-config.mjs';

export { expectedMounts };

/** The container is not what the dispatcher asked for, or a file of the configuration is not in the base. */
export class TaskContainerError extends Error {}
/** A call in the container ran past its limit. */
export class CallTimeoutError extends Error {}

/** The longest `devcontainer build` may run, and the most of its stdout kept: a build's log. */
export const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
export const BUILD_MAX_OUTPUT = 64 * 1024 * 1024;
/** The longest `devcontainer up` may run, from an image built already, and the most of its stdout kept. */
export const UP_TIMEOUT_MS = 30 * 60 * 1000;
export const UP_MAX_OUTPUT = 64 * 1024 * 1024;
/** The dispatcher's margin past a call's limit and grace before it kills the task's containers itself. */
export const CALL_MARGIN_S = 30;
/** What `timeout` exits with when the limit was reached: TERM sufficed, or it had to KILL. */
const TIMED_OUT = new Set([124, 137]);

const SHA = /^[0-9a-f]{40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// taskImage: relative, not an option, no backslash, no control character, no `..` segment, a .json.
const TASK_IMAGE = /^(?!-)(?!\/)(?![\s\S]*(?:^|\/)\.\.(?:\/|$))[^\\\u0000-\u001f\u007f\u2028\u2029]+\.json$/;

const refuse = (message) => { throw new TaskContainerError(message); };

/** The lockfile devcontainer reads beside a configuration: `.devcontainer-lock.json` beside a dot file. */
export function lockPath(configPath) {
  const name = basename(configPath).startsWith('.') ? '.devcontainer-lock.json' : 'devcontainer-lock.json';
  const dir = posix.dirname(configPath);
  return dir === '.' ? name : `${dir}/${name}`;
}

/**
 * The task configuration at `path` in the base, checked: what the container is made of.
 *
 * @param {{ repoDir: string, base: string, path: string, git?: string }} options `git` for the tests only
 */
export async function readTaskConfig({ repoDir, base, path, git }) {
  if (!SHA.test(base ?? '')) {
    throw new TypeError('readTaskConfig: base must be 40 hex digits');
  }
  if (typeof path !== 'string' || !TASK_IMAGE.test(path) || path.split('/').some((s) => s === '' || s === '.')) {
    refuse('the adapter\'s taskImage must be a relative path to a .json in the product, not starting with -, never '
      + 'leaving it');
  }
  const config = parseJsonc(await blobOf({ repoDir, base, path, git, what: `the task configuration ${path}` }));
  const lockText = await blobOf({ repoDir, base, path: lockPath(path), git, what: lockPath(path), optional: true });
  const carried = checkTaskConfig(config, { configPath: path, lock: lockText === null ? null : parseJsonc(lockText) });
  await blobOf({ repoDir, base, path: carried.dockerfile, git, what: 'build.dockerfile' });
  if (carried.context !== '.') {
    const context = await treeEntry({ repoDir, base, path: carried.context, git });
    if (context?.type !== 'tree' || context.mode !== MODES.tree) {
      refuse('build.context is not a directory of the base (a symlink is refused)');
    }
  }
  return carried;
}

/**
 * The container `info` (docker container inspect's) held to what the dispatcher asked for (#0-284: its image the ID
 * recorded, its HostConfig to the closed table). A refusal names positions and counts, never a value of `info`.
 *
 * @param {object} info
 * @param {{ containerId: string, runId: string, carried: object, imageId: string }} options
 * @returns {string} its image's ID
 */
export function checkContainer(info, { containerId, runId, carried, imageId }) {
  if (!IMAGE_ID.test(imageId ?? '')) {
    throw new TypeError('checkContainer: imageId must be the recorded image, sha256:<64 hex>');
  }
  if (typeof info !== 'object' || info === null || info.Id !== containerId) {
    refuse('docker container inspect did not describe the container devcontainer up made');
  }
  if (info.Config?.Labels?.[TASK_LABEL] !== runId) {
    refuse(`the task container does not carry ${TASK_LABEL}=${runId}`);
  }
  if (!IMAGE_ID.test(info.Image ?? '')) {
    refuse('the task container\'s image is not an ID, sha256:<64 hex>');
  }
  if (info.Image !== imageId) {
    refuse(`the task container runs ${info.Image}, not the image checked and recorded for the task, ${imageId}`);
  }
  const mounts = Array.isArray(info.Mounts) ? info.Mounts : [];
  const have = mounts.map((m) => mountKey({ Type: m?.Type, Source: m?.Type === 'volume' ? m?.Name : m?.Source,
    Destination: m?.Destination, RW: m?.RW }));
  // Privilege and capabilities are HostConfig's, and so the table's alone (host-config.mjs).
  const want = expectedMounts(runId, carried);
  const wanted = want.map(mountKey);
  const unexpected = have.map((k, i) => ({ k, i })).filter(({ k }) => !wanted.includes(k)).map(({ i }) => i);
  const missing = want.filter((m, i) => !have.includes(wanted[i])).map((m) => m.Destination);
  if (unexpected.length > 0 || missing.length > 0 || have.length !== new Set(have).size) {
    // The missing ones are the dispatcher's own targets, so they are named; an unexpected one is the daemon's answer.
    refuse(`the task container's mounts are not the dispatcher's: ${[
      unexpected.length > 0 ? `${unexpected.length} unexpected, at Mounts[${unexpected.join('], [')}] (not named)` : '',
      missing.length > 0 ? `missing at ${missing.join(', ')}` : '',
      have.length !== new Set(have).size ? 'one twice' : ''].filter(Boolean).join('; ')}`);
  }
  const violations = hostConfigViolations(info.HostConfig, { runId, carried });
  if (violations.length > 0) {
    refuse(`the task container's HostConfig is not the dispatcher's: ${violations.join('; ')}`);
  }
  return info.Image;
}

async function inspectJson(args, what, { sudo, stateDir }) {
  const { stdout } = await mustRun({ program: 'docker', args, sudo, stateDir });
  try {
    return JSON.parse(stdout.toString('utf8'));
  } catch {
    return refuse(`${what} is not JSON`);
  }
}

/** The CLI's last line of stdout, its JSON outcome. */
function outcomeOf(stdout, what) {
  try {
    return JSON.parse(stdout.toString('utf8').trim().split('\n').at(-1));
  } catch {
    return refuse(`${what} did not end with its JSON outcome`);
  }
}

/**
 * `devcontainer build` of the task's image (#0-284): the build configuration (work-dir.mjs, writeBuildConfig) and
 * the image's name, factory-task-<runId>, unique to the run; a call of its own, which makes no container and runs no
 * lifecycle command.
 *
 * @param {{ runId: string, stateDir: string, sudo?: string }} options
 * @returns {Promise<string>} the image's name
 */
export async function buildImage({ runId, sudo, stateDir }) {
  const { work, buildConfig, image } = taskPaths(runId);
  const { stdout } = await mustRun({ program: 'devcontainer', sudo, stateDir, timeoutMs: BUILD_TIMEOUT_MS,
    outputLimit: BUILD_MAX_OUTPUT,
    args: ['build', '--config', buildConfig, '--workspace-folder', work, '--image-name', image, '--log-format',
      'json'] });
  const outcome = outcomeOf(stdout, 'devcontainer build');
  if (outcome?.outcome !== 'success') {
    refuse('devcontainer build did not report an image built');
  }
  return image;
}

/**
 * The ID of the image named `name`, read once (#0-284): from here on the image is named by it alone.
 *
 * @param {{ name: string, stateDir: string, sudo?: string }} options
 * @returns {Promise<string>} sha256:<64 hex>
 */
export async function imageIdOf({ name, sudo, stateDir }) {
  const { stdout } = await mustRun({ program: 'docker', sudo, stateDir,
    args: ['image', 'inspect', '--format', '{{.Id}}', name] });
  const id = stdout.toString('utf8').trim();
  if (!IMAGE_ID.test(id)) {
    refuse('docker image inspect did not give the built image\'s ID, sha256:<64 hex>');
  }
  return id;
}

/**
 * The image `imageId`'s devcontainer.metadata label held to the list (task-config.mjs, checkImageMetadata), before
 * any container is made of it (#0-284): a label off the list ends the task with no container of the task's.
 *
 * @param {{ imageId: string, carried: object, stateDir: string, sudo?: string }} options
 */
export async function checkImage({ imageId, carried, sudo, stateDir }) {
  if (!IMAGE_ID.test(imageId ?? '')) {
    throw new TypeError('checkImage: imageId must be sha256:<64 hex>');
  }
  const labels = await inspectJson(['image', 'inspect', '--format', '{{json .Config.Labels}}', imageId],
    'docker image inspect\'s answer', { sudo, stateDir });
  checkImageMetadata(labels?.['devcontainer.metadata'], { carried });
}

/**
 * `devcontainer up` of the task from the image `imageId`, checked and recorded before, its container checked; the
 * override, `{ image: <ID> }` and the container's fields, written before (work-dir.mjs).
 *
 * @param {{ runId: string, carried: object, imageId: string, stateDir: string, sudo?: string }} options
 * @returns {Promise<{ runId: string, id: string, imageId: string, remoteUser: string, stateDir: string }>} `stateDir`
 *   where the stderr of every call in the container is kept
 */
export async function upContainer({ runId, carried, imageId, sudo, stateDir }) {
  const { work, override } = taskPaths(runId);
  const { stdout } = await mustRun({ program: 'devcontainer', sudo, stateDir, timeoutMs: UP_TIMEOUT_MS,
    outputLimit: UP_MAX_OUTPUT,
    // `--config`, not `--override-config`: the CLI writes the features' lockfile beside the configuration file, which
    // with `--override-config` is the clone's .devcontainer/devcontainer.json, and `factory` may not write in the clone
    // (work-dir.mjs). The override's paths are absolute already, and the product's devcontainer.json is not read.
    args: ['up', '--config', override, '--workspace-folder', work, '--id-label', `${TASK_LABEL}=${runId}`,
      '--log-format', 'json'] });
  const outcome = outcomeOf(stdout, 'devcontainer up');
  if (outcome?.outcome !== 'success' || !CONTAINER_ID.test(outcome.containerId ?? '')) {
    refuse('devcontainer up did not report a container made');
  }
  const info = await inspectJson(['container', 'inspect', '--format', '{{json .}}', outcome.containerId],
    'docker container inspect\'s answer', { sudo, stateDir });
  const image = checkContainer(info, { containerId: outcome.containerId, runId, carried, imageId });
  return { runId, id: outcome.containerId, imageId: image, remoteUser: carried.remoteUser, stateDir };
}

/**
 * A call in the task container under `timeout`; a call past its limit kills the task's containers and is a
 * CallTimeoutError.
 *
 * @param {{ container: { runId: string, id: string, remoteUser: string, stateDir: string }, args: string[],
 *   limitS: number,
 *   graceS?: number, input?: Buffer | string, env?: Record<string, string>, outputLimit?: number, sudo?: string,
 *   marginS?: number }} options `env` what the call is given (names and literal values, no secret: they are
 *   arguments of sudo's); `marginS` the dispatcher's own margin past the limit and the grace
 * @returns {Promise<{ code: number, stdout: Buffer, stderrFile: string | null }>} the call's stderr kept in a file
 *   of the state, never returned (#0-284)
 */
export async function execInTask({
  container, args, limitS, graceS = 10, input, env = {}, outputLimit, sudo, marginS = CALL_MARGIN_S, stdoutFile,
}) {
  for (const n of [limitS, graceS]) {
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new TypeError('execInTask: limitS and graceS must be positive integers (seconds)');
    }
  }
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError('execInTask: args must be a command');
  }
  const set = childEnv({ allow: [], set: env, baseEnv: {} });
  const flags = Object.entries(set).flatMap(([name, value]) => {
    if (!ENV_NAME.test(name)) {
      throw new TypeError(`execInTask: ${name} is not a variable's name`);
    }
    return ['-e', `${name}=${value}`];
  });
  const result = await runContainerCommand({
    program: 'docker', sudo, stateDir: container.stateDir, input, outputLimit, stdoutFile,
    timeoutMs: (limitS + graceS + marginS) * 1000,
    onTimeout: () => killTask({ runId: container.runId, sudo, stateDir: container.stateDir }),
    args: ['exec', '-i', '--user', container.remoteUser, '-w', WORKSPACE, ...flags, container.id,
      '/usr/bin/timeout', '-s', 'TERM', '-k', `${graceS}s`, `${limitS}s`, ...args],
  }).catch((error) => {
    if (error instanceof ContainerTimeoutError) {
      throw new CallTimeoutError(`the call ${args[0]} in the task container ran past ${limitS} s and was killed: `
        + `${error.message}`);
    }
    throw error;
  });
  if (TIMED_OUT.has(result.code)) {
    await killTask({ runId: container.runId, sudo, stateDir: container.stateDir });
    throw new CallTimeoutError(`the call ${args[0]} in the task container ran past ${limitS} s (timeout's exit `
      + `${result.code}): its processes were ended`);
  }
  return result;
}

/**
 * A call through execInTask whose timeout, or whose stderr that could not be kept (fail closed: the VM's state is not
 * certain, review round 1 of factory#22, GEN-31), ends the task BLOCKED, with the reason.
 *
 * @returns {Promise<{ task: object, result: object | null }>}
 */
export async function callInTask({ stateDir, task, ...call }) {
  try {
    return { task, result: await execInTask(call) };
  } catch (error) {
    if (error instanceof CallTimeoutError || error instanceof StderrKeepError) {
      return { task: await blockTask(stateDir, task, error.message), result: null };
    }
    throw error;
  }
}

/** The probe of ADR-0062 point 6: the image holds `timeout`, which every call runs under. */
export async function probeTimeout({ container, sudo }) {
  const result = await execInTask({ container, args: ['true'], limitS: 30, graceS: 5, sudo });
  if (result.code !== 0) {
    refuse(`the task image cannot run a call under timeout (exit ${result.code}): the image must hold coreutils' `
      + `timeout (${stderrNote(result.stderrFile)})`);
  }
}

/** What the image needs to run a product's command from the base's blobs (product/commands.mjs). */
export const TRUSTED_TOOLS = Object.freeze(['sh', 'mktemp', 'tar', 'rm']);

/**
 * The probe of the tools the product's commands are run with (incident-platform backlog #0-278): a missing one is
 * found when the container is set up, not when the gate is run.
 */
export async function probeTools({ container, sudo }) {
  const result = await execInTask({ container, limitS: 30, graceS: 5, sudo,
    args: ['sh', '-c', 'for t in "$@"; do command -v -- "$t" >/dev/null || exit 1; done', 'probe', ...TRUSTED_TOOLS] });
  if (result.code !== 0) {
    refuse(`the task image cannot run the product's commands from the base (exit ${result.code}): the image must hold `
      + `${TRUSTED_TOOLS.join(', ')} (${stderrNote(result.stderrFile)})`);
  }
}
