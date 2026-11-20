// The dispatcher's lock (incident-platform backlog #0-275 AC2, #0-261): a second run is refused while one holds it;
// a run killed (SIGKILL: nothing of it runs after) leaves it free, with nothing to clean up; a run that releases it
// leaves it free; a lock file replaced under a run is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireLock, LockHeldError } from '../src/state/lock.mjs';
import { kill, startUntil } from '../testing/children.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const HOLD_LOCK = fileURLToPath(new URL('../testing/hold-lock.mjs', import.meta.url));

test('AC2: a second run is refused while another process holds the lock, and a killed run leaves it free', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const holder = await startUntil(HOLD_LOCK, [state.dir], 'locked');
  try {
    assert.throws(() => acquireLock(state.dir), (error) => {
      assert.ok(error instanceof LockHeldError, error.message);
      assert.match(error.message, /^another run holds the dispatcher's lock \(.*\/lock\): one task at a time in v0$/);
      return true;
    });
    assert.throws(() => acquireLock(state.dir), LockHeldError, 'refused again: a refusal takes nothing');
  } finally {
    await kill(holder);
  }
  const lock = acquireLock(state.dir);
  lock.release();
});

test('AC2: the same process cannot take the lock twice, and a release frees it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const lock = acquireLock(state.dir);
  try {
    assert.throws(() => acquireLock(state.dir), LockHeldError);
  } finally {
    lock.release();
  }
  lock.release();
  acquireLock(state.dir).release();
});

test('the lock file is the dispatcher\'s own: 600', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  acquireLock(state.dir).release();
  assert.equal((await stat(join(state.dir, 'lock'))).mode & 0o777, 0o600);
});

test('a lock file open to others is refused, not taken', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  await writeFile(join(state.dir, 'lock'), '', { mode: 0o644 });
  assert.throws(() => acquireLock(state.dir), /must be a regular file of this process's user with mode 600/);
});

test('a lock file removed or replaced while a run takes it is refused, and the run holds nothing', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const path = join(state.dir, 'lock');
  const moved = () => renameSync(path, `${path}.old`);
  const replaced = () => { unlinkSync(path); writeFileSync(path, '', { mode: 0o600 }); };
  for (const swap of [moved, replaced]) {
    assert.throws(() => acquireLock(state.dir, { afterFlock: swap }),
      /^Error: the lock .* was removed or replaced while it was taken: refused$/);
    acquireLock(state.dir).release();
  }
});

test('the flock(1) binary missing is an error that names it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  assert.throws(() => acquireLock(state.dir, { flock: '/nonexistent/flock' }), /flock\(1\) could not be run/);
});
