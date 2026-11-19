// The host's token script, bin/dev-token.mjs (incident-platform backlog #0-269), run as the owner runs it, against a
// fake GitHub: what it writes, where, with which modes, what it refuses, and that the token is in none of its output.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createVerify } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_PERMISSIONS, refreshDelayMs } from '../bin/dev-token.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { appKeyPair, decodeJwt, startFakeGitHub } from '../testing/fake-github.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/dev-token.mjs', import.meta.url));
const TOKEN = 'ghs_TheFakeTokenOfThisTest0123456789';
const { publicKey, privateKey } = appKeyPair();

// Each test sets what the fake answers.
const state = {};
const reset = () => Object.assign(state, {
  installationPermissions: { ...EXPECTED_PERMISSIONS },
  tokenPermissions: { ...EXPECTED_PERMISSIONS },
  repositories: ['profitbuild/factory'],
  expiresAt: () => '2026-11-19T13:00:00Z',
  failNextTokenRequest: false,
  tokenDelayMs: 0,
  minted: 0,
});

const jwtVerifies = (authorization) => {
  const { signed, signature, payload } = decodeJwt(authorization.replace(/^Bearer /, ''));
  return payload.iss === 5822112 && createVerify('RSA-SHA256').update(signed).verify(publicKey, signature);
};

const fake = await startFakeGitHub({
  'GET /repos/profitbuild/factory/installation': ({ headers }) => (jwtVerifies(headers.authorization)
    ? { status: 200, body: { id: 99, repository_selection: 'selected', permissions: state.installationPermissions } }
    : { status: 401, body: { message: 'A JSON web token could not be decoded' } }),
  'POST /app/installations/99/access_tokens': ({ headers }) => {
    if (!jwtVerifies(headers.authorization)) {
      return { status: 401, body: { message: 'Bad credentials' } };
    }
    if (state.failNextTokenRequest) {
      state.failNextTokenRequest = false;
      return { status: 503, body: { message: 'Service Unavailable' } };
    }
    state.minted += 1;
    // Each token its own, so a test can tell which one was revoked.
    const token = state.minted === 1 ? TOKEN : `${TOKEN}_${state.minted}`;
    return { status: 201, body: { token, expires_at: state.expiresAt(), permissions: state.tokenPermissions },
      delayMs: state.tokenDelayMs };
  },
  'GET /installation/repositories': () => ({
    status: 200,
    body: { total_count: state.repositories.length, repositories: state.repositories.map((n) => ({ full_name: n })) },
  }),
  'DELETE /installation/token': () => ({ status: 204 }),
});
after(() => fake.close());

const root = await mkdtemp(join(tmpdir(), 'dev-token-test-'));
after(() => rm(root, { recursive: true, force: true }));
let run = 0;

// Every --watch child is killed after its test, passed or failed: one left running keeps the test process alive.
const children = new Set();
afterEach(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  children.clear();
});

/** A fresh key directory and output directory; returns the paths and a runner of the script on them. */
async function setUp({ keyMode = 0o600 } = {}) {
  reset();
  run += 1;
  const keyDir = join(root, `key-${run}`);
  await mkdir(keyDir, { mode: 0o700 });
  const key = join(keyDir, 'app.pem');
  await writeFile(key, privateKey, { mode: keyMode });
  const out = join(root, `out-${run}`);
  const start = fake.requests.length;
  const exec = (extra = []) => new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '--api', fake.baseUrl, '--key', key, '--out', out, ...extra],
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  // --watch, as a child process the test signals; resolves the child and a reader of its stderr so far.
  const watch = () => {
    const child = spawn(process.execPath, [SCRIPT, '--api', fake.baseUrl, '--key', key, '--out', out, '--watch',
      '--retry-seconds', '0.2']);
    children.add(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, stderr: () => stderr };
  };
  return { key, keyDir, out, exec, watch, requests: () => fake.requests.slice(start) };
}

test('it writes the token to <out>/token, file 600 and directory 700, and prints it nowhere', async () => {
  const { out, exec, requests } = await setUp();
  const { code, stdout, stderr } = await exec();
  assert.equal(code, 0, stderr);
  assert.equal(await readFile(join(out, 'token'), 'utf8'), TOKEN);
  assert.equal((await stat(join(out, 'token'))).mode & 0o777, 0o600);
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(out), ['token'], 'no temporary file is left');
  assert.equal(stdout, '');
  assert.doesNotMatch(stderr, new RegExp(TOKEN));
  assert.match(stderr, /a token for profitbuild\/factory in .*token, expires 2026-11-19T13:00:00Z/);
  const post = requests().find((r) => r.method === 'POST');
  assert.deepEqual(post.body, { permissions: EXPECTED_PERMISSIONS }, 'exactly the three permissions are asked for');
  assert.equal(requests().some((r) => r.method === 'DELETE'), false, 'a token written is not revoked');
});

test('a token reaching a second repository is revoked, and nothing is written', async () => {
  const { out, exec, requests } = await setUp();
  state.repositories = ['profitbuild/factory', 'profitbuild/incident-platform'];
  const { code, stderr } = await exec();
  assert.equal(code, 1);
  assert.match(stderr, /installed on more than this repository/);
  await assert.rejects(stat(out), { code: 'ENOENT' });
  assert.ok(requests().some((r) => r.method === 'DELETE' && r.headers.authorization === `Bearer ${TOKEN}`));
});

test('an installation holding more than the three permissions gets no token asked for', async () => {
  const { out, exec, requests } = await setUp();
  state.installationPermissions = { ...EXPECTED_PERMISSIONS, workflows: 'write' };
  const { code, stderr } = await exec();
  assert.equal(code, 1);
  assert.match(stderr, /not exactly/);
  assert.equal(requests().some((r) => r.method === 'POST'), false);
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('a token whose permissions differ from those asked for is revoked, and nothing is written', async () => {
  const { out, exec, requests } = await setUp();
  state.tokenPermissions = { ...EXPECTED_PERMISSIONS, administration: 'write' };
  const { code } = await exec();
  assert.equal(code, 1);
  assert.ok(requests().some((r) => r.method === 'DELETE'));
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('a key readable by others is refused before any request', async () => {
  const { exec, requests } = await setUp({ keyMode: 0o644 });
  const { code, stderr } = await exec();
  assert.equal(code, 1);
  assert.match(stderr, /readable by others \(mode 644\)/);
  assert.equal(requests().length, 0);
});

test('an output directory that holds the key is refused, since it is mounted into the container', async () => {
  const { keyDir, exec, requests } = await setUp();
  for (const out of [keyDir, join(keyDir, '..')]) {
    const { code, stderr } = await exec(['--out', out]);
    assert.equal(code, 1);
    assert.match(stderr, /holds the key/);
  }
  assert.equal(requests().length, 0);
});

test('a new token comes 10 minutes before the last expires, never sooner than a minute from now', () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0);
  assert.equal(refreshDelayMs('2026-11-19T13:00:00Z', now), 50 * 60 * 1000);
  assert.equal(refreshDelayMs('2026-11-19T12:05:00Z', now), 60 * 1000);
});

/** Waits until `predicate` holds, polling every 20 ms, for at most 5 s. */
async function until(predicate, what) {
  for (let waited = 0; waited < 5000; waited += 20) {
    if (await predicate()) {
      return;
    }
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const exists = (path) => stat(path).then(() => true, () => false);
const revoked = (requests, token) => requests.some((r) => r.method === 'DELETE'
  && r.headers.authorization === `Bearer ${token}`);

test('--watch: SIGTERM revokes the current token and deletes the file', async () => {
  const { out, watch, requests } = await setUp();
  const { child, exited, stderr } = watch();
  await until(() => exists(join(out, 'token')), 'the token file');
  child.kill('SIGTERM');
  assert.equal(await exited, 0, stderr());
  assert.ok(revoked(requests(), TOKEN), 'the token is revoked');
  assert.equal(await exists(join(out, 'token')), false, 'the file is deleted');
  assert.doesNotMatch(stderr(), new RegExp(TOKEN));
});

test('--watch: GitHub not reached is tried again, and the token comes on the next try', async () => {
  const { out, watch } = await setUp();
  state.failNextTokenRequest = true;
  const { child, exited, stderr } = watch();
  await until(() => exists(join(out, 'token')), 'the token file after a retry');
  assert.match(stderr(), /503 Service Unavailable; the last token, if any, is kept/);
  assert.match(stderr(), /next try in 0.2 s/);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('--watch: a refresh replaces the token and revokes the one before', async () => {
  const { out, watch, requests } = await setUp();
  state.expiresAt = () => new Date(Date.now() + 1000).toISOString();
  const { child, exited } = watch();
  await until(async () => (await exists(join(out, 'token')))
    && (await readFile(join(out, 'token'), 'utf8')) !== TOKEN, 'a second token');
  await until(() => revoked(requests(), TOKEN), 'the first token revoked');
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('--watch: a refresh refused by a check revokes the last token and deletes the file', async () => {
  const { out, watch, requests } = await setUp();
  state.expiresAt = () => new Date(Date.now() + 1000).toISOString();
  const { child, exited, stderr } = watch();
  await until(() => exists(join(out, 'token')), 'the first token');
  state.repositories = ['profitbuild/factory', 'profitbuild/incident-platform'];
  await until(() => revoked(requests(), TOKEN), 'the last good token revoked');
  await until(async () => !(await exists(join(out, 'token'))), 'the file deleted');
  assert.match(stderr(), /the last token is revoked/);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('--api must be HTTPS, or HTTP to a loopback address', async () => {
  const { exec, requests } = await setUp();
  const { code, stderr } = await exec(['--api', 'http://api.example.com']);
  assert.equal(code, 1);
  assert.match(stderr, /--api must be an https:\/\/ URL/);
  assert.equal(requests().length, 0);
});

test('an output directory reaching the key through a symlink is refused', async () => {
  const { keyDir, exec, requests } = await setUp();
  const link = join(root, `link-${run}`);
  await symlink(keyDir, link);
  const { code, stderr } = await exec(['--out', link]);
  assert.equal(code, 1);
  assert.match(stderr, /holds the key/);
  assert.equal(requests().length, 0);
});

test('--watch: SIGTERM while a token is being minted waits for it, then revokes it', async () => {
  const { out, watch, requests } = await setUp();
  state.tokenDelayMs = 500;
  const { child, exited } = watch();
  await until(() => requests().some((r) => r.method === 'POST'), 'the token request in flight');
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(revoked(requests(), TOKEN), 'the token minted during the stop is revoked');
  assert.equal(await exists(join(out, 'token')), false);
});

test('--watch: a second signal while stopping is ignored, and the token is still revoked', async () => {
  const { out, watch, requests } = await setUp();
  state.tokenDelayMs = 500;
  const { child, exited, stderr } = watch();
  await until(() => requests().some((r) => r.method === 'POST'), 'the token request in flight');
  child.kill('SIGINT');
  await until(() => /SIGINT: revoking/.test(stderr()), 'the first stop');
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.match(stderr(), /SIGINT: already stopping/);
  assert.ok(revoked(requests(), TOKEN));
  assert.equal(await exists(join(out, 'token')), false);
});

test('--watch: SIGHUP (the terminal closed) revokes the token and deletes the file too', async () => {
  const { out, watch, requests } = await setUp();
  const { child, exited, stderr } = watch();
  await until(() => exists(join(out, 'token')), 'the token file');
  child.kill('SIGHUP');
  assert.equal(await exited, 0, stderr());
  assert.ok(revoked(requests(), TOKEN));
  assert.equal(await exists(join(out, 'token')), false);
});

test('--watch: a token file that cannot be deleted is still revoked, and the stop exits 1', async () => {
  const { out, watch, requests } = await setUp();
  const { child, exited, stderr } = watch();
  await until(() => exists(join(out, 'token')), 'the token file');
  await chmod(out, 0o500);
  try {
    child.kill('SIGTERM');
    assert.equal(await exited, 1);
  } finally {
    await chmod(out, 0o700);
  }
  assert.ok(revoked(requests(), TOKEN), 'the token is revoked all the same');
  assert.match(stderr(), /could not delete .*token \(EACCES\): delete it by hand/);
});
