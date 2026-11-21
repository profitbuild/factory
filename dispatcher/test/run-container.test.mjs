// The one starter of container commands (incident-platform ADR-0062 point 1; backlog #0-277 AC9), with a fake sudo: the
// command line is sudo's rule's, `-n -H -u factory --` and the program by its full path; the environment holds nothing
// of the dispatcher's; no argument is shaped like a secret (sudo logs them); a call past its time is refused at once,
// without waiting for an orphan that holds its output, and the caller's kill runs; output is bounded; a sudo that
// refuses (no rule) is a refusal naming the command and its exit code; what a call writes to stderr, the agent's
// side's, is never quoted, nor an argument of it (review round 1 N1); and (incident-platform backlog #0-284 AC5, AC6)
// the starter's result holds no stderr, only the path of the file it is kept in: 600, in $FACTORY_STATE_DIR/stderr/
// (700), at most STDERR_KEPT bytes of it, the path named by a failed call's refusal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ContainerRunError, ContainerTimeoutError, PROGRAMS, STDERR_KEPT, SUDO, SUDO_OPTIONS, StderrKeepError, mustRun,
  runContainerCommand,
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
  await mustRun({ program: 'docker', args: ['volume', 'ls', '--format', '{{.Name}}'], ...fake.runner,
    baseEnv: { PATH: '/usr/bin', HOME: '/home/dispatcher', BUILDER_APP_KEY: '/k', OTHER: 'o' } });
  const [call] = fake.calls();
  assert.deepEqual(call.argv, ['-n', '-H', '-u', 'factory', '--', '/usr/bin/docker', 'volume', 'ls', '--format',
    '{{.Name}}']);
  for (const name of ['PATH', 'HOME', 'BUILDER_APP_KEY', 'OTHER']) {
    assert.ok(!call.env.includes(name), `${name} reached sudo`);
  }
  const dumped = join(root.dir, 'argv.txt');
  const recorder = await script('recorder', `printf '%s\\n' "$@" > ${dumped}`);
  await mustRun({ program: 'devcontainer', args: ['up', '--x'], sudo: recorder, stateDir: root.dir });
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
    assert.throws(() => runContainerCommand({ program: 'docker', args: ['exec', '-e', `T=${secret}`, 'c'], sudo: recorder, stateDir: root.dir }),
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
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['exec'], sudo: orphaned, stateDir: root.dir, timeoutMs: 300,
      onTimeout: async () => { killed += 1; } }), (error) => {
      assert.ok(error instanceof ContainerTimeoutError);
      assert.match(error.message, /^docker exec ran past 300 ms: stopped, its output no longer read$/);
      return true;
    });
    assert.equal(killed, 1);
    process.kill(Number((await readFile(pidFile, 'utf8')).trim()), 'SIGKILL');
    const hung = await script('hung', 'exec sleep 30');
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['exec'], sudo: hung, stateDir: root.dir, timeoutMs: 200,
      onTimeout: async () => { throw new Error('docker kill failed'); } }),
    /ran past 200 ms: stopped, its output no longer read; and the kill after it failed: docker kill failed$/);
  });

test('output past the bound is refused; stdin reaches the command; a sudo with no rule is a refusal naming the command',
  async () => {
    const flood = await script('flood', 'head -c 100000 /dev/zero');
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['logs'], sudo: flood, stateDir: root.dir, outputLimit: 1000 }),
      /^Error: docker logs wrote more than 1000 bytes to its stdout: stopped$/);
    const cat = await script('cat', 'cat');
    const { code, stdout } = await runContainerCommand({ program: 'docker', args: ['run'], sudo: cat, stateDir: root.dir, input: 'bytes' });
    assert.deepEqual([code, stdout.toString()], [0, 'bytes']);
    const fake = makeFakeDaemon(join(root.dir, 'norule'));
    const noRule = await script('no-rule-sudo', 'echo "sudo: a password is required" >&2; exit 1');
    await assert.rejects(mustRun({ program: 'docker', args: ['ps'], sudo: noRule, stateDir: root.dir }),
      /^Error: docker ps failed \(exit 1\); its stderr, the agent's side's, is not quoted: it is kept in \/.*\/stderr\/[^/]+-docker-ps-[0-9a-f]{8}\.log$/);
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['ps'], sudo: join(root.dir, 'none'), stateDir: root.dir }),
      /could not be run: ENOENT$/);
    assert.equal(fake.calls().length, 0);
  });

test('review round 1 N1: what the agent\'s side writes to stderr is not quoted, nor the call\'s arguments', async () => {
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'z'.repeat(36)}`;
  const leaky = await script('leaky', `echo "fatal: token ${secret}" >&2; echo "${secret}"; exit 2`);
  await assert.rejects(mustRun({ program: 'docker', args: ['exec', '-i', 'container-name-with-data', 'cat'],
    sudo: leaky, stateDir: root.dir }), (error) => {
    assert.match(error.message, /^docker exec failed \(exit 2\); its stderr, the agent's side's, is not quoted: it is kept in /);
    assert.ok(!error.message.includes('ghs_') && !error.message.includes('container-name-with-data'));
    return true;
  });
  await assert.rejects(mustRun({ program: 'docker', args: ['volume', 'rm', 'v'], sudo: leaky, stateDir: root.dir }),
    /^Error: docker volume rm failed \(exit 2\); its stderr/);
});

test('#0-284 AC5: the starter\'s result holds no stderr: its code, its stdout and the file the stderr is kept in',
  async () => {
    const stateDir = join(root.dir, 'shape');
    await mkdir(stateDir, { mode: 0o700 });
    const both = await script('both', 'echo out; echo err >&2; exit 3');
    const result = await runContainerCommand({ program: 'docker', args: ['exec', 'x'], sudo: both, stateDir });
    assert.deepEqual(Object.keys(result).sort(), ['code', 'stderrFile', 'stdout']);
    assert.equal(result.code, 3);
    assert.equal(result.stdout.toString(), 'out\n');
    assert.equal(await readFile(result.stderrFile, 'utf8'), 'err\n');
    const quiet = await script('quiet', 'echo out');
    const silent = await runContainerCommand({ program: 'docker', args: ['ps'], sudo: quiet, stateDir });
    assert.deepEqual(Object.keys(silent).sort(), ['code', 'stderrFile', 'stdout']);
    assert.equal(silent.stderrFile, null, 'no file for a call that wrote nothing there');
    await assert.rejects(mustRun({ program: 'docker', args: ['ps'], sudo: await script('fails-quietly', 'exit 4'),
      stateDir }), /^Error: docker ps failed \(exit 4\); it wrote nothing to stderr$/);
    assert.throws(() => runContainerCommand({ program: 'docker', args: ['ps'], sudo: quiet }), /stateDir must be/);
    assert.throws(() => runContainerCommand({ program: 'docker', args: ['ps'], sudo: quiet, stateDir: 'rel' }),
      /stateDir must be/);
  });

test('#0-284 AC6: a failed call\'s stderr is in a file 600 in the state\'s stderr/ (700), at most STDERR_KEPT bytes, '
  + 'and the refusal names that file', async () => {
  const stateDir = join(root.dir, 'kept');
  await mkdir(stateDir, { mode: 0o700 });
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'k'.repeat(36)}`;
  const flood = await script('stderr-flood', `printf '%s' "${secret}" >&2; head -c ${STDERR_KEPT * 2} /dev/zero >&2; exit 7`);
  let refusal;
  await assert.rejects(mustRun({ program: 'docker', args: ['volume', 'rm', 'v'], sudo: flood, stateDir }), (error) => {
    refusal = error;
    return error instanceof ContainerRunError;
  });
  const match = /^docker volume rm failed \(exit 7\); its stderr, the agent's side's, is not quoted: it is kept in (\S+)$/
    .exec(refusal.message);
  assert.ok(match, refusal.message);
  const [, file] = match;
  assert.ok(!refusal.message.includes('ghs_'));
  assert.equal(file.startsWith(`${join(stateDir, 'stderr')}/`), true, 'in the state\'s stderr/');
  assert.deepEqual(await readdir(join(stateDir, 'stderr')), [file.slice(file.lastIndexOf('/') + 1)]);
  assert.equal((await stat(join(stateDir, 'stderr'))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const kept = await readFile(file);
  assert.ok(kept.subarray(0, secret.length).toString() === secret, 'kept as it was written, for the owner');
  const trailer = `\n[the call wrote ${STDERR_KEPT * 2 + secret.length - STDERR_KEPT} more bytes to stderr, not kept: `
    + `the file keeps ${STDERR_KEPT}]\n`;
  assert.equal(kept.length, STDERR_KEPT + Buffer.byteLength(trailer), 'the limit, and a line for the rest');
  assert.equal(kept.subarray(STDERR_KEPT).toString(), trailer);
  // A call past its time keeps what it wrote too, and its refusal names the file.
  const slow = await script('stderr-slow', 'echo started >&2; exec sleep 30');
  await assert.rejects(runContainerCommand({ program: 'docker', args: ['exec'], sudo: slow, stateDir, timeoutMs: 300 }),
    /^Error: docker exec ran past 300 ms: stopped, its output no longer read; its stderr, the agent's side's, is not quoted: it is kept in \S+-docker-exec-[0-9a-f]{8}\.log$/);
});

test('review round 1 of factory#22, GEN-31: a stderr that cannot be kept fails closed: an exit of 0 is refused, a '
  + 'failure keeps its class with the original as its cause, and neither quotes the stderr', { timeout: 20_000 },
async () => {
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'u'.repeat(36)}`;
  // stderr/ a file, not the state's directory: the state's own refusal.
  const notDir = join(root.dir, 'keep-not-dir');
  await mkdir(notDir, { mode: 0o700 });
  await writeFile(join(notDir, 'stderr'), '');
  // stderr/ the dispatcher's 700 directory, but not writable: EACCES (CI runs the tests as a user, not root).
  const readOnly = join(root.dir, 'keep-read-only');
  await mkdir(join(readOnly, 'stderr'), { recursive: true, mode: 0o700 });
  await chmod(readOnly, 0o700);
  await chmod(join(readOnly, 'stderr'), 0o500);
  const ok = await script('keep-ok', `echo "${secret}" >&2; echo out; exit 0`);
  for (const [stateDir, why] of [[notDir, 'StateError'], [readOnly, process.getuid() === 0 ? null : 'EACCES']]) {
    if (why === null) {
      continue;
    }
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['ps'], sudo: ok, stateDir }), (error) => {
      assert.ok(error instanceof StderrKeepError && error instanceof ContainerRunError, error.constructor.name);
      assert.equal(error.message, `docker ps ended (exit 0), but its stderr could not be kept in stderr/ of the state `
        + `(${why}): the call is refused whatever it did, the state of the VM not certain`);
      assert.ok(error.cause instanceof Error);
      assert.ok(!error.message.includes('ghs_'));
      return true;
    });
    const failed = await script(`keep-failed-${why}`, `echo "${secret}" >&2; exit 3`);
    await assert.rejects(mustRun({ program: 'docker', args: ['ps'], sudo: failed, stateDir }),
      (error) => error instanceof StderrKeepError && error.message.startsWith('docker ps ended (exit 3), but '));
    const slow = await script(`keep-slow-${why}`, `echo "${secret}" >&2; exec sleep 30`);
    await assert.rejects(runContainerCommand({ program: 'docker', args: ['exec'], sudo: slow, stateDir, timeoutMs: 300 }),
      (error) => {
        assert.ok(error instanceof ContainerTimeoutError, error.constructor.name);
        assert.ok(error.cause instanceof ContainerTimeoutError, 'the original as its cause');
        assert.equal(error.message, `docker exec ran past 300 ms: stopped, its output no longer read; and its stderr `
          + `could not be kept in stderr/ of the state (${why}) (the call ended in ContainerTimeoutError)`);
        assert.ok(!error.message.includes('ghs_'));
        return true;
      });
  }
  await chmod(join(readOnly, 'stderr'), 0o700);
});

test('review round 1 of factory#22, GEN-31: in the task container, a stderr that cannot be kept ends the task BLOCKED, '
  + 'and a call past its time is still a CallTimeoutError', { timeout: 20_000 }, async () => {
  const { CallTimeoutError, callInTask, execInTask } = await import('../src/container/task-container.mjs');
  const { createTask, loadTask } = await import('../src/state/tasks.mjs');
  const stateDir = join(root.dir, 'keep-task');
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(join(stateDir, 'stderr'), '');
  const runId = '20261120T101500Z-3f9a1c';
  // docker exec writes to stderr; a docker ps (the kill's list of the task's containers) answers at once.
  const sudo = await script('keep-exec', 'for a in "$@"; do [ "$a" = ps ] && exit 0; done\necho noise >&2\n'
    + 'for a in "$@"; do [ "$a" = hang ] && exec sleep 30; done\nexit 0');
  const container = { runId, id: 'c'.repeat(64), remoteUser: 'dev', stateDir };
  const task = await createTask(stateDir, { runId });
  const blocked = await callInTask({ stateDir, task, container, sudo, limitS: 5, args: ['true'] });
  assert.equal(blocked.result, null);
  assert.equal(blocked.task.status, 'blocked');
  assert.match(blocked.task.reason, /^docker exec ended \(exit 0\), but its stderr could not be kept in stderr\/ of the state \(StateError\)/);
  assert.deepEqual(await loadTask(stateDir, runId), blocked.task);
  await assert.rejects(execInTask({ container, sudo, limitS: 1, graceS: 1, marginS: 1, args: ['hang'] }), (error) => {
    assert.ok(error instanceof CallTimeoutError, error.constructor.name);
    assert.match(error.message, /ran past 1 s and was killed: docker exec ran past 3000 ms: stopped, its output no longer read; and its stderr could not be kept/);
    return true;
  });
});
