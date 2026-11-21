// The task container's HostConfig held to a closed table (incident-platform backlog #0-284 AC3, AC4; ADR-0062 point 6
// as amended): the HostConfig Docker 29.9.3 gives a container `devcontainer up` makes from the dispatcher's override
// passes; each field of the table set to a value neither the dispatcher's nor Docker's default is refused, naming the
// field and never the value; a field off the table is refused unless it holds its zero value, by its position and
// never its name; a run argument of the list with no rule of the table is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOST_CONFIG_FIELDS, MASKED_PATHS, hostConfigViolations } from '../src/container/host-config.mjs';
import { expectedMounts } from '../src/container/mounts.mjs';
import { checkTaskConfig } from '../src/container/task-config.mjs';
import { dockerDefaultHostConfig } from '../testing/docker-hostconfig.mjs';
import { CONFIG, CONFIG_PATH, LOCK } from '../testing/task-product.mjs';

const RUN_ID = '20261120T101500Z-3f9a1c';

/** The carried configuration as the generic product has it, with its lockfile. */
const carriedConfig = () => checkTaskConfig(CONFIG, { configPath: CONFIG_PATH, lock: LOCK });

/** The HostConfig the VM's Docker gives for the dispatcher's container: its defaults, and what the override set. */
function goodHostConfig(c = carriedConfig()) {
  return {
    ...dockerDefaultHostConfig(),
    CapAdd: c.capAdd.map((cap) => `CAP_${cap}`),
    SecurityOpt: c.features.flatMap((f) => f.metadata.securityOpt ?? []),
    ExtraHosts: c.runArgs.map((a) => a.slice('--add-host='.length)),
    Mounts: expectedMounts(RUN_ID, c).map((m) => ({ Type: m.Type, Source: m.Source, Target: m.Destination,
      ...(m.RW ? {} : { ReadOnly: true }) })),
  };
}

// Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
const SECRET = 'ghs' + `_${'h'.repeat(36)}`;

/** A value for `field` that is neither the dispatcher's nor Docker's default, holding the secret where it can. */
function wrong(field, value) {
  const special = {
    CapAdd: () => ['CAP_NET_ADMIN', `CAP_${SECRET}`],
    SecurityOpt: () => [...(value ?? []), `label=${SECRET}`],
    ExtraHosts: () => [...(value ?? []), `${SECRET}:10.0.0.1`],
    Mounts: () => [...value, { Type: 'bind', Source: '/', Target: `/${SECRET}` }],
    MaskedPaths: () => value.filter((p) => p !== '/proc/kcore'),
    ReadonlyPaths: () => [...value, `/${SECRET}`],
    LogConfig: () => ({ Type: 'json-file', Config: { tag: SECRET } }),
    RestartPolicy: () => ({ Name: 'always', MaximumRetryCount: 0 }),
    ConsoleSize: () => [24, 80],
    OomKillDisable: () => true,
    Init: () => true,
    PidsLimit: () => 100,
    MemorySwappiness: () => 60,
    Umask: () => 18,
  };
  if (Object.hasOwn(special, field)) {
    return special[field]();
  }
  if (typeof value === 'string') {
    return SECRET;
  }
  if (typeof value === 'number') {
    return value + 4096;
  }
  if (typeof value === 'boolean') {
    return !value;
  }
  if (Array.isArray(value) || value === null || value === undefined) {
    return [SECRET];
  }
  return { [SECRET]: SECRET };
}

test('#0-284: the HostConfig of the dispatcher\'s container on Docker 29.9.3 keeps the table', () => {
  assert.deepEqual(hostConfigViolations(goodHostConfig(), { runId: RUN_ID, carried: carriedConfig() }), []);
  // The forms Docker uses for an empty field across versions: null, [] or absent.
  const forms = { ...goodHostConfig(), Dns: null, Devices: null, Ulimits: null, PortBindings: null, CapDrop: [],
    OomKillDisable: null };
  delete forms.Annotations;
  assert.deepEqual(hostConfigViolations(forms, { runId: RUN_ID, carried: carriedConfig() }), []);
  // The per-CPU masked paths depend on the host: none, or several.
  const noCpu = { ...goodHostConfig(), MaskedPaths: [...MASKED_PATHS] };
  const cpus = { ...goodHostConfig(), MaskedPaths: [...MASKED_PATHS, '/sys/devices/system/cpu/cpu0/thermal_throttle',
    '/sys/devices/system/cpu/cpu15/thermal_throttle'] };
  for (const hostConfig of [noCpu, cpus]) {
    assert.deepEqual(hostConfigViolations(hostConfig, { runId: RUN_ID, carried: carriedConfig() }), []);
  }
});

test('#0-284: the table names every field of Docker 29.9.3\'s HostConfig, and the fake\'s defaults keep it', () => {
  const docker = Object.keys(dockerDefaultHostConfig());
  assert.deepEqual(docker.filter((f) => !HOST_CONFIG_FIELDS.includes(f)), [], 'a field of Docker\'s off the table');
  // The table's own fields beyond the defaults' are the omitempty ones and those the dispatcher sets.
  assert.deepEqual(HOST_CONFIG_FIELDS.filter((f) => !docker.includes(f)).sort(),
    ['Annotations', 'Init', 'Mounts', 'StorageOpt', 'Sysctls', 'Tmpfs', 'Umask'].sort());
});

for (const field of HOST_CONFIG_FIELDS) {
  test(`#0-284 AC3, AC4: HostConfig.${field} off the dispatcher's value and Docker's default is refused, naming the `
    + 'field and not the value', () => {
    const hostConfig = goodHostConfig();
    hostConfig[field] = wrong(field, hostConfig[field]);
    const found = hostConfigViolations(hostConfig, { runId: RUN_ID, carried: carriedConfig() });
    assert.deepEqual(found, [`HostConfig.${field} is neither what the dispatcher set nor Docker's default (its value `
      + 'is not quoted)']);
    assert.ok(found.every((line) => !line.includes('ghs_')), found.join());
  });
}

test('#0-284 AC3: a field off the table refuses the container unless it holds its zero value, by its position and not '
  + 'its name', () => {
  const hostConfig = goodHostConfig();
  for (const zero of [null, false, 0, '', [], {}]) {
    assert.deepEqual(hostConfigViolations({ ...hostConfig, NewInDocker30: zero }, { runId: RUN_ID,
      carried: carriedConfig() }), [], JSON.stringify(zero));
  }
  const keys = Object.keys(hostConfig).length;
  const found = hostConfigViolations({ ...hostConfig, [`Field${SECRET}`]: true, Other: 'x' },
    { runId: RUN_ID, carried: carriedConfig() });
  assert.deepEqual(found, [`HostConfig holds 2 fields off the dispatcher's table with a value other than its zero, at `
    + `positions ${keys}, ${keys + 1} of its keys (not named): a field a new Docker adds is given its rule in `
    + 'host-config.mjs first']);
  assert.deepEqual(hostConfigViolations('x', { runId: RUN_ID, carried: carriedConfig() }),
    ['the task container\'s HostConfig is not an object']);
});

test('#0-284 AC3: a run argument the table has no rule for is refused, before any field is read', () => {
  const c = carriedConfig();
  assert.deepEqual(hostConfigViolations(goodHostConfig(c), { runId: RUN_ID, carried: { ...c,
    runArgs: [...c.runArgs, '--network=host'] } }), ['a run argument of the configuration has no rule of HostConfig\'s '
    + 'table (host-config.mjs): the table must say what it sets before a task carries it']);
});

test('#0-284 AC3: the capabilities may be fewer than the configuration\'s, never more nor twice', () => {
  const c = carriedConfig();
  for (const caps of [null, [], ['CAP_NET_RAW'], ['NET_ADMIN', 'NET_RAW']]) {
    assert.deepEqual(hostConfigViolations({ ...goodHostConfig(c), CapAdd: caps }, { runId: RUN_ID, carried: c }), [],
      JSON.stringify(caps));
  }
  for (const caps of [['CAP_NET_RAW', 'CAP_NET_RAW'], ['CAP_SYS_ADMIN']]) {
    assert.equal(hostConfigViolations({ ...goodHostConfig(c), CapAdd: caps }, { runId: RUN_ID, carried: c }).length, 1);
  }
});

