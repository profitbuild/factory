// bin/check-app.mjs (incident-platform backlog #0-271, AC3), run as the dispatcher's user runs it, with
// `node --env-file=<the env file>`, against a fake GitHub: it passes, printing each check and no token, and revokes
// its token; it fails when the app's installation on factory answers anything but 404, a check fails, or the token
// cannot be revoked. The child gets PATH alone of this process's environment: its settings come from the file.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { APP_ID, INSTALLATION_ID, PERMISSIONS, makeRoot, startBuilderGitHub, tokenNumber, writeAppFiles }
  from '../testing/builder-github.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/check-app.mjs', import.meta.url));
const fake = await startBuilderGitHub();
const root = await makeRoot('check-app-test');
after(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

async function checkApp(extra = [], files = undefined) {
  const { envPath } = files ?? await writeAppFiles(root, fake.privateKey);
  return new Promise((resolve) => {
    execFile(process.execPath, [`--env-file=${envPath}`, SCRIPT, '--api', fake.baseUrl, ...extra],
      { env: { PATH: process.env.PATH } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}
const noToken = ({ stdout, stderr }) => {
  assert.doesNotMatch(stdout + stderr, /ghs_/);
  assert.doesNotMatch(stdout + stderr, /eyJ/, 'no JWT');
};

test('check-app passes: settings from --env-file, each check on stdout, the token revoked', async () => {
  const start = fake.requests.length;
  const result = await checkApp();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  noToken(result);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], `check-app: settings: app ${APP_ID}, installation ${INSTALLATION_ID}`,
    'node --env-file loaded the ids');
  assert.match(lines[1], /^check-app: key .*builder-app\.pem: a regular file of uid \d+, readable by no one else: ok$/);
  assert.equal(lines[2], `check-app: installation ${INSTALLATION_ID} of app ${APP_ID} on profitbuild/incident-platform `
    + `holds ${JSON.stringify(PERMISSIONS)}: ok`);
  assert.equal(lines[3], 'check-app: token narrowed to profitbuild/incident-platform, and reaches only it: ok');
  assert.match(lines[4], /^check-app: token holds .*: ok \(expires \d{4}-\d\d-\d\dT.*Z\)$/);
  assert.equal(lines[5], 'check-app: no installation on profitbuild/factory (404): ok');
  assert.equal(lines[6], 'check-app: token revoked');
  assert.equal(lines[7], 'check-app: all checks passed');
  assert.equal(lines.length, 8);
  assert.deepEqual(fake.state.revoked, [tokenNumber(1)]);
  const asked = fake.requests.slice(start).map((r) => `${r.method} ${r.path}`);
  assert.ok(asked.includes('GET /repos/profitbuild/factory/installation'));
});

for (const [status, body] of [
  [200, { id: 7, app_id: APP_ID }],
  [401, { message: 'Bad credentials' }],
  [403, { message: 'Forbidden' }],
  [500, { message: 'Server Error' }],
]) {
  test(`check-app fails when the installation on factory answers ${status}, and revokes the token`, async () => {
    fake.state.factory = () => ({ status, body });
    const result = await checkApp();
    assert.equal(result.code, 1);
    noToken(result);
    assert.match(result.stderr, status === 200
      ? /^check-app: the app is installed on profitbuild\/factory \(installation 7\): it must never be/m
      : new RegExp(`^check-app: the app's installation on profitbuild/factory must answer 404, not this: .*${status}`,
        'm'));
    assert.doesNotMatch(result.stdout, /all checks passed/);
    assert.match(result.stdout, /token revoked/);
    assert.deepEqual(fake.state.revoked, [tokenNumber(1)]);
  });
}

test('check-app fails when a check fails, with the token revoked and nothing more asked', async () => {
  fake.state.tokenPermissions = { ...PERMISSIONS, workflows: 'write' };
  const start = fake.requests.length;
  const result = await checkApp();
  assert.equal(result.code, 1);
  noToken(result);
  assert.match(result.stderr, /^check-app: the token holds .*"workflows":"write"/m);
  assert.deepEqual(fake.state.revoked, [tokenNumber(1)]);
  assert.equal(fake.requests.slice(start).some((r) => r.path === '/repos/profitbuild/factory/installation'), false);
});

test('check-app refuses an unknown BUILDER_APP_ variable, and an API that is not HTTPS, asking nothing', async () => {
  const start = fake.requests.length;
  const typo = await checkApp([], await writeAppFiles(root, fake.privateKey, {
    envText: 'BUILDER_APP_ID=1\nBUILDER_APP_INSTALLATION_ID=2\nBUILDER_APP_KYE=/x\n' }));
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /^check-app: unknown variable BUILDER_APP_KYE/m);
  const plain = await checkApp(['--api', 'http://api.example.com']);
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /the API must be an https:\/\/ URL/);
  assert.equal(fake.requests.length, start);
});

test('check-app fails when the final revoke fails, naming the token left unrevoked', async () => {
  fake.state.failRevoke = true;
  const result = await checkApp();
  assert.equal(result.code, 1);
  noToken(result);
  assert.match(result.stdout, /no installation on profitbuild\/factory \(404\): ok/);
  assert.doesNotMatch(result.stdout, /token revoked|all checks passed/);
  assert.match(result.stderr, new RegExp('^check-app: the token could not be revoked \\(it expires within the hour\\): '
    + 'GitHub DELETE /installation/token: 502 Bad Gateway$', 'm'));
});

test('check-app reports the first failure, not the revoke\'s, when both fail', async () => {
  fake.state.failRevoke = true;
  fake.state.factory = () => ({ status: 200, body: { id: 7, app_id: APP_ID } });
  const result = await checkApp();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^check-app: the app is installed on profitbuild\/factory/m);
  assert.doesNotMatch(result.stderr, /could not be revoked/);
});
