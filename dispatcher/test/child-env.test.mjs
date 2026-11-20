// The one builder of a child's environment (incident-platform backlog #0-276 AC4): childEnv takes what the caller
// allows of the base environment and what it sets, nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError } from '../src/config/settings.mjs';
import { childEnv } from '../src/process/child-env.mjs';

test('childEnv: the allowed variables that are set, then what the caller sets; nothing else', () => {
  const baseEnv = { PATH: '/bin', HOME: '/home/d', SECRET: 's', EMPTY: '' };
  assert.deepEqual(childEnv({ allow: ['PATH', 'HOME', 'MISSING', 'EMPTY'], set: { LC_ALL: 'C', HOME: '/h' }, baseEnv }),
    { PATH: '/bin', HOME: '/h', EMPTY: '', LC_ALL: 'C' });
  assert.deepEqual(childEnv({ baseEnv }), {}, 'nothing allowed, nothing set: empty');
  assert.deepEqual(childEnv({ allow: [], baseEnv }), {});
  const env = childEnv({ allow: ['PATH'], baseEnv });
  env.PATH = 'changed';
  assert.equal(baseEnv.PATH, '/bin', 'a new object: the base is not changed');
});

test('childEnv: a name that is not one, or a value set that is not a string, is a TypeError', () => {
  for (const name of ['', '1X', 'A-B', 'A B', 'A=B']) {
    assert.throws(() => childEnv({ allow: [name], baseEnv: {} }), TypeError);
    assert.throws(() => childEnv({ set: { [name]: 'x' } }), TypeError);
  }
  assert.throws(() => childEnv({ set: { X: 1 } }), /X must be set to a string/);
});

test('childEnv: an inherited value shaped like a secret is refused by its name; one set by the caller is not checked',
  () => {
    const token = `${'ghs'}_${'x'.repeat(36)}`;
    assert.throws(() => childEnv({ allow: ['HOME'], baseEnv: { HOME: token } }), (error) => error instanceof ConfigError
      && /^HOME holds a value shaped like a secret/.test(error.message) && !error.message.includes(token));
    assert.deepEqual(childEnv({ allow: [], set: { FACTORY_PUSH_TOKEN: token }, baseEnv: { HOME: token } }),
      { FACTORY_PUSH_TOKEN: token }, 'a variable not allowed is not even read');
  });
