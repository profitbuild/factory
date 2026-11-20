// builder-app's push from a push repository the dispatcher makes for each push (incident-platform backlog #0-276), with
// real git against the fake git server on loopback: its config held to a reference `git init --bare`'s before the
// token is asked for (AC1); the refspec the code's, from { sha, branch } (AC2); the repository and the URL from the
// adapter (AC3); a bundle refused before any ref, token or request, and no git where the bundle came from (AC6); a
// fresh repository per push, removed after every push (AC8); a refused ref reported without the remote's text.
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../src/adapter.mjs';
import { BundleError, readBundleFile } from '../src/git/bundle.mjs';
import { ConfigRefusedError, readConfig } from '../src/git/config-allowlist.mjs';
import { pushUrl } from '../src/github/builder-token.mjs';
import { PushRefusedError, PushRejectedError, mainObjects, pushTask, readPushResult } from '../src/github/push.mjs';
import { GIT_VERSION, REAL_GIT, git, makeProduct, makeTask } from '../testing/git-fixtures.mjs';
import { startGitServer } from '../testing/git-server.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

// Not a token's shape: the secret scan reads every commit, and the server only compares it.
const TOKEN = `push-token-${'x'.repeat(8)}`;
const RUN_ID = '20261120T101500Z-3f9a1c';

const root = await makeStateDir();
const server = await startGitServer({ token: TOKEN });
after(async () => {
  await server.close();
  await root.remove();
});
let product;
let task;
let stateDir;
before(async () => {
  product = await makeProduct(root.dir, { badOld: true });
  task = await makeTask(root.dir, product);
});
let n = 0;
beforeEach(async () => {
  n += 1;
  stateDir = join(root.dir, `state-${n}`);
  await mkdir(stateDir, { mode: 0o700 });
  server.state.reply = () => 'ok';
});

test('the git these tests run', (t) => {
  t.diagnostic(GIT_VERSION);
});

/** A token source that records whether it was asked. */
function tokens() {
  const asked = [];
  return { asked, getToken: async () => { asked.push(Date.now()); return TOKEN; } };
}

const theTask = () => ({ runId: RUN_ID, branch: 'feat/x', baseSha: product.base });

/** pushTask with this file's defaults: the task's bundle, commit and branch, the loopback server. */
function push(overrides = {}) {
  const source = overrides.source ?? tokens();
  const run = pushTask({
    stateDir, repoDir: product.dir, task: theTask(), bundle: task.bundle, sha: task.sha, branch: 'feat/x',
    repository: 'profitbuild/incident-platform', getToken: source.getToken, url: server.url, allowProtocols: 'http:https',
    ...overrides,
  });
  return { run, source };
}

const pushDir = () => join(stateDir, 'tasks', RUN_ID, 'push');
const gone = async (path) => stat(path).then(() => false, () => true);

/** Refused with `type` and `pattern`, never asking for the token nor reaching the server, the push dir removed. */
async function refusedWithoutToken(overrides, type, pattern, { values = [] } = {}) {
  const start = server.requests.length;
  const { run, source } = push(overrides);
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof type, `${error.constructor.name}: ${error.message}`);
    assert.match(error.message, pattern);
    for (const value of values) {
      assert.ok(!error.message.includes(value), `the refusal holds the value ${value}`);
    }
    return true;
  });
  assert.deepEqual(source.asked, [], 'the token was never asked for');
  assert.equal(server.requests.length, start, 'the server got no request');
  assert.ok(await gone(pushDir()), 'the push repository is removed');
}

test('AC2: the task\'s commit is pushed to refs/heads/factory/<branch>, not forced, the push dir removed', async () => {
  const start = server.updates.length;
  const { run, source } = push();
  assert.deepEqual(await run, { ref: 'refs/heads/factory/feat/x', flag: '*' });
  assert.deepEqual(server.updates.slice(start), [{ old: '0'.repeat(40), new: task.sha, ref: 'refs/heads/factory/feat/x' }]);
  assert.equal(source.asked.length, 1);
  assert.ok(await gone(pushDir()));
  assert.equal((await stat(join(stateDir, 'tasks', RUN_ID))).mode & 0o777, 0o700);
});

test('AC2: a sha not 40 hex, or not the bundle\'s ref, is refused before any token', async () => {
  for (const sha of ['', 'abc', task.sha.toUpperCase(), `${task.sha}0`, `+${task.sha.slice(1)}`]) {
    await refusedWithoutToken({ sha }, PushRefusedError, /must be 40 hex digits/);
  }
  await refusedWithoutToken({ sha: product.base }, BundleError, /the bundle's ref must be refs\/heads\/feat\/x at /);
});

test('AC2: a branch not the task\'s, or with +, :, .., or not a valid ref, is refused before any token', async () => {
  await refusedWithoutToken({ branch: 'feat/y' }, PushRefusedError, /not the task's own \(feat\/x\)/);
  for (const branch of ['+feat/x', 'feat/x:main', ':feat/x', 'feat/../x', 'feat/x..y', 'feat/x.lock', 'feat/.x',
    'feat/x.', '-feat/x', 'main', 'feat/x/', 'feat//x', 'factory/feat/x y']) {
    await refusedWithoutToken({ branch, task: { ...theTask(), branch } }, PushRefusedError,
      /a valid ref with no "\+", ":" or "\.\."/);
  }
  await refusedWithoutToken({ task: { ...theTask(), baseSha: null } }, PushRefusedError, /has no base recorded/);
});

/** Plants `text` at the end of the push repository's config. */
const planting = (text) => async (gitDir) => { await appendFile(join(gitDir, 'config'), text); };

const PLANTED = (url) => [
  ['http.proxy', '[http]\n\tproxy = http://evil.example:3128\n'],
  ['http.https://github.com/.sslverify', '[http "https://github.com/"]\n\tsslVerify = false\n'],
  ['http.sslcainfo', '[http]\n\tsslCAInfo = /tmp/evil-ca.pem\n'],
  ['http.curloptresolve', '[http]\n\tcurloptResolve = github.com:443:192.0.2.1\n'],
  ['include.path', '[include]\n\tpath = /tmp/evil.config\n'],
  [`remote.${url}.pushurl`, `[remote "${url}"]\n\tpushurl = https://evil.example/x.git\n`],
  ['core.fsmonitor', '[core]\n\tfsmonitor = /tmp/evil-fsmonitor\n'],
  ['core.fsmonitor', '[CORE]\n\tFSMonitor = /tmp/evil-fsmonitor\n'],
  ['factory.nobodysays', '[factory]\n\tnobodySays = this\n'],
];

test('AC1: a key a reference git init --bare does not write refuses the push, right before the token', async () => {
  for (const [key, text] of PLANTED(server.url)) {
    await refusedWithoutToken({ hooks: { beforeToken: planting(text) } }, ConfigRefusedError,
      new RegExp(`before any token is asked for: keys a reference git init --bare does not write: ${
        key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`),
      { values: ['evil', '192.0.2.1', 'this'] });
  }
});

test('AC1: an allowed key with another value, or written twice, refuses the push too', async () => {
  await refusedWithoutToken({ hooks: { beforeToken: planting('[core]\n\tbare = false\n') } }, ConfigRefusedError,
    /keys whose value is not the reference's: core\.bare$/);
  await refusedWithoutToken({ hooks: { beforeToken: planting('[core]\n\tbare = true\n') } }, ConfigRefusedError,
    /keys whose value is not the reference's: core\.bare$/);
  await refusedWithoutToken({ hooks: { beforeToken: planting('[core]\n\tfilemode = false\n') } }, ConfigRefusedError,
    /core\.filemode/);
  // In place, not added: the key is there once, as in the reference, with another value.
  const replacing = (from, to) => async (gitDir) => {
    const path = join(gitDir, 'config');
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes(from), `the reference config holds ${from}`);
    await writeFile(path, text.replace(from, to));
  };
  await refusedWithoutToken({ hooks: { beforeToken: replacing('bare = true', 'bare = false') } }, ConfigRefusedError,
    /keys whose value is not the reference's: core\.bare$/);
  await refusedWithoutToken({ hooks: { afterInit: replacing('filemode = true', 'filemode = false') } },
    ConfigRefusedError, /keys whose value is not the reference's: core\.filemode$/);
});

test('AC1: the config is checked right after init too, before the bundle is read', async () => {
  // A bundle that is not one: had it been read first, the refusal would be the bundle's.
  for (const [, text] of PLANTED(server.url)) {
    await refusedWithoutToken({ bundle: Buffer.from('not a bundle'), hooks: { afterInit: planting(text) } },
      ConfigRefusedError, /keys a reference git init --bare does not write/);
  }
});

test('the reference config these tests run against, as this git writes it', async (t) => {
  let seen;
  const { run } = push({ hooks: { beforeToken: async (gitDir) => { seen = await readConfig(gitDir); } } });
  await run;
  t.diagnostic(`${GIT_VERSION}: ${seen.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  assert.ok(seen.some(([key]) => key === 'core.bare'));
  assert.equal(seen.some(([key]) => key.startsWith('include.') || key.startsWith('http.')), false);
});

test('AC6: a bundle refused by the strict check, or with no prerequisite, gets no ref, no token, no request', async () => {
  const bad = await makeTask(root.dir, product, { noEmail: true, name: 'push-no-email' });
  await refusedWithoutToken({ bundle: bad.bundle, sha: bad.sha }, BundleError, /strict check: .*missingEmail/);
  const full = git(task.dir, ['bundle', 'create', '-', 'feat/x'], { binary: true });
  await refusedWithoutToken({ bundle: full }, BundleError, /prerequisites must be exactly/);
});

test('AC6: no git runs where the bundle came from: a planted .git/config\'s fsmonitor never starts', async () => {
  const incoming = join(root.dir, `incoming-${n}`);
  await mkdir(incoming, { mode: 0o700 });
  const marker = join(root.dir, `fsmonitor-ran-${n}`);
  const monitor = join(root.dir, `fsmonitor-${n}.sh`);
  await writeFile(monitor, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  await chmod(monitor, 0o755);
  git(incoming, ['init', '-q']);
  git(incoming, ['config', 'core.fsmonitor', monitor]);
  await writeFile(join(incoming, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  // Control: a git that does run there starts it.
  execFileSync(REAL_GIT, ['status'], { cwd: incoming, stdio: 'ignore',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(await gone(marker), false, 'the planted fsmonitor runs when git runs in that directory');
  await (await import('node:fs/promises')).rm(marker);
  const file = join(incoming, 'task.bundle');
  await writeFile(file, task.bundle, { mode: 0o600 });
  const { run } = push({ bundle: await readBundleFile(file) });
  assert.equal((await run).flag, '*');
  assert.ok(await gone(marker), 'no git ran where the bundle came from');
});

test('AC8: a key planted in one push\'s repository is not in the next one\'s, and each is removed', async () => {
  await refusedWithoutToken({ hooks: { beforeToken: planting('[http]\n\tproxy = http://evil.example\n') } },
    ConfigRefusedError, /http\.proxy/);
  let seen;
  const { run } = push({ hooks: { beforeToken: async (gitDir) => { seen = await readConfig(gitDir); } } });
  assert.equal((await run).flag, '*');
  assert.equal(seen.some(([key]) => key === 'http.proxy'), false, 'the next push\'s repository is fresh');
  assert.ok(await gone(pushDir()));
});

test('AC8: a push directory left by a killed run is removed first; a push git fails leaves none', async () => {
  await mkdir(join(pushDir(), 'repo.git'), { recursive: true, mode: 0o700 });
  await writeFile(join(pushDir(), 'repo.git', 'config'), '[http]\n\tproxy = http://evil.example\n');
  const { run } = push();
  assert.equal((await run).flag, '*');
  assert.ok(await gone(pushDir()));
  const closed = await startGitServer({ token: TOKEN });
  await closed.close();
  const failed = push({ url: closed.url });
  await assert.rejects(failed.run, PushRejectedError);
  assert.ok(await gone(pushDir()), 'removed after git failed');
});

test('a ref the remote refuses is a PushRejectedError naming git\'s kind of refusal, never the remote\'s text',
  async () => {
    server.state.reply = () => 'protected branch hook declined: the remote speaking';
    const { run } = push();
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof PushRejectedError);
      assert.equal(error.message, 'the push of refs/heads/factory/feat/x was refused: remote rejected');
      return true;
    });
    assert.ok(await gone(pushDir()));
  });

test('readPushResult: up to date is a success; a local refusal keeps git\'s own reason, any other is dropped', () => {
  const ref = 'refs/heads/factory/feat/x';
  const out = (line, code = 0) => ({ code, stdout: Buffer.from(`To http://x\n${line}\nDone\n`) });
  assert.deepEqual(readPushResult(out(`=\tabc:${ref}\t[up to date]`), ref), { ref, flag: '=' });
  assert.throws(() => readPushResult(out(`!\tabc:${ref}\t[rejected] (non-fast-forward)`, 1), ref),
    /was refused: rejected \(non-fast-forward\)$/);
  assert.throws(() => readPushResult(out(`!\tabc:${ref}\t[rejected] (said by someone)`, 1), ref),
    /was refused: rejected$/);
  assert.throws(() => readPushResult(out(`+\tabc:${ref}\t[forced update]`), ref), /refused: forced update$/,
    'a forced update is not one the dispatcher asked for');
  assert.throws(() => readPushResult({ code: 128, stdout: Buffer.from('') }, ref),
    (error) => error instanceof PushRejectedError && /^git push failed \(exit 128\) and reported no result/.test(error.message));
});

test('AC3: the repository and the push URL come from the adapter: two products, two URLs', async () => {
  const ip = await loadAdapter(fileURLToPath(new URL('../testing/fixtures/incident-platform.adapter.json',
    import.meta.url)));
  const otherFile = join(root.dir, 'other.adapter.json');
  await writeFile(otherFile, JSON.stringify({ ...ip, repository: 'profitbuild/other-product' }));
  const other = await loadAdapter(otherFile);
  assert.equal(pushUrl(ip.repository), 'https://github.com/profitbuild/incident-platform.git');
  assert.equal(pushUrl(other.repository), 'https://github.com/profitbuild/other-product.git');
  const otherServer = await startGitServer({ token: TOKEN, path: '/profitbuild/other-product.git' });
  try {
    const { run } = push({ repository: other.repository, url: pushUrl(other.repository, otherServer.baseUrl) });
    assert.equal((await run).flag, '*');
    assert.deepEqual(otherServer.updates.map((u) => u.ref), ['refs/heads/factory/feat/x']);
  } finally {
    await otherServer.close();
  }
  await assert.rejects(push({ repository: 'not-a-repository', url: undefined }).run,
    /a repository must be owner\/name/);
});

test('FACTORY_REPO_DIR\'s objects are the dispatcher\'s own, writable by no one else, with no alternates', async () => {
  assert.equal(await mainObjects(product.dir), join(product.dir, '.git', 'objects'));
  await assert.rejects(mainObjects(product.dir, { uid: process.getuid() + 1 }), /owned by uid/);
  const loose = join(root.dir, `loose-${n}`);
  await mkdir(join(loose, '.git', 'objects', 'info'), { recursive: true, mode: 0o755 });
  await chmod(join(loose, '.git', 'objects'), 0o775);
  await assert.rejects(mainObjects(loose), /have mode 775/);
  await chmod(join(loose, '.git', 'objects'), 0o755);
  await writeFile(join(loose, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n');
  await assert.rejects(mainObjects(loose), /have info\/alternates/);
  await assert.rejects(mainObjects(join(root.dir, 'nowhere')), /holds no objects directory/);
  const gitfile = join(root.dir, `gitfile-${n}`);
  await mkdir(gitfile);
  await writeFile(join(gitfile, '.git'), 'gitdir: /elsewhere\n');
  await assert.rejects(mainObjects(gitfile), /\.git is not a directory/);
  assert.deepEqual((await readdir(stateDir)), []);
});

test('the token reaches the server only through askpass, and is in no file of the push\'s', async () => {
  const start = server.authorizations.length;
  const { run } = push();
  await run;
  const seen = server.authorizations.slice(start);
  assert.ok(seen.includes(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`));
  assert.equal((await readFile(join(product.dir, '.git', 'config'), 'utf8')).includes(TOKEN), false);
});
