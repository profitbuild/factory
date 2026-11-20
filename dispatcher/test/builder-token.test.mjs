// builder-app's token (incident-platform backlog #0-271, AC1 and the cache of AC2), against a fake GitHub: each
// refusal of src/github/checked-token.mjs as a test of its own, and the in-memory cache of
// src/github/builder-token.mjs.
// A key pair is generated per run; no real key or token is involved.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { chmod, rm, symlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

import { RefusedError, checkInstallation, mintCheckedToken, readAppKey } from '../src/github/checked-token.mjs';
import {
  BUILDER_PERMISSIONS, createBuilderTokenSource, mintBuilderToken,
} from '../src/github/builder-token.mjs';
import {
  APP_ID, INSTALLATION_ID, PERMISSIONS, filesContaining, makeRoot, startBuilderGitHub, tokenNumber, writeAppFiles,
} from '../testing/builder-github.mjs';

const clock = { now: Date.UTC(2026, 10, 19, 12, 0, 0) };
const fake = await startBuilderGitHub({ clock });
const root = await makeRoot('builder-token-test');
after(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  fake.reset();
  clock.now = Date.UTC(2026, 10, 19, 12, 0, 0);
});

const MINUTE = 60 * 1000;
/** The adapter's `repository` of these tests (incident-platform backlog #0-276: no product in the code). */
const REPOSITORY = 'profitbuild/incident-platform';
const requestsSince = (start) => fake.requests.slice(start);
const posts = (requests) => requests.filter((r) => r.method === 'POST');

/** A token source on fresh files; `env` and `uid` override what the files give. */
async function source({ keyMode, uid, env } = {}) {
  const files = await writeAppFiles(root, fake.privateKey, { keyMode });
  return {
    files,
    tokens: createBuilderTokenSource({ repository: REPOSITORY,
      env: { ...files.env, ...env }, baseUrl: fake.baseUrl, uid, now: () => clock.now,
    }),
  };
}

/**
 * The refusal of every AC1 case: a RefusedError matching `pattern`, whose message holds no token; no token held after
 * it (the next call mints again); a token minted is revoked; no token on the disk of the test.
 */
async function assertRefused(tokens, pattern) {
  await assert.rejects(tokens.getToken(), (error) => {
    assert.ok(error instanceof RefusedError, `a RefusedError, not ${error.constructor.name}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /ghs_/);
    return true;
  });
  assert.deepEqual(fake.state.revoked, fake.state.minted, 'every token minted is revoked');
  for (const token of fake.state.minted) {
    assert.deepEqual(await filesContaining(root, token), [], 'no token on the disk');
  }
  await assert.rejects(tokens.getToken(), RefusedError, 'nothing is held: the next call checks again');
}

test('a token passing every check is returned, narrowed to incident-platform, with exactly the three', async () => {
  const { tokens } = await source();
  const start = fake.requests.length;
  assert.equal(await tokens.getToken(), tokenNumber(1));
  const [post] = posts(requestsSince(start));
  assert.deepEqual(post.body, { permissions: PERMISSIONS, repositories: ['incident-platform'] });
  assert.deepEqual(BUILDER_PERMISSIONS, PERMISSIONS);
  assert.deepEqual(fake.state.revoked, [], 'a token used is not revoked');
});

// AC1: the key.

test('a key readable by others (644) is refused before any request', async () => {
  const { tokens } = await source({ keyMode: 0o644 });
  const start = fake.requests.length;
  await assertRefused(tokens, /the key .* has mode 644.*chmod 600/);
  assert.equal(requestsSince(start).length, 0);
});

test('a key readable by its group (640) is refused', async () => {
  const { tokens } = await source({ keyMode: 0o640 });
  await assertRefused(tokens, /the key .* has mode 640/);
  assert.equal(fake.state.minted.length, 0);
});

test('a key readable by others only (604) is refused', async () => {
  const { tokens } = await source({ keyMode: 0o604 });
  await assertRefused(tokens, /the key .* has mode 604/);
});

test('a key that is a symlink, even to a file of mode 600, is refused', async () => {
  const files = await writeAppFiles(root, fake.privateKey);
  const link = join(files.dir, 'link.pem');
  await symlink(files.keyPath, link);
  const tokens = createBuilderTokenSource({ repository: REPOSITORY, env: { ...files.env, keyPath: link }, baseUrl: fake.baseUrl,
    now: () => clock.now });
  await assertRefused(tokens, /the key .*link\.pem is not a regular file \(a symlink/);
  assert.equal(fake.state.minted.length, 0);
});

test('a key that is a directory is refused as not a regular file', async () => {
  const files = await writeAppFiles(root, fake.privateKey);
  const tokens = createBuilderTokenSource({ repository: REPOSITORY, env: { ...files.env, keyPath: files.dir }, baseUrl: fake.baseUrl,
    now: () => clock.now, uid: process.getuid() });
  await chmod(files.dir, 0o700);
  await assertRefused(tokens, /the key .* is not a regular file/);
});

// Should the open wait on the FIFO (O_NONBLOCK gone), the test must fail fast, not hang the run: an open blocked in
// libuv's thread pool keeps the process alive for ever. After 2 s it opens the FIFO for writing with
// O_WRONLY | O_NONBLOCK, which releases a reader blocked in open, lets the read settle, and fails.
test('a key swapped for a FIFO between the lstat and the open is refused at once, not waited on', async () => {
  const files = await writeAppFiles(root, fake.privateKey);
  const swap = async () => {
    await rm(files.keyPath);
    execFileSync('mkfifo', ['-m', '600', files.keyPath]);
  };
  const reading = readAppKey(files.keyPath, { afterLstat: swap });
  const outcome = await Promise.race([reading.then(() => 'settled', () => 'settled'),
    sleep(2000, 'blocked', { ref: false })]);
  if (outcome === 'blocked') {
    const writer = openSync(files.keyPath, constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      await reading.catch(() => {});
    } finally {
      closeSync(writer);
    }
    assert.fail('the open of the key waited on a FIFO for a writer');
  }
  await assert.rejects(reading, (error) => error instanceof RefusedError
    && /changed while it was read|is not a regular file/.test(error.message));
});

// Without root, a test cannot give a file another owner; the check is made to require another uid instead.
test('a key owned by another user is refused (the owner required set to another uid)', async () => {
  const { tokens } = await source({ uid: process.getuid() + 1 });
  await assertRefused(tokens, /the key .* is owned by uid \d+, not by this process's/);
  assert.equal(fake.state.minted.length, 0);
});

// AC1: the installation.

test('an installation holding a permission beyond the three gets no token asked for', async () => {
  fake.state.installation.permissions = { ...PERMISSIONS, issues: 'write' };
  const { tokens } = await source();
  await assertRefused(tokens, /holds .*"issues":"write".*, not exactly/);
  assert.equal(fake.state.minted.length, 0);
});

test('an installation missing one of the three gets no token asked for', async () => {
  const { pull_requests: _, ...two } = PERMISSIONS;
  fake.state.installation.permissions = two;
  const { tokens } = await source();
  await assertRefused(tokens, /not exactly/);
  assert.equal(fake.state.minted.length, 0);
});

test('an installation holding Pull requests read, not write, gets no token asked for', async () => {
  fake.state.installation.permissions = { ...PERMISSIONS, pull_requests: 'read' };
  const { tokens } = await source();
  await assertRefused(tokens, /"pull_requests":"read"/);
  assert.equal(fake.state.minted.length, 0);
});

test('an installation other than BUILDER_APP_INSTALLATION_ID\'s gets no token asked for', async () => {
  fake.state.installation.id = INSTALLATION_ID + 1;
  const { tokens } = await source();
  await assertRefused(tokens,
    new RegExp(`is ${INSTALLATION_ID + 1}, not ${INSTALLATION_ID} as BUILDER_APP_INSTALLATION_ID says`));
  assert.equal(fake.state.minted.length, 0);
});

test('an installation of another app gets no token asked for', async () => {
  fake.state.installation.app_id = APP_ID + 1;
  const { tokens } = await source();
  await assertRefused(tokens, new RegExp(`the app ${APP_ID + 1}'s, not ${APP_ID}'s`));
  assert.equal(fake.state.minted.length, 0);
});

// AC1: the token's repositories.

test('a token reaching a second repository is revoked and refused', async () => {
  fake.state.repositories = ['profitbuild/incident-platform', 'profitbuild/factory'];
  const { tokens } = await source();
  await assertRefused(tokens, /reaches \["profitbuild\/incident-platform","profitbuild\/factory"\]/);
  assert.deepEqual(fake.state.revoked, [tokenNumber(1), tokenNumber(2)]);
});

test('a token reaching another repository only is revoked and refused', async () => {
  fake.state.repositories = ['profitbuild/factory'];
  const { tokens } = await source();
  await assertRefused(tokens, /reaches \["profitbuild\/factory"\], not exactly \["profitbuild\/incident-platform"\]/);
});

test('a token reaching no repository is revoked and refused', async () => {
  fake.state.repositories = [];
  const { tokens } = await source();
  await assertRefused(tokens, /reaches \[\]/);
});

// AC1: the token's permissions.

test('a token holding a permission beyond the three is revoked and refused', async () => {
  fake.state.tokenPermissions = { ...PERMISSIONS, administration: 'write' };
  const { tokens } = await source();
  await assertRefused(tokens, /the token holds .*"administration":"write"/);
  assert.equal(fake.state.revoked[0], tokenNumber(1));
});

test('a token missing one of the three is revoked and refused', async () => {
  const { metadata: _, ...two } = PERMISSIONS;
  fake.state.tokenPermissions = two;
  const { tokens } = await source();
  await assertRefused(tokens, /the token holds \{"contents":"write","pull_requests":"write"\}/);
});

test('a token whose expiry is within 5 minutes is revoked and not returned', async () => {
  const files = await writeAppFiles(root, fake.privateKey);
  fake.state.expiresInMs = 5 * MINUTE;
  await assert.rejects(mintBuilderToken({ repository: REPOSITORY, env: files.env, baseUrl: fake.baseUrl, now: () => clock.now }),
    /less than 5 minutes from now: refused/);
  assert.deepEqual(fake.state.revoked, [tokenNumber(1)]);
});

// AC2: the cache.

test('a token is reused until 5 minutes before it expires, then minted again', async () => {
  const { tokens } = await source();
  const start = fake.requests.length;
  const first = await tokens.getToken();
  clock.now += 55 * MINUTE - 1;
  assert.equal(await tokens.getToken(), first, 'reused at 5 minutes and 1 ms before the expiry');
  assert.equal(posts(requestsSince(start)).length, 1);
  clock.now += 1;
  const second = await tokens.getToken();
  assert.notEqual(second, first, 'minted again at 5 minutes before the expiry');
  assert.equal(posts(requestsSince(start)).length, 2);
  assert.deepEqual(fake.state.revoked, [], 'the token replaced is not revoked');
});

test('calls made while a token is being minted share it: one request', async () => {
  fake.state.tokenDelayMs = 200;
  const { tokens } = await source();
  const start = fake.requests.length;
  const all = await Promise.all(Array.from({ length: 5 }, () => tokens.getToken()));
  assert.deepEqual(all, Array(5).fill(tokenNumber(1)));
  assert.equal(posts(requestsSince(start)).length, 1);
});

test('GitHub failing is thrown to every caller, nothing is held, and the next call mints', async () => {
  fake.state.failNextTokenRequest = true;
  const { tokens } = await source();
  const results = await Promise.allSettled([tokens.getToken(), tokens.getToken()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /503 Service Unavailable/);
  }
  assert.equal(await tokens.getToken(), tokenNumber(1));
});

test('a refresh that fails returns no token, not even the old one still valid for 5 minutes', async () => {
  const { tokens } = await source();
  await tokens.getToken();
  clock.now += 56 * MINUTE;
  fake.state.failNextTokenRequest = true;
  await assert.rejects(tokens.getToken(), /503/);
});

test('revoke() revokes the token held, and the source then refuses to mint', async () => {
  const { tokens } = await source();
  const token = await tokens.getToken();
  await tokens.revoke();
  assert.deepEqual(fake.state.revoked, [token]);
  await assert.rejects(tokens.getToken(), /closed/);
});

test('no token is in process.env, nor in the environment of a child spawned after one is minted', async () => {
  const { tokens } = await source();
  const token = await tokens.getToken();
  assert.equal(Object.values(process.env).some((value) => value?.includes(token)), false);
  const childEnv = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  assert.equal(childEnv.includes(token), false);
  assert.deepEqual(await filesContaining(root, token), []);
});

test('a refusal after the token is minted is thrown even when its revoke fails, not the revoke\'s error', async () => {
  fake.state.repositories = ['profitbuild/factory'];
  fake.state.failRevoke = true;
  const { tokens } = await source();
  await assert.rejects(tokens.getToken(), (error) => {
    assert.ok(error instanceof RefusedError, error.message);
    assert.match(error.message, /reaches \["profitbuild\/factory"\]/);
    return true;
  });
  assert.ok(fake.requests.some((r) => r.method === 'DELETE'), 'the revoke was tried');
});

test('an API that is neither HTTPS nor loopback is refused before the key is read or a JWT made', async () => {
  const files = await writeAppFiles(root, fake.privateKey);
  const start = fake.requests.length;
  for (const baseUrl of ['http://api.example.com', 'ftp://127.0.0.1']) {
    assert.throws(() => createBuilderTokenSource({ repository: REPOSITORY, env: files.env, baseUrl }), /the API must be an https:\/\/ URL/);
    let jwtMade = false;
    await assert.rejects(mintBuilderToken({ repository: REPOSITORY, env: files.env, baseUrl, fetchImpl: () => { jwtMade = true; } }),
      /the API must be an https:\/\/ URL/);
    assert.equal(jwtMade, false);
  }
  await assert.rejects(mintBuilderToken({ repository: REPOSITORY, env: { ...files.env, keyPath: '/nonexistent' },
    baseUrl: 'http://x.example' }),
    /the API must be/, 'refused before the key is read: no ENOENT');
  assert.equal(fake.requests.length, start);
});

// installationIdFrom has no default (incident-platform backlog #0-273): a caller that does not say where its expected
// installation id comes from is a programming error, thrown before any key is read or request made.
test('a caller of the installation check that does not name the source of the expected id is an error', async () => {
  const installation = { id: 1, app_id: 2, permissions: {} };
  assert.throws(() => checkInstallation(installation, { appId: 2, installationId: 1, permissions: {}, repository: 'o/r' }),
    TypeError);
  await assert.rejects(mintCheckedToken({ appId: 2, installationId: 1, keyPath: '/nonexistent', owner: 'o', repo: 'r',
    permissions: {}, baseUrl: 'http://127.0.0.1:1' }), TypeError);
});

test('AC3 (#0-276): the token is minted for the adapter\'s repository: another product\'s, narrowed to it', async () => {
  const files = await writeAppFiles(root, fake.privateKey);
  fake.state.repositories = ['profitbuild/other-product'];
  const start = fake.requests.length;
  const minted = await mintBuilderToken({ repository: 'profitbuild/other-product', env: files.env,
    baseUrl: fake.baseUrl, now: () => clock.now });
  assert.equal(minted.token, tokenNumber(1));
  const asked = fake.requests.slice(start);
  assert.ok(asked.some((r) => r.path === '/repos/profitbuild/other-product/installation'));
  assert.equal(asked.some((r) => r.path.includes('incident-platform')), false);
  assert.deepEqual(posts(asked).map((r) => r.body.repositories), [['other-product']]);
  await assert.rejects(mintBuilderToken({ repository: REPOSITORY, env: files.env, baseUrl: fake.baseUrl,
    now: () => clock.now }), RefusedError, 'a token reaching only the other product is refused for incident-platform');
});

test('a token source refuses a repository not in the adapter\'s shape, before any key is read', () => {
  for (const repository of [undefined, 'incident-platform', 'profitbuild/..', './x', 'a/b/c']) {
    assert.throws(() => createBuilderTokenSource({ repository, env: { appId: 1, installationId: 2, keyPath: '/x' },
      baseUrl: fake.baseUrl }), /a repository must be owner\/name, as the adapter has it/);
  }
});
