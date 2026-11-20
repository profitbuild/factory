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
 * The mechanism is settings.mjs's, shared with FACTORY_* (factory-env.mjs, #0-275).
 */
import { isAbsolute } from 'node:path';

import { ConfigError, positiveInteger, readSettings } from './settings.mjs';

export { ConfigError };

/** Where the dispatcher's env file lives on the build VM, for `node --env-file`. */
export const DISPATCHER_ENV_FILE = '/home/dispatcher/.config/factory/env';
/** builder-app's key, when BUILDER_APP_KEY is not set. */
export const DEFAULT_KEY_PATH = '/home/dispatcher/.config/factory/builder-app.pem';

const GROUP = {
  prefix: 'BUILDER_APP_',
  settings: {
    BUILDER_APP_ID: { field: 'appId', valid: positiveInteger, parse: Number, expected: 'a positive integer' },
    BUILDER_APP_INSTALLATION_ID: {
      field: 'installationId', valid: positiveInteger, parse: Number, expected: 'a positive integer',
    },
    BUILDER_APP_KEY: { field: 'keyPath', valid: isAbsolute, parse: String, expected: 'an absolute path' },
  },
  required: ['BUILDER_APP_ID', 'BUILDER_APP_INSTALLATION_ID'],
  defaults: { keyPath: DEFAULT_KEY_PATH },
  missingHint: ` (on the build VM: node --env-file=${DISPATCHER_ENV_FILE})`,
};

/**
 * builder-app's settings from `env`.
 *
 * @param {Record<string, string | undefined>} [env] process.env by default
 * @returns {{ appId: number, installationId: number, keyPath: string }}
 * @throws {ConfigError}
 */
export function readBuilderEnv(env = process.env) {
  return readSettings(env, GROUP);
}
