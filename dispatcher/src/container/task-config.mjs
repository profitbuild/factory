/**
 * The task container's configuration is the dispatcher's, from a task configuration the product ships for it
 * (incident-platform ADR-0062 point 4; backlog #0-277 AC9). The product's file, `taskImage` in its adapter, is read
 * from the base as data (task-container.mjs, `git show`), parsed by jsonc.mjs, and checked here against a closed list:
 *
 * - carried by rule: `build.dockerfile` and `build.context` (paths in the configuration's directory or under it;
 *   every other key of `build`, `options`, `args` and `target` among them, refused), `remoteUser` (the agents' user: a
 *   user's name, never root), `postCreateCommand` and `postStartCommand` (a string, or an array of strings; the
 *   object form is refused in v0);
 * - a closed set of values, from task-config-list.json (the dispatcher's): `capAdd`, `runArgs` (each argument
 *   whole), `containerEnv` (its keys; its values literal: no `${` at all, so no variable of the host's, and nothing
 *   shaped like a secret); `features`, by id, with their options and values from the list, at the digest the
 *   product's devcontainer-lock.json pins, which must be one the list holds;
 * - no carried string holds `${localEnv:...}`, its alias `${env:...}`, or `${localWorkspaceFolder}` (and
 *   `...Basename`): the host's environment and paths;
 * - refused: every other field, `initializeCommand`, `mounts`, `workspaceMount`, `containerUser`, `image`, `name`
 *   among them.
 * Two configurations are written from what was carried (#0-284, ADR-0062 point 4 as amended): imageBuildConfig's,
 * which `devcontainer build --config` reads (the build, with absolute paths into the task's clone, the features by
 * digest, and the users the features are installed for), and buildOverride's, which `devcontainer up --config` reads:
 * the image by its ID, never a build nor a feature (with either the CLI would build a new image over the one checked),
 * and what the container needs (the carried runtime fields, the dispatcher's mounts as `docker run` arguments, the
 * workspace, `updateRemoteUserUID: false`, `containerUser: root`). checkImageMetadata holds the built image's
 * `devcontainer.metadata` label to the same list, before any container is made of the image.
 *
 * A refusal names the field, never a value read from the product's file; of the image's label, which the build wrote
 * and the daemon returned, a refusal names an entry by its index and a key only when it is one of the list's or the
 * dispatcher's own, never one it found (#0-284).
 */
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { ConfigError, refuseSecretShaped } from '../config/settings.mjs';
import LIST from './task-config-list.json' with { type: 'json' };
import {
  FACTORY_CHECKOUT, FACTORY_MOUNT, M2_VOLUME, MANAGED_SETTINGS_MOUNT, MANAGED_SETTINGS_SOURCE, TOKEN_MOUNT, WORKSPACE,
  taskPaths,
} from './paths.mjs';

/** A task configuration, or an image's metadata, is off the list. */
export class TaskConfigError extends Error {}

const refuse = (message) => { throw new TaskConfigError(message); };

/** The fields carried by rule, and those whose values the list holds. */
export const CARRIED = Object.freeze(['build', 'remoteUser', 'postCreateCommand', 'postStartCommand', 'capAdd',
  'runArgs', 'containerEnv', 'features']);
const COMMANDS = ['postCreateCommand', 'postStartCommand'];
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** What reads the host: `${localEnv:X}`, its alias `${env:X}`, `${localWorkspaceFolder}` and `...Basename`. */
const HOST_VARIABLE = /\$\{\s*(?:(?:localEnv|env)\s*:|localWorkspaceFolder)/i;
// A path: relative, no backslash, no control character or line separator, not an option.
const PATH = /^(?!-)(?!\/)[^\\\u0000-\u001f\u007f\u2028\u2029]+$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);

/**
 * The list itself is checked once, at load: a malformed list is the factory's fault, and is refused loudly.
 *
 * @param {unknown} list
 * @returns {typeof LIST}
 */
export function checkList(list) {
  const strings = (value, what) => (Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '')
    ? value : refuse(`the list's ${what} is not a list of strings`));
  if (!isObject(list)) {
    refuse('the list is not an object');
  }
  const keys = Object.keys(list).filter((k) => k !== '$comment').sort();
  if (!isDeepStrictEqual(keys, ['capAdd', 'containerEnv', 'features', 'runArgs'])) {
    refuse(`the list holds ${keys.join(', ')}, not capAdd, containerEnv, features and runArgs`);
  }
  strings(list.capAdd, 'capAdd');
  strings(list.runArgs, 'runArgs');
  strings(list.containerEnv, 'containerEnv');
  if (!isObject(list.features)) {
    refuse('the list\'s features is not an object');
  }
  for (const [id, feature] of Object.entries(list.features)) {
    featureName(id);
    if (!isObject(feature) || !isDeepStrictEqual(Object.keys(feature).sort(), ['digests', 'options'])
      || !isObject(feature.options) || !isObject(feature.digests)) {
      refuse(`the list's feature ${id} is not { options, digests }`);
    }
    for (const [option, values] of Object.entries(feature.options)) {
      if (!Array.isArray(values) || values.length === 0) {
        refuse(`the list's feature ${id} option ${option} has no values`);
      }
    }
    for (const [digest, entry] of Object.entries(feature.digests)) {
      if (!DIGEST.test(digest) || !isObject(entry) || typeof entry.version !== 'string' || !isObject(entry.metadata)
        || own(entry.metadata, 'id')) {
        refuse(`the list's feature ${id} digest ${digest} is not { version, metadata }`);
      }
    }
  }
  return list;
}

checkList(LIST);

/** The list the dispatcher holds. */
export const TASK_CONFIG_LIST = LIST;

/** A feature's id is `<registry>/<path>:<major tag>`; its name is the part before the tag. */
function featureName(id) {
  const match = /^([a-z0-9.-]+(?:\/[a-z0-9._-]+)+):([0-9]+)$/.exec(id);
  return match ? match[1] : refuse(`a feature's id must be <registry>/<path>:<major>: ${JSON.stringify(id)} is not`);
}

/** Every string in `value` (deep), with where it is, so that a refusal names the field. */
function* stringsOf(value, where) {
  if (typeof value === 'string') {
    yield [value, where];
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      yield* stringsOf(v, `${where}[${i}]`);
    }
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      yield* stringsOf(v, `${where}.${k}`);
    }
  }
}

function noHostVariable(value, where) {
  for (const [string, at] of stringsOf(value, where)) {
    if (HOST_VARIABLE.test(string)) {
      refuse(`${at} names the host's environment or paths (\${localEnv:...}, \${env:...}, \${localWorkspaceFolder})`);
    }
  }
}

/** A path of the build, relative to the configuration's directory `dir`, in it or under it: the repository's path. */
function buildPath(value, what, dir) {
  if (typeof value !== 'string' || !PATH.test(value)) {
    refuse(`build.${what} must be a relative path in the configuration's directory`);
  }
  const path = posix.normalize(posix.join(dir, value)).replace(/\/$/, '');
  const inside = dir === '.' ? path !== '..' && !path.startsWith('../') : path === dir || path.startsWith(`${dir}/`);
  return inside ? path : refuse(`build.${what} leaves the configuration's directory`);
}

function command(value, what) {
  const valid = (typeof value === 'string' && value.trim() !== '')
    || (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== ''));
  return valid ? value : refuse(`${what} must be a command: a string, or an array of strings (the object form is `
    + 'refused in v0)');
}

function subset(value, allowed, what) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    refuse(`${what} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) {
    refuse(`${what} holds a value twice`);
  }
  for (const [i, v] of value.entries()) {
    if (!allowed.includes(v)) {
      refuse(`${what}[${i}] is not one of the list's (${allowed.join(', ')})`);
    }
  }
  return [...value];
}

/**
 * containerEnv's keys and values held to the list. `quoted` false (the image's label, #0-284): a refusal names a
 * key by its position and its value never, since what it found is the daemon's answer, not the product's file.
 */
function containerEnv(value, list, where = 'containerEnv', { quoted = true } = {}) {
  if (!isObject(value)) {
    refuse(`${where} must be an object`);
  }
  for (const [position, [found, v]] of Object.entries(value).entries()) {
    const key = quoted || list.containerEnv.includes(found) ? found : `<key ${position}>`;
    if (!list.containerEnv.includes(found)) {
      refuse(`${where}.${key} is not a key of the list's (${list.containerEnv.join(', ')})`);
    }
    if (typeof v !== 'string') {
      refuse(`${where}.${key} must be a string`);
    }
    if (v.includes('${')) {
      refuse(`${where}.${key} must be literal: no \${...}`);
    }
    try {
      refuseSecretShaped({ [`${where}.${key}`]: v });
    } catch (error) {
      if (error instanceof ConfigError) {
        refuse(`${where}.${key} holds a value shaped like a secret`);
      }
      throw error;
    }
  }
  return { ...value };
}

function remoteUser(value, where = 'remoteUser') {
  if (typeof value !== 'string' || !USER.test(value) || value === 'root') {
    refuse(`${where} must be the agents' user: a user's name, not root`);
  }
  return value;
}

/**
 * The lockfile's entry for the feature `id`: its digest, which the list must hold.
 *
 * @returns {string} sha256:<hex>
 */
function lockedDigest(id, lock, entry) {
  const locked = isObject(lock) && isObject(lock.features) && own(lock.features, id) ? lock.features[id] : null;
  if (!isObject(locked)) {
    refuse(`the feature ${id} is not in the product's devcontainer-lock.json`);
  }
  const name = featureName(id);
  const resolved = typeof locked.resolved === 'string' && locked.resolved.startsWith(`${name}@`)
    ? locked.resolved.slice(name.length + 1) : null;
  if (!DIGEST.test(resolved ?? '') || locked.integrity !== resolved) {
    refuse(`the lockfile's ${id} is not resolved to ${name}@sha256:<64 hex> with the same integrity`);
  }
  if (!own(entry.digests, resolved)) {
    refuse(`the lockfile pins ${id} at a digest the list does not hold (${Object.keys(entry.digests).join(', ')})`);
  }
  return resolved;
}

function features(value, lock, list) {
  if (!isObject(value)) {
    refuse('features must be an object');
  }
  return Object.entries(value).map(([id, options]) => {
    if (!own(list.features, id)) {
      refuse(`the feature ${JSON.stringify(id)} is not one of the list's (${Object.keys(list.features).join(', ')})`);
    }
    const entry = list.features[id];
    if (!isObject(options)) {
      refuse(`features.${id} must be an object of options`);
    }
    for (const [option, v] of Object.entries(options)) {
      if (!own(entry.options, option)) {
        refuse(`features.${id}.${option} is not an option of the list's`);
      }
      if (!entry.options[option].some((allowed) => isDeepStrictEqual(allowed, v))) {
        refuse(`features.${id}.${option} is not one of the list's values`);
      }
    }
    const digest = lockedDigest(id, lock, entry);
    return { id, ref: `${featureName(id)}@${digest}`, digest, options: { ...options },
      metadata: entry.digests[digest].metadata };
  });
}

/**
 * The task configuration `config` (parsed), at `configPath` in the product, checked against the list.
 *
 * @param {unknown} config
 * @param {{ configPath: string, lock?: unknown, list?: typeof LIST }} options `lock` the parsed devcontainer-lock.json
 *   beside the configuration (needed when it names a feature); `list` for the tests of the list's shape only
 * @returns {{ dockerfile: string, context: string, remoteUser: string, postCreateCommand?: string | string[],
 *   postStartCommand?: string | string[], capAdd: string[], runArgs: string[], containerEnv: Record<string, string>,
 *   features: { id: string, ref: string, digest: string, options: object, metadata: object }[] }} the paths the
 *   repository's
 */
export function checkTaskConfig(config, { configPath, lock = null, list = LIST }) {
  if (!isObject(config)) {
    refuse('the task configuration is not an object');
  }
  for (const key of Object.keys(config)) {
    if (!CARRIED.includes(key)) {
      refuse(`the field ${JSON.stringify(key)} is not carried (only ${CARRIED.join(', ')}; the dispatcher sets the `
        + 'mounts, the workspace and the container user itself)');
    }
  }
  noHostVariable(config, 'the configuration');
  const dir = posix.dirname(configPath);
  if (!isObject(config.build)) {
    refuse('build must be an object: the task image is built from the product\'s Dockerfile');
  }
  for (const key of Object.keys(config.build)) {
    if (key !== 'dockerfile' && key !== 'context') {
      refuse(`build.${key} is not carried (only build.dockerfile and build.context)`);
    }
  }
  const carried = {
    dockerfile: buildPath(config.build.dockerfile, 'dockerfile', dir),
    context: buildPath(config.build.context ?? '.', 'context', dir),
    remoteUser: remoteUser(config.remoteUser),
    capAdd: own(config, 'capAdd') ? subset(config.capAdd, list.capAdd, 'capAdd') : [],
    runArgs: own(config, 'runArgs') ? subset(config.runArgs, list.runArgs, 'runArgs') : [],
    containerEnv: own(config, 'containerEnv') ? containerEnv(config.containerEnv, list) : {},
    features: own(config, 'features') ? features(config.features, lock, list) : [],
  };
  for (const name of COMMANDS) {
    if (own(config, name)) {
      carried[name] = command(config[name], name);
    }
  }
  return carried;
}

/** The dispatcher's mounts, as `docker run` arguments: none of them is the image's metadata, so none outlives the run. */
export function dispatcherMounts(runId, user) {
  const { claudeVolume, tokenDir } = taskPaths(runId);
  return [
    `--mount=type=bind,source=${FACTORY_CHECKOUT},target=${FACTORY_MOUNT},readonly`,
    // The factory's managed settings, read-only on the whole of /etc/claude-code (#0-301, ADR-0064 point 1).
    `--mount=type=bind,source=${MANAGED_SETTINGS_SOURCE},target=${MANAGED_SETTINGS_MOUNT},readonly`,
    // The task's token's directory, read-only (#0-313): the one credential on the daemon, valid only through the
    // dispatcher's proxy and only while the run lives (ADR-0062 point 5 as amended).
    `--mount=type=bind,source=${tokenDir},target=${TOKEN_MOUNT},readonly`,
    `--mount=type=volume,source=${claudeVolume},target=/home/${user}/.claude`,
    `--mount=type=volume,source=${M2_VOLUME},target=/home/${user}/.m2`,
  ];
}

/** The users the dispatcher sets, in both configurations: the features are installed for them, and run as them. */
const USERS = { updateRemoteUserUID: false, containerUser: 'root' };

/**
 * The configuration `devcontainer build --config` reads (#0-284), as an object (written as strict JSON): the build
 * with absolute paths into the task's clone, the features by digest, and the users the features are installed for
 * (their scripts read `_REMOTE_USER` and `_CONTAINER_USER`). Nothing that runs: no lifecycle command, no
 * capability, no mount; those are the container's, in buildOverride's.
 *
 * @param {ReturnType<typeof checkTaskConfig>} carried
 * @param {{ runId: string }} options
 */
export function imageBuildConfig(carried, { runId }) {
  const { work } = taskPaths(runId);
  return {
    build: { dockerfile: `${work}/${carried.dockerfile}`, context: `${work}/${carried.context}` },
    features: Object.fromEntries(carried.features.map((f) => [f.ref, f.options])),
    remoteUser: carried.remoteUser,
    ...USERS,
  };
}

/**
 * The configuration `devcontainer up --config` reads, as an object (written as strict JSON): the image by its ID,
 * checked and recorded before (#0-284: a new task's and a resumed one's alike), the carried runtime fields and the
 * dispatcher's own. Never a build nor a feature: with either the CLI would build another image over the one checked.
 *
 * @param {ReturnType<typeof checkTaskConfig>} carried
 * @param {{ runId: string, imageId: string }} options
 */
export function buildOverride(carried, { runId, imageId }) {
  const { work } = taskPaths(runId);
  if (typeof imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new TypeError('buildOverride: imageId must be sha256:<64 hex>');
  }
  const override = { image: imageId };
  for (const name of COMMANDS) {
    if (own(carried, name)) {
      override[name] = carried[name];
    }
  }
  return {
    ...override,
    remoteUser: carried.remoteUser,
    capAdd: carried.capAdd,
    containerEnv: carried.containerEnv,
    runArgs: [...carried.runArgs, ...dispatcherMounts(runId, carried.remoteUser)],
    workspaceMount: `type=bind,source=${work},target=${WORKSPACE}`,
    workspaceFolder: WORKSPACE,
    ...USERS,
  };
}

/** The image's metadata fields the dispatcher sets, at the values it sets. */
const SET = USERS;

/**
 * Where a feature's entry of the label differs from what the list holds for it (#0-284 AC7): the list's keys whose
 * values differ or are missing, by name (the factory's own words), and how many keys the entry holds that the list
 * does not, by count alone (the label's, so the daemon's answer).
 */
function featureDifference(entry, metadata) {
  const differ = Object.keys(metadata)
    .filter((key) => !own(entry, key) || !isDeepStrictEqual(entry[key], metadata[key]));
  const foreign = Object.keys(entry).filter((key) => !own(metadata, key)).length;
  return { differ, foreign };
}

/**
 * The built image's `devcontainer.metadata` label (which `devcontainer up` merges into the container's
 * configuration, and which a Dockerfile's LABEL or the build cache can fill), held to the same list:
 * - an entry with an `id` is a feature's: the id names a feature of the override (its list id or its digest's
 *   reference), at most one entry per feature, and the entry, but its id, equals exactly, value by value, the
 *   metadata the list holds for the feature at the digest the lockfile pinned; any other content under that id is
 *   refused;
 * - any other entry holds only `remoteUser`, the commands, `capAdd` and `containerEnv` (each by the rules above) and
 *   the dispatcher's own fields at its own values.
 *
 * @param {string | undefined} label
 * @param {{ carried: ReturnType<typeof checkTaskConfig>, list?: typeof LIST }} options
 */
export function checkImageMetadata(label, { carried, list = LIST }) {
  if (label === undefined) {
    return [];
  }
  let entries;
  try {
    entries = JSON.parse(label);
  } catch {
    refuse('the image\'s devcontainer.metadata label is not JSON');
  }
  entries = Array.isArray(entries) ? entries : [entries];
  const seen = new Set();
  for (const [i, entry] of entries.entries()) {
    const where = `the image's devcontainer.metadata[${i}]`;
    if (!isObject(entry)) {
      refuse(`${where} is not an object`);
    }
    if (own(entry, 'id')) {
      const feature = carried.features.find((f) => entry.id === f.id || entry.id === f.ref);
      if (!feature) {
        refuse(`${where} is a feature's, and no feature of the configuration's`);
      }
      if (seen.has(feature.id)) {
        refuse(`${where} is a second entry of the feature ${feature.id}`);
      }
      seen.add(feature.id);
      const { id, ...rest } = entry;
      if (!isDeepStrictEqual(rest, feature.metadata)) {
        const { differ, foreign } = featureDifference(rest, feature.metadata);
        const differing = differ.length > 0 ? `the list's ${differ.join(', ')} differ${differ.length === 1 ? 's' : ''}`
          : 'no key of the list\'s differs';
        refuse(`${where}, the feature ${feature.id}'s, is not what the feature declares at ${feature.digest}: `
          + `${differing}; ${foreign} key${foreign === 1 ? '' : 's'} off the list (not named)`);
      }
      continue;
    }
    for (const [position, [key, value]] of Object.entries(entry).entries()) {
      if (own(SET, key)) {
        if (value !== SET[key]) {
          refuse(`${where}.${key} is not the dispatcher's value`);
        }
      } else if (key === 'remoteUser') {
        remoteUser(value, `${where}.remoteUser`);
      } else if (COMMANDS.includes(key)) {
        command(value, `${where}.${key}`);
        noHostVariable(value, `${where}.${key}`);
      } else if (key === 'capAdd') {
        subset(value, list.capAdd, `${where}.capAdd`);
      } else if (key === 'containerEnv') {
        containerEnv(value, list, `${where}.containerEnv`, { quoted: false });
      } else {
        refuse(`${where} holds a key off the list, its key ${position} (not named)`);
      }
    }
  }
  return entries;
}
