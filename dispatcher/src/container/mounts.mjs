/**
 * The mounts the task container must have, exactly (incident-platform backlog #0-277 AC5; #0-284): the dispatcher's
 * and the listed features'. A volume by its name, a bind by its host path. task-container.mjs holds the container's
 * Mounts to them, host-config.mjs its HostConfig.Mounts.
 */
import { FACTORY_CHECKOUT, FACTORY_MOUNT, M2_VOLUME, WORKSPACE, taskPaths } from './paths.mjs';

/** The mounts the container must have, exactly: the dispatcher's and the listed features'. */
export function expectedMounts(runId, carried) {
  const { work, claudeVolume } = taskPaths(runId);
  const home = `/home/${carried.remoteUser}`;
  return [
    { Type: 'bind', Source: work, Destination: WORKSPACE, RW: true },
    { Type: 'bind', Source: FACTORY_CHECKOUT, Destination: FACTORY_MOUNT, RW: false },
    { Type: 'volume', Source: claudeVolume, Destination: `${home}/.claude`, RW: true },
    { Type: 'volume', Source: M2_VOLUME, Destination: `${home}/.m2`, RW: true },
    ...carried.features.flatMap((f) => (f.metadata.mounts ?? []).map((m) => ({
      Type: m.type, Source: m.source, Destination: m.target, RW: m.readonly !== true }))),
  ];
}
