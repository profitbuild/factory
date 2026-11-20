// The host's token script, bin/dev-token.mjs (incident-platform backlog #0-269), run as the owner runs it, against a
// fake GitHub: what it writes, where, with which modes, what it refuses, and that the token is in none of its output.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createVerify } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_PERMISSIONS, mint, refreshDelayMs } from '../bin/dev-token.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { appKeyPair, decodeJwt, startFakeGitHub } from '../testing/fake-github.mjs';
import { GITHUB_API } from '../src/github/app-token.mjs';
import { checkApiUrl } from '../src/github/checked-token.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/dev-token.mjs', import.meta.url));
const TOKEN = 'ghs_TheFakeTokenOfThisTest0123456789';
const { publicKey, privateKey } = appKeyPair();
// The dev app's ids, as dev-token.mjs has them by default (APP_ID, INSTALLATION_ID).
const APP_ID = 5822112;
const INSTALLATION_ID = 183439507;

// Each test sets what the fake answers.
const state = {};
const reset = () => Object.assign(state, {
  installationId: INSTALLATION_ID,
  installationAppId: APP_ID,
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
  return payload.iss === APP_ID && createVerify('RSA-SHA256').update(signed).verify(publicKey, signature);
};

const fake = await startFakeGitHub({
  'GET /repos/profitbuild/factory/installation': ({ headers }) => (jwtVerifies(headers.authorization)
    ? { status: 200, body: { id: state.installationId, app_id: state.installationAppId, repository_selection: 'selected',
      permissions: state.installationPermissions } }
    : { status: 401, body: { message: 'A JSON web token could not be decoded' } }),
  [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: ({ headers }) => {
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
  assert.match(stderr, /has mode 644.*chmod 600/);
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

test('--api must be GitHub\'s API, or a test\'s HTTP origin on a loopback address: any other host is refused', async () => {
  const { exec, requests } = await setUp();
  for (const api of ['http://api.example.com', 'https://api.example.com', 'https://api.github.com.evil.example',
    'https://api.github.com:8443', 'https://API.github.com', 'https://api.github.com/']) {
    const { code, stderr } = await exec(['--api', api]);
    assert.equal(code, 1, api);
    assert.match(stderr, /--api must be https:\/\/api\.github\.com, or a test's http:\/\/ origin on a loopback address/, api);
  }
  assert.equal(requests().length, 0);
});

test('--api left to its default, GitHub\'s API, passes the rule: dev-token on the host goes on as before', () => {
  assert.equal(checkApiUrl(GITHUB_API, '--api'), GITHUB_API);
  assert.equal(GITHUB_API, 'https://api.github.com');
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

test('a key that is a symlink, even to a file of mode 600, is refused before any request', async () => {
  const { key, keyDir, exec, requests } = await setUp();
  const link = join(keyDir, 'link.pem');
  await symlink(key, link);
  const { code, stderr } = await exec(['--key', link]);
  assert.equal(code, 1);
  assert.match(stderr, /the key .*link\.pem is not a regular file \(a symlink/);
  assert.equal(requests().length, 0);
});

// O_NONBLOCK makes the open return at once; without it the child would wait on the FIFO for a writer, and the test
// fails on the timeout instead of hanging the run.
test('a key that is a FIFO is refused at once, not waited on, before any request', async () => {
  const { keyDir, exec, requests } = await setUp();
  const fifo = join(keyDir, 'fifo.pem');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const outcome = await Promise.race([exec(['--key', fifo]), sleep(5000, 'blocked', { ref: false })]);
  assert.notEqual(outcome, 'blocked', 'the read of the key waited on a FIFO');
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /the key .*fifo\.pem is not a regular file/);
  assert.equal(requests().length, 0);
});

// Without root, a test cannot give a file another owner; mint is called in this process with another uid required,
// which no option of the command line can set.
test('a key owned by another user is refused before any request (the owner required set to another uid)', async () => {
  const { key, out, exec, requests } = await setUp();
  const opts = { key, out, api: fake.baseUrl, appId: APP_ID, installationId: INSTALLATION_ID, owner: 'profitbuild',
    repo: 'factory', uid: process.getuid() + 1 };
  await assert.rejects(mint(opts), /the key .* is owned by uid \d+, not by this process's/);
  assert.equal(requests().length, 0);
  const { code, stderr } = await exec(['--uid', String(process.getuid() + 1)]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown option '--uid'/, 'the owner required is not an option');
});

test('an installation of another app is refused, and no token is asked for', async () => {
  const { out, exec, requests } = await setUp();
  state.installationAppId = APP_ID + 1;
  const { code, stderr } = await exec();
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`the app ${APP_ID + 1}'s, not ${APP_ID}'s`));
  assert.equal(requests().some((r) => r.method === 'POST'), false);
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('an installation other than INSTALLATION_ID (the app installed again) is refused, and no token is asked for',
  async () => {
    const { out, exec, requests } = await setUp();
    state.installationId = INSTALLATION_ID + 1;
    const { code, stderr } = await exec();
    assert.equal(code, 1);
    assert.match(stderr,
      new RegExp(`is ${INSTALLATION_ID + 1}, not ${INSTALLATION_ID} as INSTALLATION_ID / --installation-id says`));
    assert.doesNotMatch(stderr, /BUILDER_APP/, 'builder-app\'s variable is not named to the dev app\'s owner');
    assert.equal(requests().some((r) => r.method === 'POST'), false);
    await assert.rejects(stat(out), { code: 'ENOENT' });
  });

test('--installation-id names the installation, and must be a positive integer', async () => {
  const { out, exec, requests } = await setUp();
  state.installationId = INSTALLATION_ID + 1;
  const { code, stderr } = await exec(['--installation-id', String(INSTALLATION_ID + 1)]);
  assert.equal(code, 1, 'the installation matches; the token request goes to its id, which the fake does not serve');
  assert.match(stderr, new RegExp(`POST /app/installations/${INSTALLATION_ID + 1}/access_tokens: 404`));
  await assert.rejects(stat(out), { code: 'ENOENT' });
  for (const bad of ['0', '-1', '1.5', 'x']) {
    const refused = await exec([`--installation-id=${bad}`]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--installation-id must be a positive integer/);
  }
  assert.ok(requests().some((r) => r.method === 'POST'
    && r.path === `/app/installations/${INSTALLATION_ID + 1}/access_tokens`), 'the token is asked of that installation');
});
