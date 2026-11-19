// builder-app's settings, from the environment only (incident-platform ADR-0055, backlog #0-271): the ids and the
// key path are read from an env object, and a missing, malformed or unknown one is refused, naming the variable,
// never a value. That `node --env-file` loads the dispatcher's env file into them is check-app.test.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, DEFAULT_KEY_PATH, readBuilderEnv } from '../src/config/builder-env.mjs';

const VALID = { BUILDER_APP_ID: '12', BUILDER_APP_INSTALLATION_ID: '34' };

const refused = (env, pattern) => assert.throws(() => readBuilderEnv(env), (error) => {
  assert.ok(error instanceof ConfigError, error.message);
  assert.match(error.message, pattern);
  return true;
});

test('the ids and the key path are read from the env object; other variables are left alone', () => {
  assert.deepEqual(readBuilderEnv({ ...VALID, BUILDER_APP_KEY: '/srv/key.pem', PATH: '/bin', FACTORY_X: 'y' }),
    { appId: 12, installationId: 34, keyPath: '/srv/key.pem' });
  assert.equal(readBuilderEnv(VALID).keyPath, DEFAULT_KEY_PATH);
});

test('process.env is read by default', () => {
  const names = ['BUILDER_APP_ID', 'BUILDER_APP_INSTALLATION_ID'];
  const saved = names.map((name) => process.env[name]);
  try {
    Object.assign(process.env, { BUILDER_APP_ID: '5', BUILDER_APP_INSTALLATION_ID: '6' });
    assert.equal(readBuilderEnv().installationId, 6);
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[i];
      }
    });
  }
});

test('an unknown variable with the prefix BUILDER_APP_ is refused, by its name and without its value', () => {
  refused({ ...VALID, BUILDER_APP_INSTALATION_ID: 'ghs_SomethingPastedByMistake' },
    new RegExp('^unknown variable BUILDER_APP_INSTALATION_ID '
      + '\\(known: BUILDER_APP_ID, BUILDER_APP_INSTALLATION_ID, BUILDER_APP_KEY\\)$'));
});

test('a missing id is refused, pointing to node --env-file', () => {
  refused({ BUILDER_APP_ID: '1' }, /^BUILDER_APP_INSTALLATION_ID is not set \(on the build VM: node --env-file=/);
  refused({ BUILDER_APP_INSTALLATION_ID: '1' }, /^BUILDER_APP_ID is not set/);
});

test('an id that is not a positive integer, or a relative key path, is refused without its value', () => {
  for (const value of ['', '0', '-1', '1.5', '"12"', ' 12', '12 ', '0x10', '99999999999999999999', 'ghs_Secret']) {
    refused({ ...VALID, BUILDER_APP_ID: value }, /^BUILDER_APP_ID must be a positive integer$/);
    refused({ ...VALID, BUILDER_APP_INSTALLATION_ID: value },
      /^BUILDER_APP_INSTALLATION_ID must be a positive integer$/);
  }
  refused({ ...VALID, BUILDER_APP_KEY: 'key.pem' }, /^BUILDER_APP_KEY must be an absolute path$/);
});
