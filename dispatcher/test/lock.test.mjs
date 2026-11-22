// The dispatcher's locks (incident-platform backlog #0-303, first #0-275 AC2): one mechanism, acquireLock, for the
// dispatcher's, a task's and the state's lock. A second run is refused while another process holds a lock it tries,
// and waits for one it may wait for; a run killed (SIGKILL: nothing of it runs after) leaves its locks free, with
// nothing to clean up, a child it left behind included (#0-303 AC1); a lock file replaced under a run is refused;
// isLive tries a lock once and tells whether a run holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LockHeldError, acquireDispatcherLock, acquireLock, acquireTaskLock, isLive, stateLockPath, taskLockPath,
  withStateLock,
} from '../src/state/lock.mjs';
import { kill, startUntil } from '../testing/children.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const LOCK_MODULE = new URL('../src/state/lock.mjs', import.meta.url).href;

/**
 * A script of the test's own, in its state directory (#0-303): `node holder.mjs <lock file>` takes that lock, and with
 * `--child` starts a process that sleeps and writes its pid to <lock file>.sleeper, then prints "locked" and holds
 * the lock until it is killed.
 */
async function holderScript(dir) {
  const path = join(dir, 'holder.mjs');
  await writeFile(path, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
await acquireLock(process.argv[2]);
if (process.argv[3] === '--child') {
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  sleeper.unref();
  writeFileSync(\`\${process.argv[2]}.sleeper\`, String(sleeper.pid));
}
process.stdout.write('locked\\n');
setInterval(() => {}, 60_000);
`);
  return path;
}

const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('AC2 of #0-275: a second run is refused while another process holds the dispatcher\'s lock, and a killed run '
  + 'leaves it free', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const holder = await startUntil(await holderScript(state.dir), [join(state.dir, 'lock')], 'locked');
  try {
    await assert.rejects(acquireDispatcherLock(state.dir, { wait: false }), (error) => {
      assert.ok(error instanceof LockHeldError, error.message);
      assert.match(error.message, /^another run holds the dispatcher's lock \(.*\/lock\)$/);
      return true;
    });
    await assert.rejects(acquireDispatcherLock(state.dir, { wait: 1 }), (error) => {
      assert.ok(error instanceof LockHeldError);
      assert.match(error.message, /^another run has held the dispatcher's lock \(.*\/lock\) for 1 s: refused, not waited for any longer$/);
      return true;
    });
  } finally {
    await kill(holder);
  }
  (await acquireDispatcherLock(state.dir, { wait: false })).release();
});

test('#0-303: a run waits for the dispatcher\'s lock another run releases within the wait, and takes it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const first = await acquireDispatcherLock(state.dir, { wait: false });
  setTimeout(() => first.release(), 500);
  const started = Date.now();
  const second = await acquireDispatcherLock(state.dir, { wait: 10 });
  assert.ok(Date.now() - started >= 400, 'it waited');
  second.release();
});

test('the same process cannot take a lock twice, and a release frees it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const lock = await acquireDispatcherLock(state.dir, { wait: false });
  try {
    await assert.rejects(acquireDispatcherLock(state.dir, { wait: false }), LockHeldError);
  } finally {
    lock.release();
  }
  lock.release();
  (await acquireDispatcherLock(state.dir, { wait: false })).release();
  await assert.rejects(acquireLock(join(state.dir, 'x'), { wait: 0 }), TypeError);
  await assert.rejects(acquireLock(join(state.dir, 'x'), { wait: 1.5 }), TypeError);
});

test('a lock file is the dispatcher\'s own: 600; one open to others is refused, not taken', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  (await acquireDispatcherLock(state.dir)).release();
  assert.equal((await stat(join(state.dir, 'lock'))).mode & 0o777, 0o600);
  await writeFile(join(state.dir, 'open'), '', { mode: 0o644 });
  await assert.rejects(acquireLock(join(state.dir, 'open')), /must be a regular file of this process's user with mode 600/);
  assert.throws(() => isLive(join(state.dir, 'open')), /must be a regular file of this process's user with mode 600/);
});

test('a lock file removed or replaced while a run takes it is refused, and the run holds nothing', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const path = join(state.dir, 'lock');
  const moved = () => renameSync(path, `${path}.old`);
  const replaced = () => { unlinkSync(path); writeFileSync(path, '', { mode: 0o600 }); };
  for (const swap of [moved, replaced]) {
    await assert.rejects(acquireDispatcherLock(state.dir, { afterFlock: swap }),
      /^Error: the lock .* was removed or replaced while it was taken: refused$/);
    (await acquireDispatcherLock(state.dir, { wait: false })).release();
  }
});

test('the flock(1) binary missing is an error that names it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  await assert.rejects(acquireDispatcherLock(state.dir, { flock: '/nonexistent/flock' }), /flock\(1\) could not be run/);
});

test('#0-303: isLive tries a lock once: held by another process or another descriptor, live; free or missing, not, '
  + 'and a free one is left free', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const path = join(state.dir, 'a-lock');
  assert.equal(isLive(path), false, 'no lock file: no live run');
  const held = await acquireLock(path);
  assert.equal(isLive(path), true, 'held by this process through another descriptor');
  held.release();
  assert.equal(isLive(path), false);
  (await acquireLock(path)).release();
  const holder = await startUntil(await holderScript(state.dir), [path], 'locked');
  try {
    assert.equal(isLive(path), true, 'held by another process');
  } finally {
    await kill(holder);
  }
  assert.equal(isLive(path), false, 'its run killed');
});

test('#0-303 AC1: a killed run\'s task lock is free again and its task no longer live, though a child of the run still '
  + 'runs', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const runId = '20261122T101500Z-0a0303';
  await mkdir(join(state.dir, 'tasks', runId), { recursive: true, mode: 0o700 });
  const lockPath = taskLockPath(state.dir, runId);
  const holder = await startUntil(await holderScript(state.dir), [lockPath, '--child'], 'locked');
  const sleeper = Number((await readFile(`${lockPath}.sleeper`, 'utf8')).trim());
  t.after(() => {
    if (running(sleeper)) {
      process.kill(sleeper, 'SIGKILL');
    }
  });
  assert.equal(isLive(lockPath), true);
  await assert.rejects(acquireTaskLock(state.dir, runId), (error) => {
    assert.ok(error instanceof LockHeldError);
    assert.match(error.message, new RegExp(`^the task ${runId} is live: another run holds its lock \\(`));
    return true;
  });
  await kill(holder);
  assert.equal(running(sleeper), true, 'the run\'s child outlives it');
  assert.equal(isLive(lockPath), false, 'the run killed, its task no longer live, its child running or not');
  const mine = await acquireTaskLock(state.dir, runId);
  mine.release();
});

test('#0-303: withStateLock runs one holder at a time, waits a few seconds for another, and releases on a throw',
  async (t) => {
    const state = await makeStateDir();
    t.after(state.remove);
    const order = [];
    const slow = withStateLock(state.dir, async () => {
      order.push('a in');
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      order.push('a out');
    });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await withStateLock(state.dir, async () => { order.push('b'); });
    await slow;
    assert.deepEqual(order, ['a in', 'a out', 'b']);
    await assert.rejects(withStateLock(state.dir, async () => { throw new Error('inside'); }), /^Error: inside$/);
    assert.equal(isLive(stateLockPath(state.dir)), false, 'released after the throw');
  });
