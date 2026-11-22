/**
 * The mounts the task container must have, exactly (incident-platform backlog #0-277 AC5; #0-284): the dispatcher's
 * and the listed features'. A volume by its name, a bind by its host path. task-container.mjs holds the container's
 * Mounts to them, host-config.mjs its HostConfig.Mounts.
 */
import {
  FACTORY_CHECKOUT, FACTORY_MOUNT, M2_VOLUME, MANAGED_SETTINGS_MOUNT, MANAGED_SETTINGS_SOURCE, WORKSPACE, taskPaths,
} from './paths.mjs';

/**
 * The one key of a mount, whichever form docker gives it in (review round 1 of factory#22, ARC-02): the container's
 * Mounts and HostConfig.Mounts are each mapped to { Type, Source, Destination, RW } first, a volume by its name.
 */
export const mountKey = (m) => JSON.stringify([m?.Type, m?.Source, m?.Destination, m?.RW === true]);

/** The mounts the container must have, exactly: the dispatcher's and the listed features'. */
export function expectedMounts(runId, carried) {
  const { work, claudeVolume } = taskPaths(runId);
  const home = `/home/${carried.remoteUser}`;
  return [
    { Type: 'bind', Source: work, Destination: WORKSPACE, RW: true },
    { Type: 'bind', Source: FACTORY_CHECKOUT, Destination: FACTORY_MOUNT, RW: false },
    { Type: 'bind', Source: MANAGED_SETTINGS_SOURCE, Destination: MANAGED_SETTINGS_MOUNT, RW: false },
    { Type: 'volume', Source: claudeVolume, Destination: `${home}/.claude`, RW: true },
    { Type: 'volume', Source: M2_VOLUME, Destination: `${home}/.m2`, RW: true },
    ...carried.features.flatMap((f) => (f.metadata.mounts ?? []).map((m) => ({
      Type: m.type, Source: m.source, Destination: m.target, RW: m.readonly !== true }))),
  ];
}
