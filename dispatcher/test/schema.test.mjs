// The adapter's and the gate's schemas (incident-platform backlog #0-275 AC5), checked by the validator of Node's
// built-ins (ADR-0060 D2): incident-platform's adapter as stage-4.md "4.3" and "4.7" describe it passes; a missing or
// unknown field, at any depth, is refused with where it is; the answers today's run-tests.sh prints pass the gate's;
// a schema that uses a keyword the validator does not check is refused, so it cannot claim a check never made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AdapterError, checkAdapter, checkGateAnswer, loadAdapter } from '../src/adapter.mjs';
import { checkSchema, SchemaError, validate } from '../src/schema/validate.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const json = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url), 'utf8'));
const ADAPTER_PATH = new URL('../testing/fixtures/incident-platform.adapter.json', import.meta.url);
const ADAPTER = await json(ADAPTER_PATH);
const adapterSchema = await json('../../schemas/adapter.schema.json');
const gateSchema = await json('../../schemas/gate.schema.json');

const refused = (value, pattern) => assert.throws(() => checkAdapter(value), (error) => {
  assert.ok(error instanceof AdapterError, error.message);
  assert.match(error.message, pattern);
  return true;
});
const without = (object, path) => {
  const copy = structuredClone(object);
  const keys = path.split('/');
  const last = keys.pop();
  delete keys.reduce((at, key) => at[key], copy)[last];
  return copy;
};
const withField = (object, path, value) => {
  const copy = structuredClone(object);
  const keys = path.split('/');
  const last = keys.pop();
  keys.reduce((at, key) => at[key], copy)[last] = value;
  return copy;
};

test('AC5: incident-platform\'s adapter, as stage-4.md describes it, passes; trustedPaths is ["scripts/factory/"]',
  async () => {
    const adapter = await loadAdapter(ADAPTER_PATH);
    assert.deepEqual(adapter, ADAPTER);
    assert.deepEqual(adapter.trustedPaths, ['scripts/factory/']);
    assert.ok(Object.isFrozen(adapter.gate.command), 'the adapter loaded cannot be changed');
  });

test('AC5: the adapter missing any field, at any depth, is refused with where', () => {
  for (const field of adapterSchema.required) {
    refused(without(ADAPTER, field), new RegExp(`/${field}: missing`));
  }
  for (const path of ['gate/command', 'gate/contract', 'changedPaths/command', 'queue/kind', 'queue/files',
    'protectedPaths/file']) {
    refused(without(ADAPTER, path), new RegExp(`/${path}: missing`));
  }
});

test('AC5: the adapter with an unknown field, at any depth, is refused with where', () => {
  for (const path of ['extra', 'gate/shell', 'changedPaths/args', 'queue/project', 'protectedPaths/glob']) {
    refused(withField(ADAPTER, path, 'x'), new RegExp(`/${path}: unknown field`));
  }
});

test('the adapter\'s fields are checked: commands as argv, paths that stay in the product, known kinds', () => {
  const cases = [
    ['repository', 'incident-platform', /\/repository: must match/],
    ['gate/command', 'scripts/factory/run-tests.sh', /\/gate\/command: must be array/],
    ['gate/command', [], /\/gate\/command: must have at least 1 item/],
    ['gate/command', [''], /\/gate\/command\/0: must match/],
    ['gate/contract', 'other.schema.json', /\/gate\/contract: must be "gate.schema.json"/],
    ['queue/kind', 'projects-v2', /\/queue\/kind: must be "backlog-md"/],
    ['queue/files', [], /\/queue\/files: must have at least 1 item/],
    ['queue/files', ['BACKLOG.md', 'BACKLOG.md'], /\/queue\/files: must not repeat an item/],
    ['trustedPaths', ['/etc/'], /\/trustedPaths\/0: must match/],
    ['trustedPaths', ['scripts/../..'], /\/trustedPaths\/0: must match/],
    ['trustedPaths', ['..'], /\/trustedPaths\/0: must match/],
    ['protectedPaths/file', 'a\\b', /\/protectedPaths\/file: must match/],
    ['profile', 'Spring Boot', /\/profile: must match/],
    ['factoryVersion', 'main', /\/factoryVersion: must match/],
    ['factoryVersion', 'v1.2', /\/factoryVersion: must match/],
    ['taskImage', '', /\/taskImage: must match/],
    // #0-277 AC5: the task configuration's path in the product, never an option, never leaving it, a .json.
    ['taskImage', '-x.json', /\/taskImage: must match \^\(\?!-\)/],
    ['taskImage', '--config=/etc/x.json', /\/taskImage: must match \^\(\?!-\)/],
    ['taskImage', '../other/devcontainer.json', /\/taskImage: must match \^\(\?!\/\)/],
    ['taskImage', '.devcontainer/../../x.json', /\/taskImage: must match \^\(\?!\/\)/],
    ['taskImage', '/etc/devcontainer.json', /\/taskImage: must match \^\(\?!\/\)/],
    ['taskImage', '.devcontainer/Dockerfile', /\/taskImage: must match \^\(\?!-\)/],
    ['taskImage', '.devcontainer/task.json\n', /\/taskImage: must match/],
  ];
  for (const [path, value, pattern] of cases) {
    refused(withField(ADAPTER, path, value), pattern);
  }
  checkAdapter(withField(ADAPTER, 'trustedPaths', ['scripts/factory/', 'a..b/c']));
  checkAdapter(withField(ADAPTER, 'taskImage', '.devcontainer/task.json'));
  checkAdapter(withField(ADAPTER, 'taskImage', 'a-b/.devcontainer.json'));
  refused([], /^the adapter breaks its schema: \/: must be object$/);
});

test('sec-4a81: a path is refused when a line break, a control character or a line separator would hide a .. segment',
  () => {
    const escapes = ['\n/../../../home/dispatcher/x', '\n/../x', 'a\r/../../x', 'a\u2028/../x', 'a\u2029/../x', 'a/\u0000',
      'a\tb', 'a\u007fb', 'x\n..'];
    for (const value of escapes) {
      for (const path of ['protectedPaths/file', 'queue/files', 'trustedPaths']) {
        const field = path === 'protectedPaths/file' ? value : [value];
        refused(withField(ADAPTER, path, field), /must match/);
      }
    }
  });

test('a command\'s first argument is the product\'s script: a path with a /, not absolute, not leaving it, not a'
  + ' directory, not an option', () => {
  for (const script of ['/usr/bin/env', '../x', '-x', '--help', '-x/run.sh', '--opt/x', 'a/../../x', '\n/../x']) {
    refused(withField(ADAPTER, 'gate/command', [script]), /\/gate\/command\/0: must match/);
    refused(withField(ADAPTER, 'changedPaths/command', [script, 'arg']), /\/changedPaths\/command\/0: must match/);
  }
  for (const script of ['bash', 'env', 'node', '.', './', 'run-tests.sh', 'scripts/', 'scripts/factory/']) {
    refused(withField(ADAPTER, 'gate/command', [script, 'x']), /\/gate\/command\/0: must match/);
  }
  for (const script of ['scripts/factory/run-tests.sh', './run-tests.sh', 'bin/gate']) {
    checkAdapter(withField(ADAPTER, 'gate/command', [script]));
  }
  checkAdapter(withField(ADAPTER, 'gate/command', ['scripts/factory/run-tests.sh', '--working-tree', '/abs']));
  refused(withField(ADAPTER, 'gate/command', ['scripts/x.sh', '']), /\/gate\/command\/1: must have at least 1/);
});

test('the repository\'s name is neither . nor ..', () => {
  for (const repository of ['owner/..', 'owner/.', './repo', '../repo', 'owner/', '/repo', 'owner/repo/x']) {
    refused(withField(ADAPTER, 'repository', repository), /\/repository: must match/);
  }
  for (const repository of ['owner/.github', 'owner/a..b', 'o/x.']) {
    checkAdapter(withField(ADAPTER, 'repository', repository));
  }
});

test('prefixItems checks the leading items, and items those after them', () => {
  const schema = { type: 'array', prefixItems: [{ const: 'a' }], items: { type: 'integer' } };
  assert.deepEqual(validate(schema, ['a', 1, 2]), []);
  assert.deepEqual(validate(schema, [1, 'b']), ['/0: must be "a"', '/1: must be integer']);
  assert.deepEqual(validate(schema, []), []);
  assert.throws(() => checkSchema({ prefixItems: [] }), /prefixItems must be a list of schemas/);
});

test('an error names where and what is expected, never the value found there', () => {
  const secret = 'ghs' + '_ValueThatMustNotBeQuoted'; // two parts: no file holds text shaped like a secret
  assert.throws(() => checkAdapter(withField(ADAPTER, 'profile', secret)), (error) => !error.message.includes(secret));
  assert.throws(() => checkAdapter(withField(ADAPTER, 'gate/contract', secret)),
    (error) => !error.message.includes(secret));
});

test('the adapter file unreadable, or not JSON, is refused without quoting it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  await assert.rejects(loadAdapter(join(state.dir, 'none.json')), /cannot be read \(ENOENT\)/);
  const quoted = 'ghs' + '_x';
  await writeFile(join(state.dir, 'bad.json'), `{"repository": "${quoted}"`);
  await assert.rejects(loadAdapter(join(state.dir, 'bad.json')), (error) => /is not JSON$/.test(error.message)
    && !error.message.includes(quoted));
});

// The three shapes run-tests.sh prints: a pass, a fixable failure, and a stop before the build (exitCode -1).
const GATE = {
  pass: { status: 'pass', exitCode: 0, modules: 'incident-service', log: '.ai/runs/0-1/gate-r1-0.log',
    head: 'a'.repeat(40), artifact: '.ai/runs/0-1/gate-r1-0.json', summary: ['[INFO] BUILD SUCCESS'] },
  fixable: { status: 'fixable', exitCode: 1, modules: 'shared,incident-service', log: '.ai/runs/0-1/gate-r1-0.log',
    head: 'b'.repeat(40), artifact: null, summary: ['[ERROR] Tests run: 3, Failures: 1', '[INFO] BUILD FAILURE'] },
  stop: { status: 'stop', exitCode: -1, modules: '', log: '', head: '', artifact: null,
    summary: ['invalid round: x'] },
};

test('AC5: the gate\'s answers of today\'s run-tests.sh pass its schema', () => {
  for (const answer of Object.values(GATE)) {
    assert.deepEqual(checkGateAnswer(answer), answer);
  }
});

test('AC5: a gate answer missing or adding a field, or out of its contract, is refused', () => {
  for (const field of gateSchema.required) {
    const answer = { ...GATE.pass };
    delete answer[field];
    assert.throws(() => checkGateAnswer(answer), new RegExp(`/${field}: missing`));
  }
  assert.throws(() => checkGateAnswer({ ...GATE.pass, dirty: false }), /\/dirty: unknown field/);
  assert.throws(() => checkGateAnswer({ ...GATE.pass, status: 'green' }),
    /\/status: must be one of "pass", "fixable", "stop"/);
  assert.throws(() => checkGateAnswer({ ...GATE.pass, exitCode: 1.5 }), /\/exitCode: must be integer/);
  assert.throws(() => checkGateAnswer({ ...GATE.pass, artifact: 3 }), /\/artifact: must be string or null/);
  assert.throws(() => checkGateAnswer({ ...GATE.pass, summary: ['ok', 2] }), /\/summary\/1: must be string/);
});

test('a schema with a keyword the validator does not check is refused, at any depth', () => {
  for (const keyword of ['oneOf', 'anyOf', 'if', 'format', 'maxLength', 'contains', 'patternProperties']) {
    assert.throws(() => checkSchema({ type: 'object', properties: { a: { [keyword]: [] } } }), (error) => {
      assert.ok(error instanceof SchemaError);
      assert.match(error.message, new RegExp(`^#/properties/a: the keyword ${keyword} is not one this validator`));
      return true;
    });
  }
  assert.throws(() => checkSchema({ $ref: '#/$defs/none' }), /names no #\/\$defs\/<name>/);
  assert.throws(() => checkSchema({ $ref: 'https://elsewhere/schema.json' }), /names no/);
  assert.throws(() => checkSchema({ type: 'date' }), /type must name JSON types/);
  checkSchema(adapterSchema);
  checkSchema(gateSchema);
});

test('the validator: types, an integer is a number, JSON Pointer escapes, and the root', () => {
  assert.deepEqual(validate({ type: 'number' }, 3), []);
  assert.deepEqual(validate({ type: 'integer' }, 3.5), ['/: must be integer']);
  assert.deepEqual(validate({ type: 'object' }, null), ['/: must be object']);
  assert.deepEqual(validate({ type: 'object' }, []), ['/: must be object']);
  assert.deepEqual(validate({ type: 'object', additionalProperties: false }, { 'a/b~c': 1 }),
    ['/a~1b~0c: unknown field']);
  assert.deepEqual(validate({ type: 'string', minLength: 2 }, '😀'), ['/: must have at least 2 character(s)']);
});
