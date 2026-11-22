// Who may count the live tasks and take a task's lock (incident-platform backlog #0-303; review round 2 of
// factory#25, 2). The slot section counts the live tasks before it takes its own task's lock, which is safe only
// because a task's liveness changes under the dispatcher's lock alone: acquireTaskLock, isLive and liveTasks are
// called only from cli.mjs, under that lock. A new caller of any of them must hold the dispatcher's lock first, and
// is then added to ALLOWED here knowingly; this test fails until it is. Read on the source of every module of src/,
// masked as child-process-scan.mjs masks it (comments, strings and templates blanked), the modules that define them
// (state/lock.mjs, state/tasks.mjs) apart. Its bounds: a call through an alias made elsewhere, or a dynamic import,
// is not seen; the review reads those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mask } from '../testing/child-process-scan.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const NAMES = ['acquireTaskLock', 'isLive', 'liveTasks'];
/** The modules that define them, and those that call them under the dispatcher's lock. */
const DEFINERS = ['state/lock.mjs', 'state/tasks.mjs'];
const ALLOWED = ['cli.mjs'];

/** The names of NAMES that `source` names in its code (an import or a call alike). */
export function namesUsed(source) {
  const { code } = mask(source);
  return NAMES.filter((name) => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code));
}

test('#0-303: acquireTaskLock, isLive and liveTasks are called from cli.mjs alone, under the dispatcher\'s lock',
  async () => {
    const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => relative(SRC, join(e.parentPath, e.name)));
    const found = [];
    for (const file of files.filter((f) => !DEFINERS.includes(f))) {
      for (const name of namesUsed(await readFile(join(SRC, file), 'utf8'))) {
        if (!ALLOWED.includes(file)) {
          found.push(`${file}: ${name}`);
        }
      }
    }
    assert.deepEqual(found, []);
    assert.deepEqual(namesUsed(await readFile(join(SRC, 'cli.mjs'), 'utf8')).sort(), ['acquireTaskLock', 'liveTasks'],
      'the scan sees cli.mjs\'s calls');
  });

test('#0-303: planted code is seen: an import, a call, and not a comment, a string or another name', () => {
  for (const code of [
    "import { liveTasks } from '../state/tasks.mjs';",
    'const live = await liveTasks(stateDir);',
    "import { isLive as alive } from '../state/lock.mjs';",
    'await acquireTaskLock(stateDir, runId);',
  ]) {
    assert.notDeepEqual(namesUsed(code), [], code);
  }
  for (const code of ['// liveTasks(stateDir)', "const s = 'isLive';", 'const isLiveNow = 1;', 'x.liveTasks(1);']) {
    assert.deepEqual(namesUsed(code), [], code);
  }
});
