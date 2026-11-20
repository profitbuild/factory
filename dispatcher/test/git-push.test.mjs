// builder-app's push, its second layer (incident-platform backlog #0-271 AC2, kept by #0-276): a real `git push`, the
// command of gitPushCommand run by runGit, to a fake git smart-HTTP server on a loopback address. Since #0-276 the
// dispatcher pushes only from a push repository it made, whose config is a reference `git init --bare`'s (push.test);
// these tests run the same command in a repository holding what an agent could plant (a hook, a credential helper, an
// insteadOf, an ssh command), to show what still holds behind that check: the token reaches the server through
// libexec/git-askpass.sh and no argument, file, hook, helper, ssh command or other host; control runs without the
// overrides show that what is planted here would have had it. The tests push over http:// to loopback, so they pass
// allowProtocols 'http:https' explicitly; the default is 'https' alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GIT, GIT_OVERRIDES, runGit } from '../src/git/run-git.mjs';
import {
  GIT_ASKPASS, PUSH_ENV_ALLOWED, PUSH_REF_PREFIX, checkTaskBranch, gitPushCommand, pushUrl,
} from '../src/github/builder-token.mjs';
import { filesContaining, makeRoot } from '../testing/builder-github.mjs';
import { basic, startGitServer } from '../testing/git-server.mjs';

const TOKEN = 'ghs_BuilderFakePushToken_end';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const git = await startGitServer({ token: TOKEN });
const other = await startGitServer({ token: TOKEN });
const root = await makeRoot('git-push-test');
after(async () => {
  await git.close();
  await other.close();
  await rm(root, { recursive: true, force: true });
});

const exists = (path) => stat(path).then(() => true, () => false);

/**
 * A repository with one commit, holding what an agent could plant in .git: a pre-push hook and a credential helper,
 * each of which writes what it is given (its environment, its stdin) to `dumps/`. A `git` on PATH ahead of the real
 * one logs its arguments and the names of its environment. HOME is the run's own, so whatever git writes there is
 * scanned.
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
  const run = (...args) => execFileSync(REAL_GIT, args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH,
    HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  run('init', '-q', '-b', 'main');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'a commit');
  const dumper = (file) => `#!/bin/sh\n{ echo "args: $*"; env; cat; } >> ${join(dumps, file)} 2>/dev/null\nexit 0\n`;
  await writeFile(join(dir, 'helper'), dumper('helper'));
  await chmod(join(dir, 'helper'), 0o755);
  await writeFile(join(repo, '.git', 'hooks', 'pre-push'), dumper('hook'));
  await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
  run('config', 'credential.helper', join(dir, 'helper'));
  // The wrapper is the git process itself (it execs git): the names of its environment are what every child of git
  // inherits. Names only, since one of them is the token's.
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${join(dumps, 'argv')}\n`
    + `env | cut -d= -f1 >> ${join(dumps, 'git-env-names')}\n`
    + `printf 'GIT_ASKPASS=%s\\nGIT_ALLOW_PROTOCOL=%s\\n' "$GIT_ASKPASS" "$GIT_ALLOW_PROTOCOL" >> ${join(dumps, 'git-env-values')}\n`
    + `exec ${REAL_GIT} "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  // What the dispatcher's environment could hold that must reach no git: a secret, a locale, and what would turn git's
  // checks off or hand the token elsewhere.
  const baseEnv = { PATH: process.env.PATH, HOME: home, LANG: 'pl_PL.UTF-8', SECRET_X: 'a-secret-of-the-parent',
    GIT_SSL_NO_VERIFY: '1', GIT_ASKPASS: '/evil-askpass', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil'",
    SSH_ASKPASS: '/evil-ssh-askpass', LD_PRELOAD: '/evil.so', GIT_ALLOW_PROTOCOL: 'ssh:https' };
  return { dir, repo, dumps, home, baseEnv, run, sha: run('rev-parse', 'HEAD'), wrapper: join(bin, 'git') };
}

/** The command of gitPushCommand, run by runGit in `repo` (a test's repository, standing for an agent's). */
function pushFrom({ repo, sha, baseEnv, wrapper }, { url = git.url, set = {} } = {}) {
  const command = gitPushCommand({ token: TOKEN, sha, branch: 'feat/x', url, allowProtocols: 'http:https' });
  return runGit({ cwd: repo, gitDir: join(repo, '.git'), git: wrapper, args: command.args, allow: command.allow,
    set: { ...command.set, ...set }, baseEnv }).then((result) => ({ ...result, stdout: result.stdout.toString() }));
}

test('the push reaches the server with the token, in no argument, file, hook, helper or other env', async () => {
  const setup = await setUp('push');
  const { dir, dumps, baseEnv, sha } = setup;
  const before = structuredClone(baseEnv);
  const start = git.updates.length;
  const { code, stdout, stderr } = await pushFrom(setup);
  assert.equal(code, 0, stderr);
  assert.deepEqual(git.updates.slice(start), [{ old: '0'.repeat(40), new: sha, ref: 'refs/heads/factory/feat/x' }]);
  assert.ok(git.authorizations.includes(basic('x-access-token', TOKEN)), 'the server got the token');
  assert.doesNotMatch(stdout + stderr, new RegExp(TOKEN));
  assert.deepEqual(baseEnv, before, 'the environment given is not changed');
  const argv = await readFile(join(dumps, 'argv'), 'utf8');
  assert.match(argv, /^push$/m, 'the PATH wrapper saw the push');
  assert.equal(argv.includes(TOKEN), false, 'not in git\'s arguments');
  assert.equal(await exists(join(dumps, 'hook')), false, 'the pre-push hook did not run');
  assert.equal(await exists(join(dumps, 'helper')), false, 'the credential helper was not asked');
  assert.deepEqual(await filesContaining(dir, TOKEN), [], 'nowhere on the disk of the run, HOME and .git included');
  const names = (await readFile(join(dumps, 'git-env-names'), 'utf8')).trim().split('\n');
  assert.ok(names.includes('FACTORY_PUSH_TOKEN'), 'the wrapper saw git\'s environment');
  for (const name of ['SECRET_X', 'LANG', 'GIT_SSL_NO_VERIFY', 'GIT_CONFIG_PARAMETERS', 'SSH_ASKPASS', 'LD_PRELOAD']) {
    assert.equal(names.includes(name), false, `${name} of the parent does not reach git`);
  }
  const values = await readFile(join(dumps, 'git-env-values'), 'utf8');
  assert.match(values, new RegExp(`^GIT_ASKPASS=${GIT_ASKPASS}$`, 'm'), 'the askpass is ours, not the parent\'s');
  assert.doesNotMatch(values, /evil-askpass/);
  assert.match(values, /^GIT_ALLOW_PROTOCOL=http:https$/m, 'the protocols are ours, not the parent\'s ssh:https');
  const OURS = ['GIT_ASKPASS', 'GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_TERMINAL_PROMPT', 'GIT_DIR', 'LC_ALL', 'FACTORY_PUSH_ORIGIN', 'FACTORY_PUSH_TOKEN', 'PWD', 'SHLVL', '_'];
  // git sets some of its own for its children (GIT_EXEC_PATH and the like): named here, so a new one shows.
  const GITS_OWN = ['GIT_EXEC_PATH', 'GIT_PREFIX', 'GIT_INTERNAL_GETTEXT_SH_SCHEME', 'GIT_TEXTDOMAINDIR'];
  assert.deepEqual([...new Set(names)].filter((name) => ![...PUSH_ENV_ALLOWED, ...OURS, ...GITS_OWN].includes(name)), [],
    'git sees nothing but the allowlist, ours and git\'s own');
  assert.equal(Object.values(process.env).some((value) => value?.includes(TOKEN)), false, 'not in process.env');
});

test('control: without the overrides, the hook and the helper planted here are handed the token', async () => {
  const { repo, dumps, baseEnv } = await setUp('control');
  const { code, stderr } = await new Promise((resolve) => {
    const child = spawn('git', ['push', git.url, 'HEAD:refs/heads/feat/x'], { cwd: repo,
      env: { PATH: baseEnv.PATH, HOME: baseEnv.HOME, GIT_ASKPASS, FACTORY_PUSH_ORIGIN: git.baseUrl, FACTORY_PUSH_TOKEN: TOKEN,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (exit) => resolve({ code: exit, stderr: err }));
  });
  assert.equal(code, 0, stderr);
  assert.match(await readFile(join(dumps, 'hook'), 'utf8'), new RegExp(`FACTORY_PUSH_TOKEN=${TOKEN}`));
  assert.match(await readFile(join(dumps, 'helper'), 'utf8'), new RegExp(`password=${TOKEN}`));
});

test('a push URL rewritten by insteadOf to another host gets no credential, and fails', async () => {
  const setup = await setUp('insteadof');
  setup.run('config', `url.${other.baseUrl}/.insteadOf`, `${git.baseUrl}/`);
  const start = other.requests.length;
  const { code, stderr } = await pushFrom(setup);
  assert.notEqual(code, 0);
  assert.ok(other.requests.length > start, 'git went to the other host');
  assert.deepEqual(other.requests.slice(start).map((r) => r.headers.authorization), [undefined],
    'which got no credential');
  assert.match(stderr, /git-askpass: no credential for this question \(only http:\/\/127\.0\.0\.1:\d+ is answered\)/);
  assert.doesNotMatch(stderr, new RegExp(TOKEN));
});

const SHA = 'a'.repeat(40);

test('the command: the refspec built from { sha, branch }, the token in its env alone, an explicit URL', () => {
  const url = pushUrl('profitbuild/incident-platform');
  const command = gitPushCommand({ token: TOKEN, sha: SHA, branch: 'feat/0-276-trusted-push', url });
  assert.deepEqual(command.args, ['push', '--no-verify', '--porcelain', url,
    `${SHA}:refs/heads/factory/feat/0-276-trusted-push`]);
  assert.equal(command.ref, 'refs/heads/factory/feat/0-276-trusted-push');
  assert.equal(PUSH_REF_PREFIX, 'refs/heads/factory/');
  assert.equal(command.args.some((arg) => arg.startsWith('+') || arg.includes(TOKEN)), false);
  assert.deepEqual(command.set, { GIT_ASKPASS, GIT_ALLOW_PROTOCOL: 'https', FACTORY_PUSH_ORIGIN: 'https://github.com',
    FACTORY_PUSH_TOKEN: TOKEN });
  assert.equal(command.allow, PUSH_ENV_ALLOWED);
  assert.deepEqual(PUSH_ENV_ALLOWED, ['PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy',
    'http_proxy', 'no_proxy']);
  assert.deepEqual(GIT_OVERRIDES, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'credential.helper=',
    '-c', 'protocol.allow=never', '-c', 'core.commitGraph=false']);
  assert.equal(GIT, '/usr/bin/git', 'git by its full path: PATH does not choose the program handed the token');
});

test('the command refuses a bad sha or branch, a URL with credentials or not HTTPS, and no token', () => {
  const ok = { token: TOKEN, sha: SHA, branch: 'feat/x', url: pushUrl('profitbuild/incident-platform') };
  assert.throws(() => gitPushCommand({ ...ok, url: 'https://x:y@github.com/profitbuild/incident-platform.git' }),
    /no user or password/);
  assert.throws(() => gitPushCommand({ ...ok, url: 'http://github.com/profitbuild/incident-platform.git' }),
    /must be an https:\/\/ URL/);
  for (const sha of ['HEAD', SHA.toUpperCase(), SHA.slice(1), `+${SHA}`]) {
    assert.throws(() => gitPushCommand({ ...ok, sha }), /40 hex digits/);
  }
  for (const branch of ['+feat/x', 'feat/x:x', 'feat/..', '--force', 'x', 'feat/a.lock', undefined]) {
    assert.throws(() => gitPushCommand({ ...ok, branch }), /a valid ref with no/);
    assert.throws(() => checkTaskBranch(branch), TypeError);
  }
  assert.throws(() => gitPushCommand({ ...ok, token: '' }), /a token is required/);
  assert.throws(() => gitPushCommand({ ...ok, url: 'http://127.0.0.1:1/x.git' }), /http among them/,
    'http:// to loopback needs http allowed explicitly');
  assert.throws(() => gitPushCommand({ ...ok, allowProtocols: 'https ssh' }), /protocols joined by ":"/);
  assert.throws(() => pushUrl('incident-platform'), /owner\/name/);
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

/**
 * A repository whose config rewrites the push URL to ssh:// and names a core.sshCommand that dumps its environment,
 * as an agent could write it (the hole round 1 of #0-271's review found).
 */
async function setUpSsh(name) {
  const setup = await setUp(name);
  const sshCommand = join(setup.dir, 'ssh-command');
  await writeFile(sshCommand, `#!/bin/sh\nenv >> ${join(setup.dumps, 'ssh')}\nexit 1\n`);
  await chmod(sshCommand, 0o755);
  setup.run('config', 'url.ssh://git@127.0.0.1:1/.insteadOf', `${git.baseUrl}/`);
  setup.run('config', 'core.sshCommand', sshCommand);
  setup.run('config', 'protocol.ssh.allow', 'always');
  return setup;
}

test('a push URL rewritten by insteadOf to ssh:// is refused by git: the ssh command never runs', async () => {
  const setup = await setUpSsh('ssh');
  const start = git.requests.length;
  const { code, stderr } = await pushFrom(setup);
  assert.notEqual(code, 0);
  assert.match(stderr, /transport 'ssh' not allowed/);
  assert.equal(await exists(join(setup.dumps, 'ssh')), false, 'the ssh command did not run');
  assert.equal(git.requests.length, start);
  assert.deepEqual(await filesContaining(setup.dir, TOKEN), []);
});

test('control: without GIT_ALLOW_PROTOCOL, the ssh command of the config gets the token', async () => {
  const setup = await setUpSsh('ssh-control');
  const command = gitPushCommand({ token: TOKEN, sha: setup.sha, branch: 'feat/x', url: git.url,
    allowProtocols: 'http:https' });
  const set = { ...command.set };
  delete set.GIT_ALLOW_PROTOCOL;
  const { code } = await runGit({ cwd: setup.repo, gitDir: join(setup.repo, '.git'), git: setup.wrapper, args: command.args,
    allow: command.allow, set, baseEnv: setup.baseEnv });
  assert.notEqual(code, 0);
  assert.match(await readFile(join(setup.dumps, 'ssh'), 'utf8'), new RegExp(`FACTORY_PUSH_TOKEN=${TOKEN}`));
});
