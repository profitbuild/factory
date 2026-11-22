// A module's length, held (incident-platform backlog #0-317). The factory's modules open with a header of their
// invariants, which a reader can hold only while the module is short; nothing held that, and some had grown past it.
// So every .mjs file of dispatcher/src/, dispatcher/bin/, dispatcher/testing/ and hooks/ is held to two limits, the
// design of opencomputer's computer/scripts/max-lines.mjs (its design only, none of its code): past SOFT lines a
// warning (t.diagnostic, in the test's output, no failure), past HARD a failure that names the file, its lines and the
// limit. The files already past HARD when this test came in are on RATCHET, each at its own length, which may only
// shrink.
//
// The tests (dispatcher/test/) are out of scope: they grow with what they cover, and a limit there would make adding a
// test the thing that fails. Only .mjs files are counted, not the JSON beside them.
//
// A file's lines are the count of its `\n`, plus one when its last line does not end with one: `wc -l` for a file that
// ends with a newline, and one more for a last line without it.
//
// The check (checkLengths) is apart from the reading of a tree (readLengths), so the tests below hold it on trees made
// for them, and the last one on this repository's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ soft: 400, hard: 600 });

/** The directories held, from the repository's root. */
export const SCOPE = Object.freeze(['dispatcher/src', 'dispatcher/bin', 'dispatcher/testing', 'hooks']);

// The ratchet: the files over the hard limit when this test came in (origin/main at 7a31dc5), each at its length then.
// No limit is raised here; the file is shortened. The rule: an entry equals its file's length now. Shorten a file and
// lower its entry, in the same change; a file down to 600 lines or fewer leaves the list. A file is added only if it
// was over the limit when the test came in: a new one over 600 is split, not listed. This test holds each entry to its
// file's length; that the list only shrinks, that no file is added and that no limit is raised it cannot see (it knows
// no history): review holds those, and sees any change of RATCHET or LIMITS.
export const RATCHET = Object.freeze({
  'dispatcher/testing/fake-daemon.mjs': 640,
});

/** The lines of a text: its `\n`, and one more when the last line has none. */
export function countLines(text) {
  let count = 0;
  for (const c of text) {
    if (c === '\n') {
      count += 1;
    }
  }
  return text.length > 0 && !text.endsWith('\n') ? count + 1 : count;
}

/**
 * The lines of every .mjs file under SCOPE in `root`, by its path from `root` with `/`. A directory of SCOPE that is
 * missing throws: a scope that went away would hold nothing.
 */
export async function readLengths(root) {
  const lengths = {};
  for (const dir of SCOPE) {
    const entries = await readdir(join(root, dir), { withFileTypes: true, recursive: true });
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.mjs'))) {
      const path = join(entry.parentPath, entry.name);
      lengths[relative(root, path).split(sep).join('/')] = countLines(await readFile(path, 'utf8'));
    }
  }
  return lengths;
}

/** The failures and the warnings of `lengths` ({ path: lines }) against `ratchet` ({ path: lines }) and `limits`. */
export function checkLengths(lengths, ratchet = RATCHET, limits = LIMITS) {
  const failures = [];
  const warnings = [];
  for (const [file, lines] of Object.entries(lengths).sort(([a], [b]) => a.localeCompare(b))) {
    if (Object.hasOwn(ratchet, file)) {
      const entry = ratchet[file];
      if (lines > entry) {
        failures.push(`${file}: ${lines} lines, over its entry in RATCHET (${entry}): a file on the list may only shrink`);
      } else if (lines <= limits.hard) {
        failures.push(`${file}: ${lines} lines, within the hard limit of ${limits.hard}: remove its entry from RATCHET`);
      } else if (lines < entry) {
        failures.push(`${file}: ${lines} lines, under its entry in RATCHET (${entry}): lower its entry in RATCHET to ${lines}`);
      }
    } else if (lines > limits.hard) {
      failures.push(`${file}: ${lines} lines, over the hard limit of ${limits.hard}: split it`);
    } else if (lines > limits.soft) {
      warnings.push(`${file}: ${lines} lines, over the soft limit of ${limits.soft}`);
    }
  }
  for (const file of Object.keys(ratchet).filter((f) => !Object.hasOwn(lengths, f)).sort()) {
    failures.push(`${file}: on RATCHET but not a .mjs file of the scope: remove its entry from RATCHET`);
  }
  return { failures, warnings };
}

/** A tree of SCOPE's directories and dispatcher/test/, with `files` ({ path: lines }) of that many lines each. */
async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'max-lines-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [...SCOPE, 'dispatcher/test']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const [path, lines] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'x\n'.repeat(lines));
  }
  return root;
}

const LISTED = { 'dispatcher/testing/big.mjs': 640 };

test('countLines: wc -l, and one more for a last line without a newline', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('\n\n'), 2);
});

test('AC1: a module over the hard limit, not on the list, fails with its name, its lines and the limit', async (t) => {
  const root = await tree(t, { 'dispatcher/src/flow/long.mjs': 601, 'hooks/short.mjs': 600 });
  const { failures } = checkLengths(await readLengths(root), {});
  assert.deepEqual(failures, ['dispatcher/src/flow/long.mjs: 601 lines, over the hard limit of 600: split it']);
});

test('AC1: each directory of the scope is held, a nested one included', async (t) => {
  const files = Object.fromEntries(SCOPE.map((dir) => [`${dir}/a/b.mjs`, 601]));
  const { failures } = checkLengths(await readLengths(await tree(t, files)), {});
  assert.equal(failures.length, SCOPE.length);
  for (const dir of SCOPE) {
    assert.ok(failures.some((f) => f.startsWith(`${dir}/a/b.mjs: 601 lines`)), dir);
  }
});

test('AC1: a file on the list that grew fails', async (t) => {
  const root = await tree(t, { 'dispatcher/testing/big.mjs': 641 });
  assert.deepEqual(checkLengths(await readLengths(root), LISTED).failures,
    ['dispatcher/testing/big.mjs: 641 lines, over its entry in RATCHET (640): a file on the list may only shrink']);
});

test('AC1: a file on the list at its entry passes', async (t) => {
  const root = await tree(t, { 'dispatcher/testing/big.mjs': 640 });
  assert.deepEqual(checkLengths(await readLengths(root), LISTED), { failures: [], warnings: [] });
});

test('AC1: a file on the list that shrank but is still over 600 fails until its entry is lowered', async (t) => {
  const root = await tree(t, { 'dispatcher/testing/big.mjs': 610 });
  assert.deepEqual(checkLengths(await readLengths(root), LISTED).failures,
    ['dispatcher/testing/big.mjs: 610 lines, under its entry in RATCHET (640): lower its entry in RATCHET to 610']);
  assert.deepEqual(checkLengths(await readLengths(root), { 'dispatcher/testing/big.mjs': 610 }).failures, []);
});

test('AC1: a file on the list down to 600 lines or fewer fails until its entry is removed', async (t) => {
  for (const lines of [600, 120]) {
    const root = await tree(t, { 'dispatcher/testing/big.mjs': lines });
    assert.deepEqual(checkLengths(await readLengths(root), LISTED).failures,
      [`dispatcher/testing/big.mjs: ${lines} lines, within the hard limit of 600: remove its entry from RATCHET`]);
  }
});

test('AC1: a file on the list that does not exist fails', async (t) => {
  const root = await tree(t, { 'dispatcher/testing/other.mjs': 10 });
  assert.deepEqual(checkLengths(await readLengths(root), LISTED).failures,
    ['dispatcher/testing/big.mjs: on RATCHET but not a .mjs file of the scope: remove its entry from RATCHET']);
});

test('AC1: a module between the soft and the hard limit warns and does not fail', async (t) => {
  const root = await tree(t, { 'dispatcher/src/a.mjs': 450, 'dispatcher/bin/b.mjs': 401, 'hooks/c.mjs': 400 });
  assert.deepEqual(checkLengths(await readLengths(root), {}), {
    failures: [],
    warnings: [
      'dispatcher/bin/b.mjs: 401 lines, over the soft limit of 400',
      'dispatcher/src/a.mjs: 450 lines, over the soft limit of 400',
    ],
  });
});

test('AC1: a test file over the hard limit does not fail: dispatcher/test/ is out of scope', async (t) => {
  const root = await tree(t, { 'dispatcher/test/big.test.mjs': 900, 'dispatcher/src/x.json': 900 });
  assert.deepEqual(await readLengths(root), {});
  assert.deepEqual(checkLengths(await readLengths(root), {}), { failures: [], warnings: [] });
});

test('a directory of the scope that is missing throws, not passes', async (t) => {
  const root = await tree(t, {});
  await rm(join(root, 'hooks'), { recursive: true });
  await assert.rejects(readLengths(root), { code: 'ENOENT' });
});

test('AC1: this repository\'s modules are within their limits, or on RATCHET at their length', async (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { failures, warnings } = checkLengths(await readLengths(root));
  for (const warning of warnings) {
    t.diagnostic(warning);
  }
  assert.deepEqual(failures, []);
});
