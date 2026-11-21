/**
 * `factory`'s daemon, shared with the rollback by time (incident-platform ADR-0062 points 5 and 7; backlog #0-277
 * AC3, AC12, AC13). No credential lives on that daemon while the dispatcher runs: a test with the Docker socket can
 * mount any volume of it.
 *
 * - runningRollbacks: the running containers that carry the label `factory.rollback` (any value). A label is
 *   positive, never inferred from its absence: an unlabelled container is a killed run's leftover, which a sweep
 *   removes, never a rollback;
 * - sweepDaemon: every container of the daemon (`rm -f -v`, its anonymous volumes with it), then every user-defined
 *   network (bridge, host and none stay), then every volume but factory-dispatcher-m2 (in that order: `docker volume
 *   rm` refuses a volume a stopped container still uses), then the work directories (a helper, work-dir.mjs); and its
 *   result checked: no container, no user-defined network, no volume but factory-dispatcher-m2, or a SweepError
 *   naming what is left;
 * - createTaskNetwork: the task's network, labelled `factory.task=<runId>`: the run made visible to a rollback that
 *   starts (incident-platform's rollback-start.sh refuses while an object with that label exists). No container
 *   joins it;
 * - removeOwnObjects: only what carries the run's label, for a run that a rollback stops after its network exists:
 *   then the rollback is running, and the daemon is not the run's to sweep.
 * - checkDaemonOptions (#0-284, ADR-0062 points 4 and 6): `docker info`'s security options and default runtime,
 *   exactly the VM's (rootless, seccomp's builtin profile, cgroup namespaces; runc), checked before the first container
 *   of a run or of `cli.mjs sweep`, the sweep's helper included (review round 1 of factory#22, the owner's decision
 *   1): a daemon off them is every task's, so the run is refused, and no container is made on it, nor a sweep's.
 * Everything read from docker's output is untrusted: an id, a name, each line is held to a pattern, or refused. A
 * refusal names what it found by the IDs the daemon gave (hex) and counts, never by a name (#0-284: a container's,
 * a network's or a volume's name is the agent's side's to choose, and could carry what it read); only the rollback's
 * refusal still names the containers, until M4 removes the rollback. Every call is the starter's, its stderr kept in
 * $FACTORY_STATE_DIR (run-container.mjs), so every function takes `stateDir`.
 */
import {
  DISPATCHER_ENV_FILE, FACTORY_CHECKOUT, M2_VOLUME, ROLLBACK_LABEL, TASK_LABEL, taskPaths,
} from './paths.mjs';
import { mustRun } from './run-container.mjs';
import { removeAllWorkDirs } from './work-dir.mjs';

/** A rollback is running: the run is refused. */
export class RollbackRunningError extends Error {}
/** The sweep did not leave the daemon empty. */
export class SweepError extends Error {}
/** docker's output is not what was asked for. */
export class DockerOutputError extends Error {}

const ID = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);

/**
 * The cleanup a refusal names, the dispatcher's sweep alone, as it runs pasted on the VM: with the env file, from the
 * checkout the dispatcher runs from (ADR-0062 point 3; review round 1 gen-9a47).
 */
export const SWEEP_COMMAND = `node --env-file=${DISPATCHER_ENV_FILE} ${FACTORY_CHECKOUT}/dispatcher/src/cli.mjs sweep`;

const docker = (args, { sudo, stateDir, input } = {}) => mustRun({ program: 'docker', args, input, sudo, stateDir });

/** Lines of `<id> <name>`, each held to the patterns. */
function idsAndNames(stdout, what) {
  return stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
    const [id, name, ...rest] = line.split(' ');
    if (!ID.test(id ?? '') || !NAME.test(name ?? '') || rest.length > 0) {
      throw new DockerOutputError(`docker's list of ${what} holds a line that is not "<id> <name>"`);
    }
    return { id, name };
  });
}

function names(stdout, what) {
  return stdout.toString('utf8').split('\n').filter(Boolean).map((name) => {
    if (!NAME.test(name)) {
      throw new DockerOutputError(`docker's list of ${what} holds a line that is not a name`);
    }
    return name;
  });
}

/** The rollback's refusal's form, unchanged until M4 removes the rollback: each container's name and short ID. */
const listedByName = (items) => items.map(({ id, name }) => `${name} (${id.slice(0, 12)})`).join(', ');
/** Every other refusal's (#0-284): how many, and the daemon's IDs, short; never a name. */
const listed = (items) => `${items.length} (${items.map(({ id }) => id.slice(0, 12)).join(', ')})`;

/** Every container of the daemon, running or not, or those with `filter`. */
export async function containers({ sudo, stateDir, filter = [], all = true } = {}) {
  return idsAndNames((await docker(['ps', ...(all ? ['-a'] : []), '--no-trunc', ...filter.flatMap((f) => ['--filter', f]),
    '--format', '{{.ID}} {{.Names}}'], { sudo, stateDir })).stdout, 'containers');
}

/** The daemon's user-defined networks, or those with `filter`. */
export async function networks({ sudo, stateDir, filter = ['type=custom'] } = {}) {
  return idsAndNames((await docker(['network', 'ls', '--no-trunc', ...filter.flatMap((f) => ['--filter', f]),
    '--format', '{{.ID}} {{.Name}}'], { sudo, stateDir })).stdout, 'networks')
    .filter(({ name }) => !BUILTIN_NETWORKS.has(name));
}

/** The daemon's volumes, or those with `filter`. */
export async function volumes({ sudo, stateDir, filter = [] } = {}) {
  return names((await docker(['volume', 'ls', ...filter.flatMap((f) => ['--filter', f]), '--format', '{{.Name}}'],
    { sudo, stateDir })).stdout, 'volumes');
}

/** The running containers labelled `factory.rollback`. */
export function runningRollbacks({ sudo, stateDir } = {}) {
  return containers({ sudo, stateDir, all: false, filter: [`label=${ROLLBACK_LABEL}`] });
}

/**
 * Refuses when a running container carries `factory.rollback`, naming it and the sweep.
 *
 * @param {{ stateDir: string, sudo?: string, when: string }} options `when`: which check this is, for the refusal
 */
export async function refuseWhileRollback({ sudo, stateDir, when }) {
  const found = await runningRollbacks({ sudo, stateDir });
  if (found.length > 0) {
    throw new RollbackRunningError(`${when}: a running container carries ${ROLLBACK_LABEL}: ${listedByName(found)}. `
      + 'If it is a rollback, end it (its container stopped) before the next run; if it is not (a killed run left it), '
      + 'clear it '
      + `with \`${SWEEP_COMMAND} --force\``);
  }
}

/**
 * Removes every container, user-defined network and volume of the daemon but factory-dispatcher-m2, in that order,
 * then every work directory, and checks that nothing is left.
 *
 * @param {{ runId: string, helperImage: string, stateDir: string, sudo?: string }} options `runId` labels the helper
 * @returns {Promise<{ containers: string[], networks: string[], volumes: number }>} what was removed: the containers
 *   and the networks by the daemon's IDs, short, and how many volumes, never a name (#0-284, review round 1 of
 *   factory#22: `cli.mjs sweep` prints it)
 */
export async function sweepDaemon({ runId, helperImage, stateDir, sudo }) {
  const removed = { containers: [], networks: [], volumes: 0 };
  const short = (items) => items.map(({ id }) => id.slice(0, 12));
  const found = await containers({ sudo, stateDir });
  if (found.length > 0) {
    await docker(['rm', '-f', '-v', ...found.map(({ id }) => id)], { sudo, stateDir });
    removed.containers = short(found);
  }
  const nets = await networks({ sudo, stateDir });
  if (nets.length > 0) {
    await docker(['network', 'rm', ...nets.map(({ id }) => id)], { sudo, stateDir });
    removed.networks = short(nets);
  }
  const vols = (await volumes({ sudo, stateDir })).filter((name) => name !== M2_VOLUME);
  if (vols.length > 0) {
    await docker(['volume', 'rm', ...vols], { sudo, stateDir });
    removed.volumes = vols.length;
  }
  await removeAllWorkDirs({ runId, image: helperImage, sudo, stateDir });
  await checkSwept({ sudo, stateDir });
  return removed;
}

/**
 * No container, no user-defined network, no volume but factory-dispatcher-m2: or a SweepError saying what is left,
 * containers and networks by count and the daemon's IDs, volumes by count (a volume has no ID but its name), never a
 * name (#0-284).
 */
export async function checkSwept({ sudo, stateDir } = {}) {
  const left = [];
  const c = await containers({ sudo, stateDir });
  if (c.length > 0) {
    left.push(`containers ${listed(c)}`);
  }
  const n = await networks({ sudo, stateDir });
  if (n.length > 0) {
    left.push(`networks ${listed(n)}`);
  }
  const v = (await volumes({ sudo, stateDir })).filter((name) => name !== M2_VOLUME);
  if (v.length > 0) {
    left.push(`volumes ${v.length} (by count: a volume's name is not quoted)`);
  }
  if (left.length > 0) {
    throw new SweepError(`the sweep left ${left.join('; ')} on factory's daemon: the run is refused until `
      + `\`${SWEEP_COMMAND}\` leaves it empty`);
  }
}

/** The task's network, labelled with the run: the run is visible from here on. */
export async function createTaskNetwork({ runId, sudo, stateDir }) {
  const { network } = taskPaths(runId);
  await docker(['network', 'create', '--label', `${TASK_LABEL}=${runId}`, network], { sudo, stateDir });
  return network;
}

/** The task's volumes: its own ~/.claude, labelled with the run, and the shared ~/.m2 cache (made once, kept). */
export async function createTaskVolumes({ runId, sudo, stateDir }) {
  const { claudeVolume } = taskPaths(runId);
  await docker(['volume', 'create', '--label', `${TASK_LABEL}=${runId}`, claudeVolume], { sudo, stateDir });
  await docker(['volume', 'create', M2_VOLUME], { sudo, stateDir });
}

/** Removes what carries the run's label alone: its containers, then its networks, then its volumes. */
export async function removeOwnObjects({ runId, sudo, stateDir }) {
  const label = `label=${TASK_LABEL}=${runId}`;
  const c = await containers({ sudo, stateDir, filter: [label] });
  if (c.length > 0) {
    await docker(['rm', '-f', '-v', ...c.map(({ id }) => id)], { sudo, stateDir });
  }
  const n = await networks({ sudo, stateDir, filter: [label] });
  if (n.length > 0) {
    await docker(['network', 'rm', ...n.map(({ id }) => id)], { sudo, stateDir });
  }
  const v = await volumes({ sudo, stateDir, filter: [label] });
  if (v.length > 0) {
    await docker(['volume', 'rm', ...v], { sudo, stateDir });
  }
}

/** Kills the running containers that carry the run's label (a call past its time). */
export async function killTask({ runId, sudo, stateDir }) {
  const c = await containers({ sudo, stateDir, all: false, filter: [`label=${TASK_LABEL}=${runId}`] });
  if (c.length > 0) {
    await docker(['kill', ...c.map(({ id }) => id)], { sudo, stateDir });
  }
  return c.map(({ name }) => name);
}

/** What factory's daemon must report (#0-284, ADR-0062 point 6 as amended): the build VM's, Docker 29.9.3's there. */
export const DAEMON_SECURITY_OPTIONS = Object.freeze(['name=seccomp,profile=builtin', 'name=rootless',
  'name=cgroupns']);
export const DAEMON_DEFAULT_RUNTIME = 'runc';

/** The daemon's options are not the VM's: no container is made on it, a sweep's helper included. */
export class DaemonOptionsError extends Error {}

/**
 * `docker info`'s SecurityOptions, exactly DAEMON_SECURITY_OPTIONS (in any order, each once), and its DefaultRuntime,
 * runc: a daemon that is not rootless, has seccomp off or another profile, or another runtime by default, is refused
 * before any container is made on it. What the daemon reported is not quoted: the refusal says which rule failed and
 * how many entries it found.
 *
 * @param {{ stateDir: string, sudo?: string }} options
 */
export async function checkDaemonOptions({ stateDir, sudo }) {
  const { stdout } = await docker(['info', '--format', '{{json .}}'], { sudo, stateDir });
  let info;
  try {
    info = JSON.parse(stdout.toString('utf8'));
  } catch {
    throw new DockerOutputError('docker info\'s answer is not JSON');
  }
  const options = info?.SecurityOptions;
  if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) {
    throw new DaemonOptionsError('factory\'s daemon reports no list of security options: no container is made on it');
  }
  const missing = DAEMON_SECURITY_OPTIONS.filter((o) => !options.includes(o));
  const other = options.filter((o) => !DAEMON_SECURITY_OPTIONS.includes(o)).length;
  const twice = new Set(options).size !== options.length;
  if (missing.length > 0 || other > 0 || twice) {
    throw new DaemonOptionsError(`factory's daemon's security options are not the VM's (${DAEMON_SECURITY_OPTIONS
      .join('; ')}): ${missing.length > 0 ? `missing ${missing.join('; ')}` : 'none missing'}, ${other} other `
      + `entr${other === 1 ? 'y' : 'ies'} (not quoted)${twice ? ', one twice' : ''}: no container is made on it`);
  }
  if (info.DefaultRuntime !== DAEMON_DEFAULT_RUNTIME) {
    throw new DaemonOptionsError(`factory's daemon's default runtime is not ${DAEMON_DEFAULT_RUNTIME} (what it reports `
      + 'is not quoted): no container is made on it');
  }
}
