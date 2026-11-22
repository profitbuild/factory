/**
 * The task container's HostConfig, held field by field to a closed table (incident-platform backlog #0-284, ADR-0062
 * point 6 as amended): every field holds either the value the dispatcher set (through its override and the listed
 * features: the capabilities, the mounts, a feature's security options, the run arguments of the list) or Docker's
 * own default, and a field the table does not know must hold its zero value (null, false, 0, '', [] or {}), so a field
 * a new Docker adds stops the task loudly until the table names it. Never compared with a reference container: one
 * made on the same daemon would carry the daemon's daemon.json into the reference.
 *
 * Docker's defaults are Docker 29.9.3's (the build VM's), read from moby's source at the tag docker-v29.9.3:
 *  - the fields: api/types/container/hostconfig.go, HostConfig and Resources (a field with `omitempty` may be absent);
 *  - set at create (daemon/daemon_unix.go, adaptContainerSettings): ShmSize 64 MiB (config.DefaultShmSize), IpcMode
 *    private (config.DefaultIpcMode), CgroupnsMode private (cgroup v2), OomKillDisable false; (daemon/create.go)
 *    LogConfig merged with the daemon's (json-file, no options), an empty NetworkMode made the default, bridge; and
 *    SecurityOpt left as given when it holds a `label=` option (generateSecurityOpt), else SELinux's, none on the VM;
 *  - (daemon/create_unix.go) MaskedPaths and ReadonlyPaths, when not given, oci.DefaultSpec()'s
 *    (daemon/pkg/oci/defaults.go): the masked paths below, and one /sys/devices/system/cpu/cpu<N>/thermal_throttle for
 *    each possible CPU that has it, which depends on the host;
 *  - Runtime runc, the daemon's default runtime, DAEMON_DEFAULT_RUNTIME (checked in `docker info` before, daemon.mjs,
 *    checkDaemonOptions);
 *  - what the Docker CLI sends for `docker run` with no option: RestartPolicy "no", ConsoleSize [0, 0], empty lists.
 * The VM's container made with no option (2026-11-21): Runtime runc, SecurityOpt null, CgroupnsMode private, IpcMode
 * private, NetworkMode bridge. A field whose value Docker writes as null or as an empty list or object, by version, is
 * taken as either.
 * OomScoreAdj is not rootful Docker's constant 0 but a range, 0 to 1000: rootless Docker writes at start a value no
 * lower than its daemon's own oom_score_adj (200 on the VM, measured 2026-11-22, incident-platform backlog #0-284 AC8),
 * which the dispatcher does not read (the table's rule says why).
 *
 * A refusal names the table's field and never its value; a field off the table by its position among HostConfig's
 * keys, never its name: both are the daemon's answer.
 */
import { isDeepStrictEqual } from 'node:util';

import { DAEMON_DEFAULT_RUNTIME } from './daemon.mjs';
import { expectedMounts, mountKey } from './mounts.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** null, absent, [] or {}: the forms of an empty list or map across Docker's versions. */
const empty = (value) => value === undefined || value === null || (Array.isArray(value) && value.length === 0)
  || (isObject(value) && Object.keys(value).length === 0);
/** A field's zero value, which a field off the table must hold. */
const zero = (value) => empty(value) || value === false || value === 0 || value === '';
const is = (wanted) => (value) => value === wanted;
/** The same strings as `wanted`, each once, in any order; empty when `wanted` is. */
const sameSet = (value, wanted) => (wanted.length === 0 ? empty(value)
  : Array.isArray(value) && value.length === wanted.length && new Set(value).size === value.length
    && value.every((v) => wanted.includes(v)));

/** Docker 29.9.3's default masked paths (daemon/pkg/oci/defaults.go, defaultLinuxMaskedPaths), and the per-CPU ones. */
export const MASKED_PATHS = Object.freeze(['/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore',
  '/proc/keys', '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list', '/proc/timer_stats',
  '/sys/devices/virtual/powercap', '/sys/firmware']);
const CPU_MASKED = /^\/sys\/devices\/system\/cpu\/cpu[0-9]+\/thermal_throttle$/;
/** Docker 29.9.3's default read-only paths (the same file, DefaultLinuxSpec). */
export const READONLY_PATHS = Object.freeze(['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger']);
/** Docker's default shm size, 64 MiB (daemon/config, DefaultShmSize). */
export const SHM_SIZE = 64 * 1024 * 1024;

/**
 * What a run argument of the list sets in HostConfig: a run argument the list holds and this table does not is
 * refused, so a new one is given its rule here before a task can carry it.
 */
const RUN_ARG_RULES = [
  { pattern: /^--add-host=(.+)$/, field: 'ExtraHosts' },
];

/** HostConfig.Mounts as the CLI's --mount gives it: Type, Source (a volume's name), Target and ReadOnly when set. */
const configMountKey = (m) => mountKey({ Type: m?.Type, Source: m?.Source, Destination: m?.Target,
  RW: m?.ReadOnly !== true });

/**
 * What the dispatcher set, for the fields it sets: from the carried configuration and its features.
 *
 * @param {string} runId
 * @param {object} carried task-config.mjs's checkTaskConfig's
 */
export function dispatcherSet(runId, carried) {
  const extraHosts = [];
  for (const arg of carried.runArgs) {
    const rule = RUN_ARG_RULES.find((r) => r.pattern.test(arg));
    if (!rule) {
      return { error: 'a run argument of the configuration has no rule of HostConfig\'s table (host-config.mjs): the '
        + 'table must say what it sets before a task carries it' };
    }
    extraHosts.push(rule.pattern.exec(arg)[1]);
  }
  return {
    capAdd: [...new Set([...carried.capAdd, ...carried.features.flatMap((f) => f.metadata.capAdd ?? [])])],
    securityOpt: [...new Set(carried.features.flatMap((f) => f.metadata.securityOpt ?? []))],
    extraHosts,
    mounts: expectedMounts(runId, carried).map(mountKey).sort(),
  };
}

/**
 * HostConfig.CapAdd, the one rule of the capabilities (review round 1 of factory#22, ARC-02: checkContainer had a
 * second, narrower one): each the configuration's or a listed feature's, `CAP_` or not, each once. A refusal names the
 * positions of those off it, never a capability.
 */
function capAdd(value, set) {
  if (empty(value)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  const names = value.map((c) => (typeof c === 'string' ? c.replace(/^CAP_/, '') : null));
  const off = names.map((c, i) => ({ c, i })).filter(({ c }) => c === null || !set.capAdd.includes(c)).map(({ i }) => i);
  if (off.length > 0) {
    return `HostConfig.CapAdd adds ${off.length} capabilit${off.length === 1 ? 'y' : 'ies'} off the configuration's and `
      + `its features', at CapAdd[${off.join('], [')}] (not named)`;
  }
  return new Set(names).size === names.length ? true : 'HostConfig.CapAdd holds a capability twice (not named)';
}

/**
 * Each field of HostConfig the table knows: a test of its value, given what the dispatcher set. It gives true, false
 * (the field's refusal), or a refusal of its own that says more, by position, never by value.
 */
const TABLE = {
  // The dispatcher's.
  CapAdd: capAdd,
  SecurityOpt: (value, set) => sameSet(value, set.securityOpt),
  ExtraHosts: (value, set) => sameSet(value, set.extraHosts),
  Mounts: (value, set) => Array.isArray(value) && value.every((m) => isObject(m)
    && Object.keys(m).every((k) => ['Type', 'Source', 'Target', 'ReadOnly'].includes(k)))
    && isDeepStrictEqual(value.map(configMountKey).sort(), set.mounts),
  Binds: empty,
  // Docker's defaults (see above).
  Privileged: is(false),
  Runtime: is(DAEMON_DEFAULT_RUNTIME),
  NetworkMode: is('bridge'),
  IpcMode: is('private'),
  CgroupnsMode: is('private'),
  PidMode: is(''),
  UTSMode: is(''),
  UsernsMode: is(''),
  Cgroup: is(''),
  ShmSize: is(SHM_SIZE),
  LogConfig: (value) => isObject(value) && value.Type === 'json-file' && empty(value.Config)
    && Object.keys(value).every((k) => ['Type', 'Config'].includes(k)),
  RestartPolicy: (value) => isDeepStrictEqual(value, { Name: 'no', MaximumRetryCount: 0 }),
  ConsoleSize: (value) => isDeepStrictEqual(value, [0, 0]),
  MaskedPaths: (value) => Array.isArray(value) && new Set(value).size === value.length
    && MASKED_PATHS.every((p) => value.includes(p))
    && value.every((p) => MASKED_PATHS.includes(p) || CPU_MASKED.test(p)),
  ReadonlyPaths: (value) => sameSet(value, READONLY_PATHS),
  OomKillDisable: (value) => value === false || value === null || value === undefined,
  Init: (value) => value === false || value === null || value === undefined,
  AutoRemove: is(false),
  PublishAllPorts: is(false),
  ReadonlyRootfs: is(false),
  ContainerIDFile: is(''),
  VolumeDriver: is(''),
  Isolation: is(''),
  CgroupParent: is(''),
  CpusetCpus: is(''),
  CpusetMems: is(''),
  // A range, not rootful Docker's 0 (incident-platform backlog #0-284 AC8, measured on the VM 2026-11-22): rootless
  // Docker 29.9.3 writes at start a value no lower than its daemon's oom_score_adj, 200 there, since a process without
  // privilege cannot lower it; neither devcontainer, nor the feature, nor the dispatcher sets it. A higher value only
  // makes the container the kernel's likelier kill when memory runs out, so it weakens nothing; only a negative one,
  // which shields the container at the VM's cost, would, and rootless refuses it anyway. The exact value is the
  // daemon's, which the dispatcher does not read (that process and the systemd user unit of `factory` are the agent's
  // side, incident-platform #0-285), so the rule holds the range, not an equality. Anything not an integer (a string
  // too), null or absent is refused.
  OomScoreAdj: (value) => Number.isInteger(value) && value >= 0 && value <= 1000,
  CpuShares: is(0),
  Memory: is(0),
  NanoCpus: is(0),
  BlkioWeight: is(0),
  CpuPeriod: is(0),
  CpuQuota: is(0),
  CpuRealtimePeriod: is(0),
  CpuRealtimeRuntime: is(0),
  MemoryReservation: is(0),
  MemorySwap: is(0),
  CpuCount: is(0),
  CpuPercent: is(0),
  IOMaximumIOps: is(0),
  IOMaximumBandwidth: is(0),
  MemorySwappiness: (value) => value === null || value === undefined,
  PidsLimit: (value) => value === null || value === undefined || value === 0,
  Umask: (value) => value === null || value === undefined,
  PortBindings: empty,
  VolumesFrom: empty,
  Annotations: empty,
  CapDrop: empty,
  Dns: empty,
  DnsOptions: empty,
  DnsSearch: empty,
  GroupAdd: empty,
  Links: empty,
  StorageOpt: empty,
  Tmpfs: empty,
  Sysctls: empty,
  BlkioWeightDevice: empty,
  BlkioDeviceReadBps: empty,
  BlkioDeviceWriteBps: empty,
  BlkioDeviceReadIOps: empty,
  BlkioDeviceWriteIOps: empty,
  Devices: empty,
  DeviceCgroupRules: empty,
  DeviceRequests: empty,
  Ulimits: empty,
};

/** The fields the table knows, for the tests and the README. */
export const HOST_CONFIG_FIELDS = Object.freeze(Object.keys(TABLE));

/**
 * Where `hostConfig` breaks the table: a list of refusals, empty when it keeps it. Each names a field of the table, or
 * the positions of fields off it, never a value.
 *
 * @param {unknown} hostConfig docker container inspect's HostConfig
 * @param {{ runId: string, carried: object }} options
 * @returns {string[]}
 */
export function hostConfigViolations(hostConfig, { runId, carried }) {
  if (!isObject(hostConfig)) {
    return ['the task container\'s HostConfig is not an object'];
  }
  const set = dispatcherSet(runId, carried);
  if (set.error) {
    return [set.error];
  }
  const found = [];
  for (const [field, test] of Object.entries(TABLE)) {
    const verdict = test(hostConfig[field], set);
    if (typeof verdict === 'string') {
      found.push(verdict);
    } else if (!verdict) {
      found.push(`HostConfig.${field} is neither what the dispatcher set nor Docker's default (its value is not `
        + 'quoted)');
    }
  }
  const off = Object.keys(hostConfig).map((key, position) => ({ key, position }))
    .filter(({ key }) => !Object.hasOwn(TABLE, key) && !zero(hostConfig[key]));
  if (off.length > 0) {
    found.push(`HostConfig holds ${off.length} field${off.length === 1 ? '' : 's'} off the dispatcher's table with a `
      + `value other than its zero, at position${off.length === 1 ? '' : 's'} ${off.map((o) => o.position).join(', ')} `
      + 'of its keys (not named): a field a new Docker adds is given its rule in host-config.mjs first');
  }
  return found;
}
