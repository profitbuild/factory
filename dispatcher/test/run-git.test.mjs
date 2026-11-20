// The one way the dispatcher runs git (incident-platform backlog #0-276, review round 1 gen-b5c2), with a fake git: a
// call that writes more than the bound is ended, one that runs past its time is ended, a git that is not there cannot
// be run; each is a GitRunError naming what happened. And what every call carries: git by its full path, the
// overrides first, GIT_DIR when a repository is named, the environment childEnv builds.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GIT, GIT_OVERRIDES, GitRunError, runGit } from '../src/git/run-git.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);

/** A fake git: a shell script doing `body`. */
async function fakeGit(name, body) {
  const path = join(root.dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const refused = (pattern) => (error) => {
  assert.ok(error instanceof GitRunError, `${error.constructor.name}: ${error.message}`);
  assert.match(error.message, pattern);
  return true;
};

test('a call writing more than the bound to stdout, or to stderr, is ended and refused', async () => {
  const flood = await fakeGit('flood', 'head -c 100000 /dev/zero');
  await assert.rejects(runGit({ cwd: root.dir, git: flood, args: ['log'], maxOutput: 1000 }),
    refused(/^git log wrote more than 1000 bytes to its stdout: stopped$/));
  const floodErr = await fakeGit('flood-err', 'head -c 100000 /dev/zero >&2');
  await assert.rejects(runGit({ cwd: root.dir, git: floodErr, args: ['log'], maxOutput: 1000 }),
    refused(/^git log wrote more than 1000 bytes to its stderr: stopped$/));
  const exact = await fakeGit('exact', 'head -c 1000 /dev/zero');
  assert.equal((await runGit({ cwd: root.dir, git: exact, args: ['log'], maxOutput: 1000 })).stdout.length, 1000,
    'at the bound is kept');
});

test('a call that runs past its time is ended and refused', async () => {
  // A sleep it would finish: without the timeout the call resolves, and the expected refusal is missing.
  const sleeper = await fakeGit('sleeper', 'exec sleep 5');
  await assert.rejects(runGit({ cwd: root.dir, git: sleeper, args: ['push'], timeoutMs: 100 }),
    refused(/^git push was ended by SIGKILL, after at most 100 ms$/));
});

test('a git that is not there cannot be run, and says so', async () => {
  await assert.rejects(runGit({ cwd: root.dir, git: join(root.dir, 'no-git'), args: ['status'] }),
    refused(/^\/.*\/no-git could not be run: ENOENT$/));
});

test('a call is git by its full path, the overrides first, GIT_DIR when named, and childEnv\'s environment', async () => {
  const dumps = join(root.dir, 'dumps');
  await mkdir(dumps);
  const recorder = await fakeGit('recorder', `printf '%s\\n' "$@" > ${join(dumps, 'argv')}\nenv > ${join(dumps, 'env')}\n`
    + 'echo out; echo err >&2; exit 3');
  const result = await runGit({ cwd: root.dir, gitDir: '/the/repo.git', git: recorder, args: ['cat-file', '-t', 'x'],
    input: 'in', baseEnv: { PATH: '/bin:/usr/bin', HOME: '/h', OTHER: 'o' }, set: { EXTRA: 'e' } });
  assert.deepEqual(result, { code: 3, stdout: Buffer.from('out\n'), stderr: 'err\n' });
  assert.deepEqual((await readFile(join(dumps, 'argv'), 'utf8')).trim().split('\n'),
    [...GIT_OVERRIDES, 'cat-file', '-t', 'x']);
  const env = Object.fromEntries((await readFile(join(dumps, 'env'), 'utf8')).trim().split('\n')
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const [name, value] of Object.entries({ PATH: '/bin:/usr/bin', HOME: '/h', GIT_DIR: '/the/repo.git',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C', EXTRA: 'e' })) {
    assert.equal(env[name], value, name);
  }
  assert.equal(env.OTHER, undefined, 'a variable not allowed does not reach git');
  assert.equal(GIT, '/usr/bin/git');
  assert.throws(() => runGit({ args: ['status'] }), /cwd, a directory of the dispatcher's own, is required/);
});

test('#0-277: `large` bounds a call by GIT_MAX_LARGE_OUTPUT, a bundle\'s bound, and nothing else does', async () => {
  const { GIT_MAX_LARGE_OUTPUT, GIT_MAX_OUTPUT } = await import('../src/git/run-git.mjs');
  const { MAX_BUNDLE_BYTES } = await import('../src/git/bundle.mjs');
  assert.equal(GIT_MAX_LARGE_OUTPUT, MAX_BUNDLE_BYTES);
  const big = await fakeGit('big', `head -c ${GIT_MAX_OUTPUT + 1} /dev/zero`);
  await assert.rejects(runGit({ cwd: root.dir, git: big, args: ['bundle'] }),
    refused(new RegExp(`^git bundle wrote more than ${GIT_MAX_OUTPUT} bytes to its stdout: stopped$`)));
  assert.equal((await runGit({ cwd: root.dir, git: big, args: ['bundle'], large: true })).stdout.length,
    GIT_MAX_OUTPUT + 1);
  await assert.rejects(runGit({ cwd: root.dir, git: big, args: ['bundle'], large: 'yes' }), GitRunError,
    'only true chooses the larger bound');
});
