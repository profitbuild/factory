// The dispatcher's state under $FACTORY_STATE_DIR (incident-platform backlog #0-275): the directory checked, never
// changed; every write atomic (a temporary file renamed: the old file whole until the rename); directories 700 and
// files 600; and the breaker's state.json with the semantics of incident-platform's state.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  breakerRefusal, HISTORY_LIMIT, openBreaker, recordOutcome, TRIPPED,
} from '../src/state/breaker.mjs';
import {
  checkStateDir, ensureOwnDirectory, NotJsonError, readJson, StateError, writeJsonAtomic,
} from '../src/state/files.mjs';
import { run } from '../testing/children.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const mode = async (path) => (await stat(path)).mode & 0o777;

test('FACTORY_STATE_DIR is refused, by the variable\'s name, unless it is a directory of this user\'s, 700',
  async (t) => {
    const state = await makeStateDir();
    t.after(state.remove);
    await checkStateDir(state.dir);
    const refused = (pattern) => (error) => {
      assert.ok(error instanceof StateError, error.message);
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(state.dir), 'the refusal holds the path');
      return true;
    };
    await assert.rejects(checkStateDir(join(state.dir, 'missing')), refused(/^FACTORY_STATE_DIR does not exist/));
    await writeFile(join(state.dir, 'file'), '');
    await assert.rejects(checkStateDir(join(state.dir, 'file')), refused(/^FACTORY_STATE_DIR is not a directory/));
    await mkdir(join(state.dir, 'real'), { mode: 0o700 });
    await symlink(join(state.dir, 'real'), join(state.dir, 'link'));
    await assert.rejects(checkStateDir(join(state.dir, 'link')), refused(/is not a directory \(a symlink is refused\)/));
    await checkStateDir(join(state.dir, 'real'));
    for (const open of [0o750, 0o705, 0o770, 0o777]) {
      await chmod(join(state.dir, 'real'), open);
      await assert.rejects(checkStateDir(join(state.dir, 'real')),
        refused(new RegExp(`^FACTORY_STATE_DIR has mode ${open.toString(8)}: it must be 700$`)));
      assert.equal(await mode(join(state.dir, 'real')), open, 'the mode is left as it was found');
    }
    await assert.rejects(checkStateDir(state.dir, { uid: process.getuid() + 1 }),
      refused(/^FACTORY_STATE_DIR is owned by uid \d+, not by this process's/));
  });

test('the directories below it are made 700, and one made exclusively is made once', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const dir = join(state.dir, 'tasks');
  await ensureOwnDirectory(dir);
  await ensureOwnDirectory(dir);
  assert.equal(await mode(dir), 0o700);
  await assert.rejects(ensureOwnDirectory(dir, { exclusive: true }), { code: 'EEXIST' });
  await chmod(dir, 0o755);
  await assert.rejects(ensureOwnDirectory(dir), /has mode 755: it must be 700/);
});

test('a write is atomic: until the rename the old file is whole; after it, the new one; the file is 600',
  async (t) => {
    const state = await makeStateDir();
    t.after(state.remove);
    const path = join(state.dir, 'x.json');
    await writeJsonAtomic(path, { n: 1 });
    assert.equal(await mode(path), 0o600);
    let seen;
    await writeJsonAtomic(path, { n: 2, big: 'y'.repeat(100_000) }, {
      beforeRename: async (temporary) => {
        assert.equal(await mode(temporary), 0o600);
        seen = JSON.parse(await readFile(path, 'utf8'));
      },
    });
    assert.deepEqual(seen, { n: 1 }, 'the old file is whole while the new one is written');
    assert.equal((await readJson(path)).n, 2);
    assert.deepEqual((await readdir(state.dir)).sort(), ['x.json'], 'no temporary file is left');
  });

test('a write that fails before the rename leaves the old file and no temporary one', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const path = join(state.dir, 'x.json');
  await writeJsonAtomic(path, { n: 1 });
  await assert.rejects(writeJsonAtomic(path, { n: 2 }, { beforeRename: async () => { throw new Error('killed'); } }),
    /killed/);
  assert.deepEqual(await readJson(path), { n: 1 });
  assert.deepEqual(await readdir(state.dir), ['x.json']);
});

test('a state file is read only when it is this user\'s and 600; one not JSON is refused without being quoted',
  async (t) => {
    const state = await makeStateDir();
    t.after(state.remove);
    assert.equal(await readJson(join(state.dir, 'none.json')), undefined);
    const path = join(state.dir, 'x.json');
    await writeFile(path, '{"secret-ish": ', { mode: 0o600 });
    await assert.rejects(readJson(path), (error) => error instanceof NotJsonError && !error.message.includes('secret'));
    await chmod(path, 0o644);
    await assert.rejects(readJson(path), /has mode 644/);
  });

const t0 = Date.parse('2026-11-20T10:00:00Z');

test('state.json: missing, it is written fresh; shipped and blocked count as state.sh counts', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const fresh = { consecutiveBlocked: 0, shippedSinceAudit: 0, lastAudit: null, history: [] };
  assert.deepEqual((await openBreaker(state.dir)).state, fresh);
  assert.deepEqual(await readJson(join(state.dir, 'state.json')), fresh);
  assert.equal(await mode(join(state.dir, 'state.json')), 0o600);

  await recordOutcome(state.dir, { outcome: 'blocked', item: '0-1', stage: 'review', now: () => t0 });
  await recordOutcome(state.dir, { outcome: 'blocked', item: '0-2', pr: 'https://x/pr/2', now: () => t0 });
  let next = (await openBreaker(state.dir)).state;
  assert.equal(next.consecutiveBlocked, 2);
  assert.deepEqual(next.history, [
    { t: '2026-11-20T10:00:00Z', item: '0-1', outcome: 'blocked', pr: '', stage: 'review' },
    { t: '2026-11-20T10:00:00Z', item: '0-2', outcome: 'blocked', pr: 'https://x/pr/2' },
  ]);
  next = await recordOutcome(state.dir, { outcome: 'shipped', item: '0-3', pr: 'https://x/pr/3', now: () => t0 });
  assert.equal(next.consecutiveBlocked, 0);
  assert.equal(next.shippedSinceAudit, 1);
  assert.deepEqual(next.history.at(-1), { t: '2026-11-20T10:00:00Z', item: '0-3', outcome: 'shipped',
    pr: 'https://x/pr/3' });
});

test('state.json: the history keeps the last 200 outcomes', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const history = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ t: 'x', item: `0-${i}`, outcome: 'shipped',
    pr: '' }));
  await writeJsonAtomic(join(state.dir, 'state.json'),
    { consecutiveBlocked: 0, shippedSinceAudit: 0, lastAudit: null, history });
  const next = await recordOutcome(state.dir, { outcome: 'shipped', item: '0-new', now: () => t0 });
  assert.equal(next.history.length, HISTORY_LIMIT);
  assert.equal(next.history[0].item, '0-1');
  assert.equal(next.history.at(-1).item, '0-new');
});

test('the breaker refuses at FACTORY_MAX_BLOCKED in a row, and not below', () => {
  const at = (n) => ({ path: '/s/state.json', unreadable: false,
    state: { consecutiveBlocked: n, shippedSinceAudit: 0, lastAudit: null, history: [] } });
  assert.equal(breakerRefusal(at(2), 3), null);
  assert.match(breakerRefusal(at(3), 3), /^the breaker has tripped: 3 tasks blocked in a row, FACTORY_MAX_BLOCKED is 3/);
  assert.match(breakerRefusal(at(4), 3), /tripped/);
});

test('state.json unreadable: a tripped breaker, the file left for the owner to repair or delete knowingly',
  async (t) => {
    const state = await makeStateDir();
    t.after(state.remove);
    const path = join(state.dir, 'state.json');
    for (const text of ['{not json', '[]', '{"consecutiveBlocked":"1","shippedSinceAudit":0,"history":[]}',
      '{"consecutiveBlocked":-1,"shippedSinceAudit":0,"history":[]}', '{"consecutiveBlocked":0,"shippedSinceAudit":0}',
      '']) {
      await writeFile(path, text, { mode: 0o600 });
      const breaker = await openBreaker(state.dir);
      assert.equal(breaker.unreadable, true, text);
      assert.equal(breaker.state.consecutiveBlocked, TRIPPED);
      assert.match(breakerRefusal(breaker, 1000), new RegExp('^the breaker\'s state .*state\\.json cannot be read, so '
        + 'the breaker counts as tripped: repair the file .*, or delete it knowingly, which resets the breaker to '
        + 'zero and forgets the history$'));
      await assert.rejects(recordOutcome(state.dir, { outcome: 'shipped', item: '0-1' }), /cannot be read/);
      assert.equal(await readFile(path, 'utf8'), text, 'the file is left as it was');
    }
  });

test('#0-303 AC2: two processes recording outcomes at once, under the state\'s lock, lose none of them', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const script = join(state.dir, 'recorder.mjs');
  await writeFile(script, `import { recordOutcome } from ${JSON.stringify(new URL('../src/state/breaker.mjs', import.meta.url).href)};
for (let i = 0; i < Number(process.argv[3]); i += 1) {
  await recordOutcome(process.argv[2], { outcome: 'blocked', item: \`0-\${process.pid}\`, stage: String(i) });
}
`);
  const per = 25;
  const results = await Promise.all([1, 2].map(() => run(script, [state.dir, String(per)])));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const { state: breaker } = await openBreaker(state.dir);
  assert.equal(breaker.consecutiveBlocked, 2 * per, 'every blocked task counted');
  assert.equal(breaker.history.length, 2 * per, 'and every one in the history');
  assert.equal(new Set(breaker.history.map((h) => h.item)).size, 2, 'from both writers');
});
