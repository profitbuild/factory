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
 * Everything read from docker's output is untrusted: an id, a name, each line is held to a pattern, or refused; a
 * name is quoted in a refusal only when it is one.
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

const docker = (args, { sudo, input } = {}) => mustRun({ program: 'docker', args, input, sudo });

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

const listed = (items) => items.map(({ id, name }) => `${name} (${id.slice(0, 12)})`).join(', ');

/** Every container of the daemon, running or not, or those with `filter`. */
export async function containers({ sudo, filter = [], all = true } = {}) {
  return idsAndNames((await docker(['ps', ...(all ? ['-a'] : []), '--no-trunc', ...filter.flatMap((f) => ['--filter', f]),
    '--format', '{{.ID}} {{.Names}}'], { sudo })).stdout, 'containers');
}

/** The daemon's user-defined networks, or those with `filter`. */
export async function networks({ sudo, filter = ['type=custom'] } = {}) {
  return idsAndNames((await docker(['network', 'ls', '--no-trunc', ...filter.flatMap((f) => ['--filter', f]),
    '--format', '{{.ID}} {{.Name}}'], { sudo })).stdout, 'networks')
    .filter(({ name }) => !BUILTIN_NETWORKS.has(name));
}

/** The daemon's volumes, or those with `filter`. */
export async function volumes({ sudo, filter = [] } = {}) {
  return names((await docker(['volume', 'ls', ...filter.flatMap((f) => ['--filter', f]), '--format', '{{.Name}}'],
    { sudo })).stdout, 'volumes');
}

/** The running containers labelled `factory.rollback`. */
export function runningRollbacks({ sudo } = {}) {
  return containers({ sudo, all: false, filter: [`label=${ROLLBACK_LABEL}`] });
}

/**
 * Refuses when a running container carries `factory.rollback`, naming it and the sweep.
 *
 * @param {{ sudo?: string, when: string }} options `when`: which check this is, for the refusal
 */
export async function refuseWhileRollback({ sudo, when }) {
  const found = await runningRollbacks({ sudo });
  if (found.length > 0) {
    throw new RollbackRunningError(`${when}: a running container carries ${ROLLBACK_LABEL}: ${listed(found)}. If it is `
      + 'a rollback, end it (its container stopped) before the next run; if it is not (a killed run left it), clear it '
      + `with \`${SWEEP_COMMAND} --force\``);
  }
}

/**
 * Removes every container, user-defined network and volume of the daemon but factory-dispatcher-m2, in that order,
 * then every work directory, and checks that nothing is left.
 *
 * @param {{ runId: string, helperImage: string, sudo?: string }} options `runId` labels the helper
 * @returns {Promise<{ containers: string[], networks: string[], volumes: string[] }>} what was removed, by name
 */
export async function sweepDaemon({ runId, helperImage, sudo }) {
  const removed = { containers: [], networks: [], volumes: [] };
  const found = await containers({ sudo });
  if (found.length > 0) {
    await docker(['rm', '-f', '-v', ...found.map(({ id }) => id)], { sudo });
    removed.containers = found.map(({ name }) => name);
  }
  const nets = await networks({ sudo });
  if (nets.length > 0) {
    await docker(['network', 'rm', ...nets.map(({ id }) => id)], { sudo });
    removed.networks = nets.map(({ name }) => name);
  }
  const vols = (await volumes({ sudo })).filter((name) => name !== M2_VOLUME);
  if (vols.length > 0) {
    await docker(['volume', 'rm', ...vols], { sudo });
    removed.volumes = vols;
  }
  await removeAllWorkDirs({ runId, image: helperImage, sudo });
  await checkSwept({ sudo });
  return removed;
}

/** No container, no user-defined network, no volume but factory-dispatcher-m2: or a SweepError naming what is left. */
export async function checkSwept({ sudo } = {}) {
  const left = [];
  const c = await containers({ sudo });
  if (c.length > 0) {
    left.push(`containers ${listed(c)}`);
  }
  const n = await networks({ sudo });
  if (n.length > 0) {
    left.push(`networks ${listed(n)}`);
  }
  const v = (await volumes({ sudo })).filter((name) => name !== M2_VOLUME);
  if (v.length > 0) {
    left.push(`volumes ${v.join(', ')}`);
  }
  if (left.length > 0) {
    throw new SweepError(`the sweep left ${left.join('; ')} on factory's daemon: the run is refused until `
      + `\`${SWEEP_COMMAND}\` leaves it empty`);
  }
}

/** The task's network, labelled with the run: the run is visible from here on. */
export async function createTaskNetwork({ runId, sudo }) {
  const { network } = taskPaths(runId);
  await docker(['network', 'create', '--label', `${TASK_LABEL}=${runId}`, network], { sudo });
  return network;
}

/** The task's volumes: its own ~/.claude, labelled with the run, and the shared ~/.m2 cache (made once, kept). */
export async function createTaskVolumes({ runId, sudo }) {
  const { claudeVolume } = taskPaths(runId);
  await docker(['volume', 'create', '--label', `${TASK_LABEL}=${runId}`, claudeVolume], { sudo });
  await docker(['volume', 'create', M2_VOLUME], { sudo });
}

/** Removes what carries the run's label alone: its containers, then its networks, then its volumes. */
export async function removeOwnObjects({ runId, sudo }) {
  const label = `label=${TASK_LABEL}=${runId}`;
  const c = await containers({ sudo, filter: [label] });
  if (c.length > 0) {
    await docker(['rm', '-f', '-v', ...c.map(({ id }) => id)], { sudo });
  }
  const n = await networks({ sudo, filter: [label] });
  if (n.length > 0) {
    await docker(['network', 'rm', ...n.map(({ id }) => id)], { sudo });
  }
  const v = await volumes({ sudo, filter: [label] });
  if (v.length > 0) {
    await docker(['volume', 'rm', ...v], { sudo });
  }
}

/** Kills the running containers that carry the run's label (a call past its time). */
export async function killTask({ runId, sudo }) {
  const c = await containers({ sudo, all: false, filter: [`label=${TASK_LABEL}=${runId}`] });
  if (c.length > 0) {
    await docker(['kill', ...c.map(({ id }) => id)], { sudo });
  }
  return c.map(({ name }) => name);
}
