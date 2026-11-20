// readOwnFile's bytes and their bound (incident-platform backlog #0-276, review round 1 gen-3a71): `encoding: null`
// gives the bytes; a file one byte over `maxBytes` is refused, with no read, and one exactly at it is read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readOwnFile } from '../src/config/own-file.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);

const read = (path, options) => readOwnFile(path, {
  what: 'the file', forbiddenMode: 0o077, refuse: (message) => new Error(message), ...options,
});

test('a file one byte over maxBytes is refused; one exactly at it is read, as bytes or as text', async () => {
  const path = join(root.dir, 'f');
  await writeFile(path, Buffer.alloc(100, 0x61), { mode: 0o600 });
  await assert.rejects(read(path, { maxBytes: 99, encoding: null }), /^Error: the file .* is 100 bytes, more than 99$/);
  const bytes = await read(path, { maxBytes: 100, encoding: null });
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, 100);
  assert.equal(await read(path, { maxBytes: 100 }), 'a'.repeat(100), 'utf8 by default');
  assert.equal(await read(path), 'a'.repeat(100), 'no bound when none is given');
});
