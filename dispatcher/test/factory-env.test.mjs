// The dispatcher's settings (incident-platform backlog #0-275): FACTORY_* from the env object, each required, with no
// default (AC1), and no variable of the environment holding a value shaped like a secret (AC7). Every refusal names
// the variable and never holds its value; each case checks both.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFactoryEnv } from '../src/config/factory-env.mjs';
import { ConfigError, readSettings, refuseSecretShaped } from '../src/config/settings.mjs';

const VALID = {
  FACTORY_STATE_DIR: '/srv/factory/state', FACTORY_REPO_DIR: '/srv/factory/product', FACTORY_MAX_BLOCKED: '3',
  FACTORY_AUDIT_EVERY: '10', FACTORY_MAX_MERGES_PER_DAY: '5',
};
const NAMES = Object.keys(VALID);

/** Refused with a ConfigError matching `pattern`, whose message holds none of `values`. */
function refused(read, pattern, values = []) {
  assert.throws(read, (error) => {
    assert.ok(error instanceof ConfigError, error.message);
    assert.match(error.message, pattern);
    for (const value of values.filter((v) => v.length > 0)) {
      assert.ok(!error.message.includes(value), `the refusal "${error.message}" holds the value ${value}`);
    }
    return true;
  });
}

test('the settings are read from the env object; other variables are left alone', () => {
  assert.deepEqual(readFactoryEnv({ ...VALID, PATH: '/bin', BUILDER_APP_ID: '1' }), {
    stateDir: '/srv/factory/state', repoDir: '/srv/factory/product', maxBlocked: 3, auditEvery: 10,
    maxMergesPerDay: 5,
  });
});

test('AC1: each setting is required, with no default (ADR-0052 point 5)', () => {
  for (const name of NAMES) {
    const env = { ...VALID };
    delete env[name];
    refused(() => readFactoryEnv(env), new RegExp(`^${name} is not set \\(it has no default, ADR-0052 point 5\\)$`));
  }
});

test('AC1: a malformed setting is refused by its name, never its value', () => {
  for (const name of ['FACTORY_STATE_DIR', 'FACTORY_REPO_DIR']) {
    for (const value of ['', 'relative/state', './state', '~/state']) {
      refused(() => readFactoryEnv({ ...VALID, [name]: value }), new RegExp(`^${name} must be an absolute path$`),
        [value]);
    }
  }
  for (const name of ['FACTORY_MAX_BLOCKED', 'FACTORY_AUDIT_EVERY', 'FACTORY_MAX_MERGES_PER_DAY']) {
    for (const value of ['', '0', '-1', '1.5', '07', ' 3', '3 ', '1e3', '0x10', 'three', '99999999999999999999']) {
      refused(() => readFactoryEnv({ ...VALID, [name]: value }), new RegExp(`^${name} must be a positive integer$`),
        [value.trim()]);
    }
  }
});

test('AC1: an unknown FACTORY_ variable (one misspelt) is refused by its name, never its value', () => {
  refused(() => readFactoryEnv({ ...VALID, FACTORY_MAX_BLOKED: 'value-of-the-typo' }),
    new RegExp(`^unknown variable FACTORY_MAX_BLOKED \\(known: ${NAMES.join(', ')}\\)$`), ['value-of-the-typo']);
  refused(() => readFactoryEnv({ ...VALID, FACTORY_STATEDIR: '/srv/x' }), /^unknown variable FACTORY_STATEDIR /,
    ['/srv/x']);
});

test('AC1: FACTORY_PROXY_ADDR is unknown until step 4.6 adds it', () => {
  refused(() => readFactoryEnv({ ...VALID, FACTORY_PROXY_ADDR: '127.0.0.1:3128' }),
    /^unknown variable FACTORY_PROXY_ADDR /, ['127.0.0.1:3128']);
});

test('the shared mechanism takes the first unknown variable in name order, before any missing one', () => {
  const group = { prefix: 'X_', settings: { X_A: { field: 'a', valid: () => true, parse: String, expected: '' } },
    required: ['X_A'] };
  refused(() => readSettings({ X_Z: '1', X_B: '2' }, group), /^unknown variable X_B /);
});

// Values shaped like each secret: a PEM block (anywhere in the value), and each GitHub token prefix at the start or
// after a space, quote, = or :. Each is put together at run time from two parts, so that no file of the repository
// holds text shaped like a secret, which the secret scan of every commit would report.
const TOKEN = 'x'.repeat(36);
const BEGIN = '-----BEGIN ';
const KEY = 'PRIVATE KEY-----';
const SECRET_SHAPED = [
  `${BEGIN}RSA ${KEY}\nMIIEow\n-----END RSA ${KEY}`,
  `prefix ${BEGIN}${KEY} rest`,
  `${BEGIN}OPENSSH ${KEY}`,
  ...['ghs', 'ghp', 'gho', 'ghu', 'ghr', 'github_pat'].map((prefix) => `${prefix}_${TOKEN}`),
  `Bearer ${'ghs'}_${TOKEN}`, `token=${'ghp'}_${TOKEN}`, `x:${'gho'}_${TOKEN}`, `"${'github_pat'}_11AB_${TOKEN}"`,
];

test('AC7: a value shaped like a secret, in any variable, is refused by the name alone', () => {
  for (const value of SECRET_SHAPED) {
    for (const name of ['FACTORY_REPO_DIR', 'BUILDER_APP_KEY', 'GH_TOKEN', 'SOMETHING_ELSE']) {
      refused(() => refuseSecretShaped({ PATH: '/usr/bin', [name]: value }),
        new RegExp(`^${name} holds a value shaped like a secret: the dispatcher's environment and its env file hold `
          + 'no secret, ever; remove it$'), [value, TOKEN, 'ghs_', 'ghp_', 'gho_', 'ghu_', 'ghr_', 'github_pat_',
          'BEGIN']);
    }
  }
});

test('AC7: every variable shaped like a secret is named, in name order', () => {
  refused(() => refuseSecretShaped({ Z: SECRET_SHAPED[3], A: SECRET_SHAPED[4], M: 'plain' }),
    /^A, Z hold values shaped like a secret: .*; remove them$/, [TOKEN]);
});

test('AC7: a token after any character that cannot be part of it is refused; sk-ant- too', () => {
  const anthropic = `${'sk'}-ant-api03-${'x'.repeat(80)}`;
  for (const value of [`https://${'ghp'}_${TOKEN}@github.com/o/r.git`, `a,${'ghs'}_${TOKEN}`, `a;${'ghs'}_${TOKEN}`,
    `(${'ghu'}_${TOKEN})`, `/${'ghs'}_${TOKEN}`, anthropic, `key=${anthropic}`, `${'ghs'}_${TOKEN}x`]) {
    refused(() => refuseSecretShaped({ V: value }), /^V holds a value shaped like a secret/, [value, TOKEN]);
  }
});

test('AC7: ordinary values pass, a word with a prefix and a token too short among them', () => {
  refuseSecretShaped({
    ...VALID, PATH: '/usr/local/bin:/usr/bin', HOME: '/home/dispatcher', NOTE: 'gh_ is not a token, nor ghs alone',
    DIR: '/srv/ghs_cache', COLON: ':ghs_cache', LIST: 'a,ghx_b', EMPTY: '', DASHES: '----- BEGIN', NUMBER: '123456',
    SHORT: `${'ghs'}_${'x'.repeat(35)}`, PAT: `${'github_pat'}_${'x'.repeat(35)}`, ANT: `${'sk'}-ant-short`,
    INSIDE: `abc${'ghs'}_${TOKEN}`, TASK: 'task-ant-colony',
  });
});
