/**
 * The dispatcher's env file (incident-platform backlog #0-271): where builder-app's id, its installation's id and its
 * key's path come from, so that no id sits in src/ (#0-271 AC4). It is read here, never loaded into process.env, which
 * every child would inherit.
 *
 * The format is a subset of systemd's EnvironmentFile: `KEY=value` lines, `#` comments and blank lines; no quotes, no
 * `export`, no expansion.
 *
 *   BUILDER_APP_ID=<the app's id>
 *   BUILDER_APP_INSTALLATION_ID=<its installation's id on profitbuild/incident-platform>
 *   BUILDER_APP_KEY=<absolute path of its private key>        (optional, DEFAULT_KEY_PATH)
 *
 * A key other dispatcher settings use is ignored, so later steps add theirs; a key with the prefix BUILDER_APP_ that is
 * not one of the three is refused, since it is most likely one of them misspelt. A refusal names the line and the key,
 * never a value: should a secret be pasted here by mistake, it reaches no log. The file is the process user's own,
 * writable by no one else (whoever writes it chooses the installation the dispatcher asks for); others may read it,
 * since the ids are not secrets.
 */
import { isAbsolute } from 'node:path';

import { readOwnFile } from './own-file.mjs';

/** Where the dispatcher's env file lives on the build VM. */
export const DISPATCHER_ENV_FILE = '/home/dispatcher/.config/factory/env';
/** builder-app's key, when the env file names none. */
export const DEFAULT_KEY_PATH = '/home/dispatcher/.config/factory/builder-app.pem';

/** The env file is missing something, holds something malformed, or is not the dispatcher's own. */
export class ConfigError extends Error {}

const PREFIX = 'BUILDER_APP_';
const positiveInteger = (value) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const KEYS = {
  BUILDER_APP_ID: { field: 'appId', valid: positiveInteger, parse: Number, expected: 'a positive integer' },
  BUILDER_APP_INSTALLATION_ID: {
    field: 'installationId', valid: positiveInteger, parse: Number, expected: 'a positive integer',
  },
  BUILDER_APP_KEY: { field: 'keyPath', valid: isAbsolute, parse: String, expected: 'an absolute path' },
};

/** Parses the text of an env file; `source` names it in errors. */
export function parseDispatcherEnv(text, source = 'the env file') {
  const seen = new Map();
  const config = { keyPath: DEFAULT_KEY_PATH };
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const number = index + 1;
    if (/^\s*(#.*)?$/.test(line)) {
      return;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      throw new ConfigError(`${source}, line ${number}: not KEY=value`);
    }
    const [, key, value] = match;
    const spec = KEYS[key];
    if (!spec) {
      if (key.startsWith(PREFIX)) {
        throw new ConfigError(`${source}, line ${number}: unknown key ${key} (known: ${Object.keys(KEYS).join(', ')})`);
      }
      return;
    }
    if (seen.has(key)) {
      throw new ConfigError(`${source}, line ${number}: ${key} set again (first on line ${seen.get(key)})`);
    }
    seen.set(key, number);
    if (!spec.valid(value)) {
      throw new ConfigError(`${source}, line ${number}: ${key} must be ${spec.expected}`);
    }
    config[spec.field] = spec.parse(value);
  });
  for (const key of ['BUILDER_APP_ID', 'BUILDER_APP_INSTALLATION_ID']) {
    if (!seen.has(key)) {
      throw new ConfigError(`${source}: ${key} is missing`);
    }
  }
  return config;
}

/**
 * Reads and checks the dispatcher's env file.
 *
 * @param {string} [path]
 * @param {{ uid?: number }} [options] the owner required, the process's user by default (for tests)
 * @returns {Promise<{ appId: number, installationId: number, keyPath: string }>}
 */
export async function readDispatcherEnv(path = DISPATCHER_ENV_FILE, { uid } = {}) {
  const text = await readOwnFile(path, {
    what: 'the env file', forbiddenMode: 0o022, uid, refuse: (message) => new ConfigError(message),
  });
  return parseDispatcherEnv(text, path);
}
