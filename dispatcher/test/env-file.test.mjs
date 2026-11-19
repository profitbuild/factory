// The dispatcher's env file (incident-platform backlog #0-271): builder-app's ids and key path come from it, and a
// malformed or loose one is refused, naming the line and the key, never a value.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigError, DEFAULT_KEY_PATH, parseDispatcherEnv, readDispatcherEnv } from '../src/config/env-file.mjs';
import { makeRoot } from '../testing/builder-github.mjs';

const root = await makeRoot('env-file-test');
after(() => rm(root, { recursive: true, force: true }));
let n = 0;
async function envFile(text, mode = 0o600) {
  n += 1;
  const path = join(root, `env-${n}`);
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, mode);
  return path;
}

const refused = (text, pattern) => assert.throws(() => parseDispatcherEnv(text, 'env'), (error) => {
  assert.ok(error instanceof ConfigError);
  assert.match(error.message, pattern);
  return true;
});

test('the ids and the key path are read; comments, blank lines and other settings are skipped', async () => {
  const path = await envFile('# builder-app\n\nBUILDER_APP_ID=12\r\nBUILDER_APP_INSTALLATION_ID=34\n'
    + 'BUILDER_APP_KEY=/srv/key.pem\nFACTORY_OTHER=whatever\n');
  assert.deepEqual(await readDispatcherEnv(path), { appId: 12, installationId: 34, keyPath: '/srv/key.pem' });
  assert.equal(parseDispatcherEnv('BUILDER_APP_ID=1\nBUILDER_APP_INSTALLATION_ID=2\n').keyPath, DEFAULT_KEY_PATH);
});

test('an unknown key with the prefix BUILDER_APP_ is refused, with its line', () => {
  refused('BUILDER_APP_ID=1\nBUILDER_APP_INSTALATION_ID=2\n', /^env, line 2: unknown key BUILDER_APP_INSTALATION_ID/);
});

test('a missing id, a malformed line, a duplicate, and a value that is not an id or a path are refused', () => {
  refused('BUILDER_APP_ID=1\n', /BUILDER_APP_INSTALLATION_ID is missing/);
  refused('BUILDER_APP_ID=1\nexport BUILDER_APP_INSTALLATION_ID=2\n', /line 2: not KEY=value/);
  refused('BUILDER_APP_ID=1\nBUILDER_APP_ID=1\nBUILDER_APP_INSTALLATION_ID=2\n',
    /line 2: BUILDER_APP_ID set again \(first on line 1\)/);
  for (const value of ['0', '-1', '1.5', '"12"', ' 12', '12 ', '0x10', '99999999999999999999']) {
    refused(`BUILDER_APP_ID=${value}\nBUILDER_APP_INSTALLATION_ID=2\n`,
      /line 1: BUILDER_APP_ID must be a positive integer$/);
  }
  refused('BUILDER_APP_ID=1\nBUILDER_APP_INSTALLATION_ID=2\nBUILDER_APP_KEY=key.pem\n',
    /line 3: BUILDER_APP_KEY must be an absolute path$/);
});

test('a refusal never quotes the value', () => {
  refused('BUILDER_APP_ID=ghs_SomethingPastedByMistake\nBUILDER_APP_INSTALLATION_ID=2\n',
    /^env, line 1: BUILDER_APP_ID must be a positive integer$/);
});

test('a file writable by group or others, a symlink, or another owner\'s file is refused', async () => {
  const text = 'BUILDER_APP_ID=1\nBUILDER_APP_INSTALLATION_ID=2\n';
  await assert.rejects(readDispatcherEnv(await envFile(text, 0o620)), /has mode 620/);
  await assert.rejects(readDispatcherEnv(await envFile(text, 0o602)), /has mode 602/);
  assert.equal((await readDispatcherEnv(await envFile(text, 0o644))).appId, 1, 'readable by others is fine');
  const link = join(root, 'link');
  await symlink(await envFile(text), link);
  await assert.rejects(readDispatcherEnv(link), /not a regular file/);
  await assert.rejects(readDispatcherEnv(await envFile(text), { uid: process.getuid() + 1 }), /owned by uid/);
  await assert.rejects(readDispatcherEnv(join(root, 'none')), { code: 'ENOENT' });
});
