// builder-app's permissions as a file (incident-platform backlog #0-272, G2): src/github/builder-permissions.json, read
// here as text and parsed, independently of the module's import, is an object of "read" and "write" only, and
// BUILDER_PERMISSIONS is that object, frozen. What the three must be is builder-token.test.mjs's own expectation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BUILDER_PERMISSIONS } from '../src/github/builder-token.mjs';

const FILE = new URL('../src/github/builder-permissions.json', import.meta.url);

test('builder-permissions.json is an object of "read" and "write", and BUILDER_PERMISSIONS is it, frozen', async () => {
  const parsed = JSON.parse(await readFile(FILE, 'utf8'));
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'a JSON object');
  assert.ok(Object.keys(parsed).length > 0, 'at least one permission');
  for (const [name, level] of Object.entries(parsed)) {
    assert.ok(level === 'read' || level === 'write', `${name}: ${JSON.stringify(level)} is neither read nor write`);
  }
  assert.ok(Object.isFrozen(BUILDER_PERMISSIONS));
  assert.deepEqual(BUILDER_PERMISSIONS, parsed);
});
