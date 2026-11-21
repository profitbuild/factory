// bin/check-app.mjs (incident-platform backlog #0-271, AC3), run as the dispatcher's user runs it, with
// `node --env-file=<the env file>`, against a fake GitHub: it passes, printing each check and no token, and revokes
// its token; it fails when the app's installation on factory answers anything but 404, a check fails, or the token
// cannot be revoked. The child gets PATH alone of this process's environment: its settings come from the file.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTER, commit, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { APP_ID, INSTALLATION_ID, PERMISSIONS, makeRoot, startBuilderGitHub, tokenNumber, writeAppFiles }
  from '../testing/builder-github.mjs';
import { git } from '../testing/git-fixtures.mjs';
import { validEnv } from '../testing/state-dir.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/check-app.mjs', import.meta.url));
const fake = await startBuilderGitHub();
const root = await makeRoot('check-app-test');
after(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

/** Runs check-app with `extra`; `repository` is the --repository given (null: none), incident-platform by default. */
async function checkApp(extra = [], files = undefined, { repository = 'profitbuild/incident-platform' } = {}) {
  const { envPath } = files ?? await writeAppFiles(root, fake.privateKey);
  return new Promise((resolve) => {
    execFile(process.execPath, [`--env-file=${envPath}`, SCRIPT, '--api', fake.baseUrl,
      ...(repository === null ? [] : ['--repository', repository]), ...extra],
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

test('check-app refuses an unknown BUILDER_APP_ variable, and an API not GitHub\'s nor a test\'s, asking nothing', async () => {
  const start = fake.requests.length;
  const typo = await checkApp([], await writeAppFiles(root, fake.privateKey, {
    envText: 'BUILDER_APP_ID=1\nBUILDER_APP_INSTALLATION_ID=2\nBUILDER_APP_KYE=/x\n' }));
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /^check-app: unknown variable BUILDER_APP_KYE/m);
  for (const api of ['http://api.example.com', 'https://api.example.com', 'https://api.github.com.evil.example',
    'https://api.github.com:8443', 'https://API.github.com']) {
    const other = await checkApp(['--api', api]);
    assert.equal(other.code, 1, api);
    assert.match(other.stderr, /the API must be https:\/\/api\.github\.com, or a test's http:\/\/ origin on a loopback/, api);
    assert.equal(other.stdout, '', `${api}: refused before the settings are read, so nothing is printed`);
  }
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

test('check-app requires --repository or --adapter-from-repo, in the adapter schema\'s shape, and asks nothing without '
  + 'it (#0-276, #0-278)', async () => {
  const start = fake.requests.length;
  const none = await checkApp([], undefined, { repository: null });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^check-app: exactly one of --adapter-from-repo and --repository <owner\/name> is required/);
  const both = await checkApp(['--adapter-from-repo']);
  assert.match(both.stderr, /^check-app: exactly one of --adapter-from-repo and --repository/);
  for (const repository of ['incident-platform', 'profitbuild/..', './x', 'a/b/c']) {
    const bad = await checkApp([], undefined, { repository });
    assert.equal(bad.code, 1, repository);
    assert.match(bad.stderr, /a repository must be owner\/name, as the adapter has it/);
  }
  assert.equal(fake.requests.length, start, 'no request without a valid repository');
});

test('check-app checks the repository it is given: another product\'s installation and token (#0-276 AC3)', async () => {
  fake.state.repositories = ['profitbuild/other-product'];
  const start = fake.requests.length;
  const result = await checkApp([], undefined, { repository: 'profitbuild/other-product' });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fake.requests.slice(start).some((r) => r.path === '/repos/profitbuild/other-product/installation'));
  assert.equal(fake.requests.slice(start).some((r) => r.path.includes('incident-platform')), false);
  const posts = fake.requests.slice(start).filter((r) => r.method === 'POST');
  assert.deepEqual(posts.map((r) => r.body.repositories), [['other-product']], 'the token narrowed to it');
  fake.state.repositories = ['profitbuild/incident-platform'];
  const wrong = await checkApp([], undefined, { repository: 'profitbuild/other-product' });
  assert.equal(wrong.code, 1, 'a token reaching another repository is refused');
});

/** An env file of the VM's: builder-app's settings and every FACTORY_* one, FACTORY_REPO_DIR the product's clone. */
async function vmFiles(repoDir) {
  const app = await writeAppFiles(root, fake.privateKey);
  const vars = { ...validEnv(join(root, 'state'), repoDir), ...app.vars };
  return writeAppFiles(root, fake.privateKey, {
    envText: `${Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join('')}` });
}

test('#0-278 AC8: --adapter-from-repo takes the repository from the adapter at FACTORY_REPO_DIR\'s main', async () => {
  const dir = join(root, 'adapter-from-repo');
  await mkdir(dir, { mode: 0o700 });
  const product = await makeAdapterProduct(dir, { adapter: { ...ADAPTER, repository: 'profitbuild/other-product' } });
  fake.state.repositories = ['profitbuild/other-product'];
  // A later commit on another ref, and the work tree's adapter changed: only refs/heads/main of the clone counts.
  await commit(product.work, { files: { '.factory/adapter.json': `${JSON.stringify(ADAPTER)}\n` } });
  git(product.work, ['push', '-q', product.repoDir, 'HEAD:refs/heads/other']);
  const files = await vmFiles(product.repoDir);
  const start = fake.requests.length;
  const result = await checkApp(['--adapter-from-repo'], files, { repository: null });
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'check-app: repository from the adapter at FACTORY_REPO_DIR\'s main: profitbuild/other-product');
  const posts = fake.requests.slice(start).filter((r) => r.method === 'POST');
  assert.deepEqual(posts.map((r) => r.body.repositories), [['other-product']], 'the token narrowed to the adapter\'s');
  assert.equal(lines.at(-1), 'check-app: all checks passed');
});

test('#0-278 AC8: --adapter-from-repo refuses a main with no adapter, or one off its rules, and asks nothing', async () => {
  for (const [what, options, pattern] of [
    ['none', { files: { '.factory/adapter.json': null } }, /^check-app: the base holds no \.factory\/adapter\.json$/m],
    ['a symlink', { files: { 'BACKLOG.md': null }, links: { 'BACKLOG.md': 'README.md' } },
      /^check-app: the adapter's queue\.files\[0\] reaches a symlink in the base/m],
  ]) {
    const dir = join(root, `refused-${what.replace(' ', '-')}`);
    await mkdir(dir, { mode: 0o700 });
    const product = await makeAdapterProduct(dir, options);
    const start = fake.requests.length;
    const result = await checkApp(['--adapter-from-repo'], await vmFiles(product.repoDir), { repository: null });
    assert.equal(result.code, 1, what);
    assert.match(result.stderr, pattern, what);
    assert.equal(fake.requests.length, start, `${what}: no request`);
  }
});
