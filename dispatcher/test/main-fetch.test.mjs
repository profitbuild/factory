// FACTORY_REPO_DIR's main brought up to GitHub's before a new task (incident-platform backlog #0-278), with real git
// against a loopback server of git's own http-backend: a fast-forward is taken, with builder-app's token through
// askpass only; an update that is not a fast-forward is refused and main left as it was; the clone's config held to a
// reference `git init --bare`'s and at most remote.origin.url equal to the URL the code builds, before the token is
// asked for; the token source the repository's; the clone the dispatcher's alone (AC7).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MainFetchError, fetchMain } from '../src/git/main-fetch.mjs';
import { commit, makeAdapterProduct } from '../testing/adapter-product.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { startGitFetchServer } from '../testing/git-fetch-server.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

// Not a token's shape: the secret scan reads every commit, and the server only compares it.
const TOKEN = `fetch-token-${'x'.repeat(8)}`;
const REPOSITORY = 'profitbuild/incident-platform';

const root = await makeStateDir();
const srv = join(root.dir, 'srv');
await mkdir(join(srv, 'profitbuild'), { recursive: true });
const server = await startGitFetchServer({ root: srv, valid: (token) => token === TOKEN });
after(async () => {
  await server.close();
  await root.remove();
});
const URL_OF = `${server.baseUrl}/profitbuild/incident-platform.git`;
let n = 0;

/** A product served at URL_OF, FACTORY_REPO_DIR a bare clone of it whose origin is that URL, a state directory. */
async function setUp() {
  n += 1;
  const dir = join(root.dir, `case-${n}`);
  await mkdir(dir, { mode: 0o700 });
  const product = await makeAdapterProduct(dir);
  const origin = join(srv, 'profitbuild', 'incident-platform.git');
  await import('node:fs/promises').then((fs) => fs.rm(origin, { recursive: true, force: true }));
  git(root.dir, ['clone', '-q', '--bare', product.work, origin]);
  git(product.repoDir, ['config', 'remote.origin.url', URL_OF]);
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const asked = [];
  const tokens = { repository: REPOSITORY, getToken: async () => { asked.push(1); return TOKEN; } };
  const fetch = (extra = {}) => fetchMain({ stateDir, repoDir: product.repoDir, repository: REPOSITORY, tokens,
    gitBase: server.baseUrl, git: REAL_GIT, ...extra });
  const advance = async () => {
    const sha = await commit(product.work, { files: { 'src/new.txt': `${n}\n` } });
    git(product.work, ['push', '-q', origin, 'HEAD:refs/heads/main']);
    return sha;
  };
  return { dir, product, origin, stateDir, asked, tokens, fetch, advance };
}

const mainOf = (repoDir) => git(repoDir, ['rev-parse', 'refs/heads/main']);

test('a fast-forward of GitHub\'s main is taken, with the token through askpass; no FETCH_HEAD, no tag, nothing left',
  async () => {
    const s = await setUp();
    const head = await s.advance();
    git(s.origin, ['tag', 'v9', head]);
    const start = server.authorizations.length;
    assert.deepEqual(await s.fetch(), { before: s.product.base, after: head });
    assert.equal(mainOf(s.product.repoDir), head);
    assert.ok(server.authorizations.slice(start).includes(`Basic ${Buffer.from(`x-access-token:${TOKEN}`)
      .toString('base64')}`));
    assert.equal(existsSync(join(s.product.repoDir, 'FETCH_HEAD')), false);
    assert.equal(git(s.product.repoDir, ['tag', '--list']), '');
    assert.deepEqual(await readdir(s.stateDir), [], 'the reference is removed');
    assert.deepEqual(await s.fetch(), { before: head, after: head }, 'up to date');
  });

test('an update that is not a fast-forward is refused, main left as it was', async () => {
  const s = await setUp();
  const other = git(s.product.work, ['commit-tree', `${s.product.base}^{tree}`, '-m', 'another history']);
  git(s.product.work, ['push', '-q', '--force', s.origin, `${other}:refs/heads/main`]);
  await assert.rejects(s.fetch(), (error) => error instanceof MainFetchError
    && /^GitHub's main is not a fast-forward of FACTORY_REPO_DIR's: the update is refused/.test(error.message));
  assert.equal(mainOf(s.product.repoDir), s.product.base);
});

test('the clone\'s config: a key off the reference, or remote.origin.url not the code\'s URL, refuses before the token',
  async () => {
    for (const [key, value] of [['http.proxy', 'http://127.0.0.1:9'], ['remote.origin.url', 'https://elsewhere.example/x.git'],
      ['http.sslVerify', 'false'], ['core.fsmonitor', '/bin/true']]) {
      const s = await setUp();
      git(s.product.repoDir, ['config', key, value]);
      const start = server.authorizations.length;
      await assert.rejects(s.fetch(), (error) => error.message === 'FACTORY_REPO_DIR\'s config is refused, before any '
        + `token is asked for: keys a reference git init --bare does not write: ${key.toLowerCase()}`, key);
      assert.deepEqual(s.asked, [], `${key}: the token never asked for`);
      assert.equal(server.authorizations.length, start, `${key}: no request`);
    }
    const twice = await setUp();
    await appendFile(join(twice.product.repoDir, 'config'), `[remote "origin"]\n\turl = ${URL_OF}\n`);
    await assert.rejects(twice.fetch(), /keys a reference git init --bare does not write: remote\.origin\.url$/);
    const none = await setUp();
    git(none.product.repoDir, ['config', '--unset', 'remote.origin.url']);
    const head = await none.advance();
    assert.equal((await none.fetch()).after, head, 'remote.origin.url is allowed, not required');
  });

test('a token source of another repository, a host that is not GitHub\'s, a token refused: each refused', async () => {
  const s = await setUp();
  await assert.rejects(s.fetch({ tokens: { ...s.tokens, repository: 'profitbuild/other-product' } }),
    /the token source is for profitbuild\/other-product, not profitbuild\/incident-platform/);
  await assert.rejects(s.fetch({ gitBase: 'https://example.com' }), MainFetchError);
  await s.advance();
  await assert.rejects(s.fetch({ tokens: { repository: REPOSITORY, getToken: async () => 'not-the-token' } }),
    (error) => error.message === 'git fetch of main failed (exit 128); the remote\'s text is not quoted');
  assert.equal(mainOf(s.product.repoDir), s.product.base);
  assert.deepEqual(s.asked, []);
});

test('AC7: a clone not the dispatcher\'s alone is refused before anything is fetched', async () => {
  const s = await setUp();
  await chmod(s.dir, 0o755);
  await chmod(s.product.repoDir, 0o755);
  await assert.rejects(s.fetch(), /FACTORY_REPO_DIR is not the dispatcher's alone/);
  assert.deepEqual(s.asked, []);
  await chmod(s.product.repoDir, 0o700);
  assert.equal((await s.fetch()).after, s.product.base, 'the clone itself 700 shields it too');
});
