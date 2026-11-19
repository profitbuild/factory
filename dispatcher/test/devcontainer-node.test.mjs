// The devcontainer runs the Node of .node-version (incident-platform backlog #0-268): its Dockerfile names that
// version in `FROM node:<version>-…@sha256:…`, a second copy of .node-version that nothing else keeps equal, so a
// bump of one without the other fails here. The digest is not checked here: it is read from the registry when the
// version is bumped, and a wrong one fails the image's build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the devcontainer image is the Node of .node-version, pinned by digest', async () => {
  const nodeVersion = (await read('.node-version')).trim();
  const froms = (await read('.devcontainer/Dockerfile')).split('\n').filter((line) => /^FROM\s/i.test(line));
  assert.equal(froms.length, 1, 'the Dockerfile has one FROM');
  const match = froms[0].match(/^FROM\s+node:([0-9][^-@\s]*)-[^@\s]+@sha256:[0-9a-f]{64}\s*$/);
  assert.ok(match, `FROM is node:<version>-<variant>@sha256:<digest>: ${froms[0]}`);
  assert.equal(match[1], nodeVersion);
});
