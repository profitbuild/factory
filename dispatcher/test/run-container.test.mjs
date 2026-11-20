// The one starter of container commands (incident-platform ADR-0062 point 1; backlog #0-277 AC9), with a fake sudo: the
// command line is sudo's rule's, `-n -H -u factory --` and the program by its full path; the environment holds nothing
// of the dispatcher's; no argument is shaped like a secret (sudo logs them); a call past its time is refused at once,
// without waiting for an orphan that holds its output, and the caller's kill runs; output is bounded; a sudo that
// refuses (no rule) is a refusal naming sudo's words.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ContainerRunError, ContainerTimeoutError, PROGRAMS, SUDO, SUDO_OPTIONS, mustRun, runContainerCommand,
} from '../src/container/run-container.mjs';
import { makeFakeDaemon } from '../testing/fake-daemon.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);

async function script(name, body) {
  const path = join(root.dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test('every call is sudo -n -H -u factory -- and docker or devcontainer by its full path, with no variable of the '
  + 'dispatcher\'s', async () => {
  assert.equal(SUDO, '/usr/bin/sudo');
  assert.deepEqual(PROGRAMS, { docker: '/usr/bin/docker', devcontainer: '/usr/local/bin/devcontainer' });
  assert.deepEqual(SUDO_OPTIONS, ['-n', '-H', '-u', 'factory', '--']);
  const fake = makeFakeDaemon(join(root.dir, 'argv'));
  await mustRun({ program: 'docker', args: ['volume', 'ls', '--format', '{{.Name}}'], sudo: fake.sudo,
    baseEnv: { PATH: '/usr/bin', HOME: '/home/dispatcher', BUILDER_APP_KEY: '/k', OTHER: 'o' } });
  const [call] = fake.calls();
  assert.deepEqual(call.argv, ['-n', '-H', '-u', 'factory', '--', '/usr/bin/docker', 'volume', 'ls', '--format',
    '{{.Name}}']);
  for (const name of ['PATH', 'HOME', 'BUILDER_APP_KEY', 'OTHER']) {
    assert.ok(!call.env.includes(name), `${name} reached sudo`);
  }
  const dumped = join(root.dir, 'argv.txt');
  const recorder = await script('recorder', `printf '%s\\n' "$@" > ${dumped}`);
  await mustRun({ program: 'devcontainer', args: ['up', '--x'], sudo: recorder });
  assert.deepEqual((await readFile(dumped, 'utf8')).trim().split('\n'),
    ['-n', '-H', '-u', 'factory', '--', '/usr/local/bin/devcontainer', 'up', '--x']);
  assert.throws(() => runContainerCommand({ program: 'sh', args: ['-c', 'x'] }), TypeError);
  assert.throws(() => runContainerCommand({ program: '/usr/bin/docker', args: ['ps'] }), TypeError);
  assert.throws(() => runContainerCommand({ program: 'docker', args: [] }), TypeError);
});

test('an argument shaped like a secret is refused before anything runs, by its position and never its value',
  async () => {
    const ran = join(root.dir, 'ran');
    const recorder = await script('ran-recorder', `touch ${ran}`);
    const secret = 'ghs' + `_${'y'.repeat(36)}`;
    assert.throws(() => runContainerCommand({ program: 'docker', args: ['exec', '-e', `T=${secret}`, 'c'], sudo: recorder }),
      (error) => {
        assert.ok(error instanceof ContainerRunError);
        assert.match(error.message, /^docker exec: argument 3 holds a value shaped like a secret: sudo logs the /);
        assert.ok(!error.message.includes(secret) && !error.message.includes('ghs_'));
        return true;
      });
    await assert.rejects(readFile(ran), { code: 'ENOENT' });
  });

test('a call past its time is refused at once, though an orphan holds its output open; the caller\'s kill runs',
  { timeout: 10_000 }, async () => {
    // The orphan would hold stdout for 30 s: a starter that waited for the streams to close misses the test's 10 s.
    const pidFile = join(root.dir, 'orphan.pid');
    const orphaned = await script('orphaned', `sleep 30 & echo $! > ${pidFile}\nexit 0`);
    let killed = 0;
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['exec'], sudo: orphaned, timeoutMs: 300,
      onTimeout: async () => { killed += 1; } }), (error) => {
      assert.ok(error instanceof ContainerTimeoutError);
      assert.match(error.message, /^docker exec ran past 300 ms: stopped, its output no longer read$/);
      return true;
    });
    assert.equal(killed, 1);
    process.kill(Number((await readFile(pidFile, 'utf8')).trim()), 'SIGKILL');
    const hung = await script('hung', 'exec sleep 30');
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['exec'], sudo: hung, timeoutMs: 200,
      onTimeout: async () => { throw new Error('docker kill failed'); } }),
    /ran past 200 ms: stopped, its output no longer read; and the kill after it failed: docker kill failed$/);
  });

test('output past the bound is refused; stdin reaches the command; a sudo with no rule is a refusal in its words',
  async () => {
    const flood = await script('flood', 'head -c 100000 /dev/zero');
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['logs'], sudo: flood, outputLimit: 1000 }),
      /^Error: docker logs wrote more than 1000 bytes to its stdout: stopped$/);
    const cat = await script('cat', 'cat');
    const { code, stdout } = await runContainerCommand({ program: 'docker', args: ['run'], sudo: cat, input: 'bytes' });
    assert.deepEqual([code, stdout.toString()], [0, 'bytes']);
    const fake = makeFakeDaemon(join(root.dir, 'norule'));
    const noRule = await script('no-rule-sudo', 'echo "sudo: a password is required" >&2; exit 1');
    await assert.rejects(mustRun({ program: 'docker', args: ['ps'], sudo: noRule }),
      /^Error: docker ps failed \(exit 1\): sudo: a password is required$/);
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['ps'], sudo: join(root.dir, 'none') }),
      /could not be run: ENOENT$/);
    assert.equal(fake.calls().length, 0);
  });
