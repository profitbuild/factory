/**
 * builder-app's settings, from the dispatcher's environment only (incident-platform ADR-0055; backlog #0-271): the
 * app's id, its installation's id and its key's path, so that no id sits in src/ (#0-271 AC4).
 *
 *   BUILDER_APP_ID=<the app's id>
 *   BUILDER_APP_INSTALLATION_ID=<its installation's id on profitbuild/incident-platform>
 *   BUILDER_APP_KEY=<absolute path of its private key>        (optional, DEFAULT_KEY_PATH)
 *
 * On the build VM they are written in /home/dispatcher/.config/factory/env (DISPATCHER_ENV_FILE), which Node itself
 * loads: `node --env-file=/home/dispatcher/.config/factory/env dispatcher/bin/check-app.mjs`. No parser of that file
 * is ours, and none is in a shell. A variable already set in the process's environment wins over the file's value.
 *
 * That file is trusted as code is. It can set NODE_OPTIONS (`--require`, for one), which runs code in the process
 * that reads the key before any check of ours runs; nothing here can check the file in time, since Node has loaded
 * it before this module exists. So only its owner may write it: the file 600, its directory 700, both the
 * dispatcher user's, which the deployment of step 4.2b checks (incident-platform backlog #0-272). And it never holds
 * a secret: its values go to process.env, which every child of the dispatcher inherits. The key's file is checked
 * here (checked-token.mjs, readAppKey).
 *
 * A variable with the prefix BUILDER_APP_ that is not one of the three is refused, since it is most likely one of them
 * misspelt. A refusal names the variable, never its value: should a secret be set there by mistake, it reaches no log.
 */
import { isAbsolute } from 'node:path';

/** Where the dispatcher's env file lives on the build VM, for `node --env-file`. */
export const DISPATCHER_ENV_FILE = '/home/dispatcher/.config/factory/env';
/** builder-app's key, when BUILDER_APP_KEY is not set. */
export const DEFAULT_KEY_PATH = '/home/dispatcher/.config/factory/builder-app.pem';

/** A builder-app setting is missing, malformed or unknown. */
export class ConfigError extends Error {}

const PREFIX = 'BUILDER_APP_';
const positiveInteger = (value) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const SETTINGS = {
  BUILDER_APP_ID: { field: 'appId', valid: positiveInteger, parse: Number, expected: 'a positive integer' },
  BUILDER_APP_INSTALLATION_ID: {
    field: 'installationId', valid: positiveInteger, parse: Number, expected: 'a positive integer',
  },
  BUILDER_APP_KEY: { field: 'keyPath', valid: isAbsolute, parse: String, expected: 'an absolute path' },
};
const REQUIRED = ['BUILDER_APP_ID', 'BUILDER_APP_INSTALLATION_ID'];

/**
 * builder-app's settings from `env`.
 *
 * @param {Record<string, string | undefined>} [env] process.env by default
 * @returns {{ appId: number, installationId: number, keyPath: string }}
 * @throws {ConfigError}
 */
export function readBuilderEnv(env = process.env) {
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith(PREFIX) && !SETTINGS[name]) {
      throw new ConfigError(`unknown variable ${name} (known: ${Object.keys(SETTINGS).join(', ')})`);
    }
  }
  const config = { keyPath: DEFAULT_KEY_PATH };
  for (const [name, spec] of Object.entries(SETTINGS)) {
    const value = env[name];
    if (value === undefined) {
      if (REQUIRED.includes(name)) {
        throw new ConfigError(`${name} is not set (on the build VM: node --env-file=${DISPATCHER_ENV_FILE})`);
      }
      continue;
    }
    if (!spec.valid(value)) {
      throw new ConfigError(`${name} must be ${spec.expected}`);
    }
    config[spec.field] = spec.parse(value);
  }
  return config;
}
