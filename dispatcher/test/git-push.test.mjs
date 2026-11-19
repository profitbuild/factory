// builder-app's push (incident-platform backlog #0-271, AC2): a real `git push`, built by gitPushCommand, to a fake
// git smart-HTTP server on a loopback address. The token reaches the server through libexec/git-askpass.sh, and no
// argument, no file, no hook, no credential helper and no other child; a control run without the overrides shows
// that the hook and the helper planted here would have had it. A URL rewritten to another host gets no credential.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GIT_ASKPASS, PUSH_URL, gitPushCommand } from '../src/github/builder-token.mjs';
import { startFakeGitHub } from '../testing/fake-github.mjs';
import { filesContaining, makeRoot } from '../testing/builder-github.mjs';

const TOKEN = 'ghs_BuilderFakePushToken_end';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const REPO_PATH = '/profitbuild/incident-platform.git';

const pkt = (line) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** A fake git server: the receive-pack advertisement of an empty repository, then a report that accepts the push. */
async function startGitServer() {
  const authorizations = [];
  const authorized = ({ headers }) => {
    authorizations.push(headers.authorization);
    return headers.authorization === basic('x-access-token', TOKEN);
  };
  const challenge = { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="fake"' }, body: '' };
  const server = await startFakeGitHub({
    [`GET ${REPO_PATH}/info/refs`]: (request) => (authorized(request) ? {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement', 'Cache-Control': 'no-cache' },
      body: `${pkt('# service=git-receive-pack\n')}0000`
        + `${pkt(`${'0'.repeat(40)} capabilities^{}\0report-status delete-refs ofs-delta\n`)}0000`,
    } : challenge),
    [`POST ${REPO_PATH}/git-receive-pack`]: (request) => (authorized(request) ? {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
      body: `${pkt('unpack ok\n')}${pkt('ok refs/heads/feat/x\n')}0000`,
    } : challenge),
  });
  return { ...server, authorizations, url: `${server.baseUrl}${REPO_PATH}` };
}

const git = await startGitServer();
const other = await startGitServer();
const root = await makeRoot('git-push-test');
after(async () => {
  await git.close();
  await other.close();
  await rm(root, { recursive: true, force: true });
});

const exists = (path) => stat(path).then(() => true, () => false);

/**
 * A repository with one commit, holding what an agent could plant in .git: a pre-push hook and a credential helper,
 * each of which writes what it is given (its environment, its stdin) to `dumps/`. (An fsmonitor command is not
 * planted: git 2.39's push runs none, as the control run showed, so the test could not fail; `core.fsmonitor=` is
 * held by the command's test.) A `git` on PATH ahead of the real one logs its arguments. HOME is the run's own, so
 * whatever git writes there is scanned.
 */
async function setUp(name) {
  const dir = join(root, name);
  const repo = join(dir, 'repo');
  const dumps = join(dir, 'dumps');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  for (const path of [repo, dumps, bin, home]) {
    await mkdir(path, { recursive: true });
  }
  const run = (...args) => execFileSync(REAL_GIT, args, { cwd: repo, env: { PATH: process.env.PATH, HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  run('init', '-q', '-b', 'main');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'a commit');
  const dumper = (file) => `#!/bin/sh\n{ echo "args: $*"; env; cat; } >> ${join(dumps, file)} 2>/dev/null\nexit 0\n`;
  await writeFile(join(dir, 'helper'), dumper('helper'));
  await chmod(join(dir, 'helper'), 0o755);
  await writeFile(join(repo, '.git', 'hooks', 'pre-push'), dumper('hook'));
  await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
  run('config', 'credential.helper', join(dir, 'helper'));
  await writeFile(join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${join(dumps, 'argv')}\nexec ${REAL_GIT} "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  const baseEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: 'C' };
  return { dir, repo, dumps, home, baseEnv, run };
}

/** Runs `command args` in `cwd` with `env`; resolves its exit code and output. */
const spawnRun = ({ command, args, env }, cwd) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => resolve({ code, stdout, stderr }));
});

test('the push reaches the server with the token, in no argument, file, hook, helper or other env', async () => {
  const { dir, repo, dumps, baseEnv } = await setUp('push');
  const before = structuredClone(baseEnv);
  const command = gitPushCommand({ token: TOKEN, refspecs: ['HEAD:refs/heads/feat/x'], url: git.url, baseEnv });
  const { code, stdout, stderr } = await spawnRun(command, repo);
  assert.equal(code, 0, stderr);
  assert.ok(git.authorizations.includes(basic('x-access-token', TOKEN)), 'the server got the token');
  assert.doesNotMatch(stdout + stderr, new RegExp(TOKEN));
  assert.deepEqual(baseEnv, before, 'the environment given is not changed');
  assert.equal(command.args.some((arg) => arg.includes(TOKEN)), false);
  const argv = await readFile(join(dumps, 'argv'), 'utf8');
  assert.match(argv, /^push$/m, 'the PATH wrapper saw the push');
  assert.equal(argv.includes(TOKEN), false, 'not in git\'s arguments');
  assert.equal(await exists(join(dumps, 'hook')), false, 'the pre-push hook did not run');
  assert.equal(await exists(join(dumps, 'helper')), false, 'the credential helper was not asked');
  assert.deepEqual(await filesContaining(dir, TOKEN), [], 'nowhere on the disk of the run, HOME and .git included');
  assert.equal(Object.values(process.env).some((value) => value?.includes(TOKEN)), false, 'not in process.env');
});

test('control: without the overrides, the hook and the helper planted here are handed the token', async () => {
  const { repo, dumps, baseEnv } = await setUp('control');
  const { code, stderr } = await spawnRun({
    command: 'git', args: ['push', git.url, 'HEAD:refs/heads/feat/x'],
    env: { ...baseEnv, GIT_ASKPASS, FACTORY_PUSH_ORIGIN: git.baseUrl, FACTORY_PUSH_TOKEN: TOKEN,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }, repo);
  assert.equal(code, 0, stderr);
  assert.match(await readFile(join(dumps, 'hook'), 'utf8'), new RegExp(`FACTORY_PUSH_TOKEN=${TOKEN}`));
  assert.match(await readFile(join(dumps, 'helper'), 'utf8'), new RegExp(`password=${TOKEN}`));
});

test('a push URL rewritten by insteadOf to another host gets no credential, and fails', async () => {
  const { repo, run, baseEnv } = await setUp('insteadof');
  run('config', `url.${other.baseUrl}/.insteadOf`, `${git.baseUrl}/`);
  const start = other.requests.length;
  const command = gitPushCommand({ token: TOKEN, refspecs: ['HEAD:refs/heads/feat/x'], url: git.url, baseEnv });
  const { code, stderr } = await spawnRun(command, repo);
  assert.notEqual(code, 0);
  assert.ok(other.requests.length > start, 'git went to the other host');
  assert.deepEqual(other.requests.slice(start).map((r) => r.headers.authorization), [undefined],
    'which got no credential');
  assert.match(stderr, /git-askpass: no credential for this question \(only http:\/\/127\.0\.0\.1:\d+ is answered\)/);
  assert.doesNotMatch(stderr, new RegExp(TOKEN));
});

test('the command: the token in its env alone, the overrides, an explicit URL, no inherited GIT_ variable', () => {
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/x', GIT_SSL_NO_VERIFY: '1', GIT_ASKPASS: '/evil',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil'", FACTORY_PUSH_ORIGIN: 'https://evil.example', SSH_ASKPASS: '/e' };
  const { command, args, env } = gitPushCommand({ token: TOKEN, refspecs: ['HEAD:refs/heads/feat/x'], baseEnv });
  assert.equal(command, 'git');
  assert.deepEqual(args, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'credential.helper=',
    'push', '--no-verify', '--porcelain', PUSH_URL, 'HEAD:refs/heads/feat/x']);
  assert.equal(PUSH_URL, 'https://github.com/profitbuild/incident-platform.git');
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/home/x', GIT_ASKPASS, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', FACTORY_PUSH_ORIGIN: 'https://github.com', FACTORY_PUSH_TOKEN: TOKEN,
  });
});

test('the command refuses a URL with credentials or not HTTPS, a refspec that is an option, and no token', () => {
  const ok = { token: TOKEN, refspecs: ['HEAD:refs/heads/feat/x'] };
  assert.throws(() => gitPushCommand({ ...ok, url: 'https://x:y@github.com/profitbuild/incident-platform.git' }),
    /no user or password/);
  assert.throws(() => gitPushCommand({ ...ok, url: 'http://github.com/profitbuild/incident-platform.git' }),
    /must be https:\/\//);
  assert.throws(() => gitPushCommand({ ...ok, refspecs: ['--force'] }), /none starting with "-"/);
  assert.throws(() => gitPushCommand({ ...ok, refspecs: [] }), /one or more/);
  assert.throws(() => gitPushCommand({ ...ok, token: '' }), /a token is required/);
});

/** Runs the askpass script as git does, the question in $1. */
const askpass = (question, env) => new Promise((resolve) => {
  execFile(GIT_ASKPASS, [question], { env: { PATH: process.env.PATH, ...env } },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});
const ORIGIN = { FACTORY_PUSH_ORIGIN: 'https://github.com', FACTORY_PUSH_TOKEN: TOKEN };

test('askpass: the user and the token for the origin, nothing for another host, or with no origin set', async () => {
  assert.deepEqual(await askpass("Username for 'https://github.com': ", ORIGIN),
    { code: 0, stdout: 'x-access-token\n', stderr: '' });
  assert.deepEqual(await askpass("Password for 'https://x-access-token@github.com': ", ORIGIN),
    { code: 0, stdout: `${TOKEN}\n`, stderr: '' });
  for (const question of ["Password for 'https://x-access-token@evil.example': ",
    "Username for 'https://github.com.evil.example': ", "Password for 'http://x-access-token@github.com': ",
    "Password for 'https://someone@github.com': ", '']) {
    const { code, stdout, stderr } = await askpass(question, ORIGIN);
    assert.equal(code, 1, question);
    assert.equal(stdout, '', question);
    assert.doesNotMatch(stderr, new RegExp(TOKEN));
  }
  const unset = await askpass("Password for 'https://x-access-token@github.com': ", { FACTORY_PUSH_TOKEN: TOKEN });
  assert.notEqual(unset.code, 0);
  assert.equal(unset.stdout, '');
});
