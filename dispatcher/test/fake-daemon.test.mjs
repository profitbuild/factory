// The fake daemon's safety on a developer's machine (review round 2 of factory#20, 1): it maps the container's /tmp/
// to a directory of the test's, into the text of the unpacking script too, where `rm -rf /tmp/factory-trusted.*` and
// `mktemp -d` stand unquoted. A directory holding a space, or a glob or shell character, is refused before anything
// is made or run: when the fake is made, and again when a call maps /tmp/.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFakeDaemon, plantedContainer } from '../testing/fake-daemon.mjs';
import { TEST_ROOT, checkShellSafe, makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);

const UNSAFE = [' ', '\t', '\n', '*', '?', '[', ']', '{', '}', '$', '"', "'", '`', '\\', ';', '&', '|', '<', '>', '(',
  ')', '!', '#', '~', '%', '='];

test('a test directory with whitespace, a glob or a shell character is refused before anything is made', () => {
  for (const c of UNSAFE) {
    const where = join(root.dir, `a${c}b`);
    assert.throws(() => makeFakeDaemon(where), /the fake daemon's \/tmp\/ \(config\.tmp\) must be an absolute path of letters, digits/, JSON.stringify(c));
    assert.equal(existsSync(where), false, `${JSON.stringify(c)}: nothing made`);
  }
  assert.throws(() => checkShellSafe('relative/dir', 'x'), /x must be an absolute path/);
  assert.doesNotThrow(() => checkShellSafe(TEST_ROOT, 'TEST_ROOT'));
  const fake = makeFakeDaemon(join(root.dir, 'safe_dir-1.x'));
  assert.ok(existsSync(fake.tmp));
});

test('a config whose /tmp/ is unsafe is refused at the call that maps it, and the script does not run', () => {
  const dir = join(root.dir, 'by-hand');
  const fake = makeFakeDaemon(dir);
  // A prefix the unquoted `rm -rf` would reach if the path were split at its space, with a file in it.
  const prefix = join(dir, 'home');
  mkdirSync(prefix);
  writeFileSync(join(prefix, 'keep'), 'kept\n');
  const unsafe = `${prefix} x/tmp`;
  const script = readFileSync(fake.sudo, 'utf8').replace(JSON.stringify(fake.tmp), JSON.stringify(unsafe));
  writeFileSync(fake.sudo, script);
  const workspace = join(fake.tasks, 'w');
  mkdirSync(workspace, { recursive: true });
  const container = { ...plantedContainer({ name: 'task' }), workspace: '/home/factory/tasks/w' };
  fake.update((state) => { state.containers.push(container); });
  const result = spawnSync(fake.sudo, ['-n', '-H', '-u', 'factory', '--', '/usr/bin/docker', 'exec', '-i', container.id,
    'sh', '-c', 'touch /tmp/ran; rm -rf /tmp/factory-trusted.*; touch ran-here'], { input: '', encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the fake daemon's \/tmp\/ \(config\.tmp\) must be an absolute path/);
  assert.equal(existsSync(join(workspace, 'ran-here')), false, 'the script never ran');
  assert.equal(readFileSync(join(prefix, 'keep'), 'utf8'), 'kept\n', 'the prefix is untouched');
});
