// The skeleton's test (incident-platform backlog #0-267; the passing half of its AC3, whose failing half is shown on
// CI with a planted defect): the module loads, and package.json keeps ADR-0060 D2, an ES module with no package from
// npm. A dependency added later fails here first, where a reviewer sees why it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { NAME } from '../src/index.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the module loads and names the package it is in', () => {
  assert.equal(NAME, "planted-failure");
});

test('package.json is an ES module with no dependency of any kind (ADR-0060 D2)', () => {
  assert.equal(pkg.type, 'module');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    'bundleDependencies', 'bundledDependencies']) {
    assert.equal(pkg[field], undefined, `package.json has ${field}`);
  }
});
