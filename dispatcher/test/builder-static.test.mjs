// What the code of builder-app's token holds and imports (incident-platform backlog #0-271): no app id, installation
// id or bot id in src/, bin/check-app.mjs or libexec/ (AC4; dev-token.mjs keeps its dev app's id, unchanged), and no
// function of node:fs that writes, in the modules the token passes through (AC2: never on the disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DISPATCHER = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(DISPATCHER, path), 'utf8');

async function filesUnder(dir) {
  const entries = await readdir(join(DISPATCHER, dir), { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(DISPATCHER.length));
}

test('no number of six digits or more (an app, installation or bot id) in the code of #0-271', async () => {
  const files = [...await filesUnder('src'), 'bin/check-app.mjs', ...await filesUnder('libexec')];
  const found = [];
  for (const file of files) {
    for (const match of (await read(file)).matchAll(/(?<![\w.])\d{6,}(?![\w.])/g)) {
      found.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(found, []);
  assert.match(await read('bin/dev-token.mjs'), /\d{6,}/, 'the check can find one (dev-token.mjs holds its app id)');
});

test('the modules the token passes through import from node:fs nothing that writes', async () => {
  const READ_ONLY = new Set(['constants', 'lstat', 'open']);
  for (const file of ['src/config/own-file.mjs', 'src/config/env-file.mjs', 'src/github/app-token.mjs',
    'src/github/checked-token.mjs', 'src/github/builder-token.mjs', 'src/github/check-app.mjs', 'bin/check-app.mjs']) {
    const text = await read(file);
    assert.doesNotMatch(text, /import \* as \w+ from 'node:fs/, file);
    assert.doesNotMatch(text, /require\(/, file);
    for (const [, names] of text.matchAll(/import \{([^}]*)\} from 'node:fs(?:\/promises)?'/g)) {
      for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) {
        assert.ok(READ_ONLY.has(name) || name === 'realpathSync', `${file} imports ${name} from node:fs`);
      }
    }
    assert.doesNotMatch(text, /O_(WRONLY|RDWR|CREAT|APPEND|TRUNC)/, `${file} opens a file for writing`);
  }
});

test('the askpass script is executable, as git runs it directly', async () => {
  assert.equal((await stat(join(DISPATCHER, 'libexec/git-askpass.sh'))).mode & 0o111, 0o111);
});
