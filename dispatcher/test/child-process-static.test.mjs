// Every function of node:child_process called in dispatcher/src/ takes its env from childEnv (incident-platform backlog
// #0-276 AC7): spawn, exec, execFile, fork and their Sync forms. The scan and its bounds are
// testing/child-process-scan.mjs's; here it runs on every module of src/, and on planted code it must refuse, so a scan
// that passed everything would fail here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { childProcessCalls, childProcessViolations, mask } from '../testing/child-process-scan.mjs';
import { testOnlyOptions } from '../testing/test-only-options-scan.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/', import.meta.url));

async function modules() {
  const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => join(entry.parentPath, entry.name));
}

test('AC7: every child process started in src/ gets an env built by childEnv', async () => {
  const files = await modules();
  const found = [];
  let calling = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (source.includes('child_process')) {
      calling += 1;
    }
    for (const violation of childProcessViolations(source)) {
      found.push(`${file.slice(SRC.length)}: ${violation}`);
    }
  }
  assert.deepEqual(found, []);
  assert.ok(calling >= 2, 'the scan saw the modules that start processes (run-git.mjs, lock.mjs)');
});

const IMPORT = "import { spawn, spawnSync, exec, execFile, execFileSync, fork } from 'node:child_process';\n"
  + "import { childEnv } from './child-env.mjs';\n";

test('AC7: planted code is refused: env: process.env, exec with no env, and every way around the rule', () => {
  const refused = {
    'env: process.env': "spawn('git', [], { env: process.env });",
    'exec without env': "exec('ls', () => {});",
    'execFileSync without options': "execFileSync('git', ['status']);",
    'spawnSync with env: {}': "spawnSync('flock', [], { env: {} });",
    'fork with an env variable': 'const env = childEnv(); fork(\'x.mjs\', [], { env });',
    'env replaced by a spread after childEnv': "spawn('git', [], { env: childEnv(), ...options });",
    'env written twice': "spawn('git', [], { env: childEnv(), env: process.env });",
    'an alias': "const run = spawn; run('git', [], { env: process.env });",
    'passed as a value': "[1].map(execFile);",
  };
  for (const [what, code] of Object.entries(refused)) {
    assert.notDeepEqual(childProcessViolations(`${IMPORT}${code}\n`), [], what);
  }
  for (const [what, source] of Object.entries({
    namespace: "import * as cp from 'node:child_process';\ncp.spawn('git', [], { env: childEnv() });\n",
    'default import': "import cp from 'child_process';\n",
    require: "const { spawn } = require('node:child_process');\n",
    'dynamic import': "const cp = await import('node:child_process');\n",
    're-export': "export { spawn } from 'node:child_process';\n",
    'the name in a string': "const name = 'node:child_process';\n",
  })) {
    assert.notDeepEqual(childProcessViolations(source), [], what);
  }
});

test('AC7: what the rule allows passes, and what only looks like a call does not count', () => {
  assert.deepEqual(childProcessViolations(`${IMPORT}`
    + "spawn('git', [...args], { cwd, env: childEnv({ allow, set: { ...set, A: 'b' } }), timeout });\n"
    + "spawnSync('/usr/bin/flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], env: childEnv() });\n"
    + "child.spawn('x'); // spawn('git', [], { env: process.env }) in a comment\n"
    + "const text = \"spawn('git', { env: process.env })\";\n"
    + "const re = /spawn\\(/; const t = `exec(${'x'})`;\n"), []);
});

/**
 * Which module may start which program: git from run-git.mjs alone, as its variable `git` (GIT, /usr/bin/git); sudo
 * from the container starter alone, as its variable `sudo` (SUDO, /usr/bin/sudo), and through it docker and the
 * devcontainer CLI (#0-277 AC9).
 */
const STARTS = { 'git/run-git.mjs': 'git', 'state/lock.mjs': 'flock', 'container/run-container.mjs': 'sudo' };

/** Where the calls of `source`, a module at `path` under src/, break that rule. */
function wrongStarts(path, source) {
  return childProcessCalls(source)
    .filter(({ first }) => STARTS[path] === undefined || first !== STARTS[path])
    .map(({ name, first }) => `${path}: ${name}(${first}, ...) is not this module's to start`);
}

test('review round 1: git is started by src/git/run-git.mjs alone, and flock(1) by src/state/lock.mjs alone', async () => {
  const found = [];
  for (const file of await modules()) {
    found.push(...wrongStarts(file.slice(SRC.length), await readFile(file, 'utf8')));
  }
  assert.deepEqual(found, []);
  const planted = (code) => `${IMPORT}${code}\n`;
  assert.notDeepEqual(wrongStarts('github/push.mjs', planted("spawn('git', ['push'], { env: childEnv() });")), []);
  assert.notDeepEqual(wrongStarts('github/push.mjs', planted("execFile('/usr/bin/git', [], { env: childEnv() });")), []);
  assert.notDeepEqual(wrongStarts('github/push.mjs', planted('spawn(git, [], { env: childEnv() });')), []);
  assert.notDeepEqual(wrongStarts('git/run-git.mjs', planted("spawn('sh', ['-c', 'git push'], { env: childEnv() });")), []);
  assert.notDeepEqual(wrongStarts('state/lock.mjs', planted("spawnSync('git', [], { env: childEnv() });")), []);
  assert.deepEqual(wrongStarts('git/run-git.mjs', planted('spawn(git, [...GIT_OVERRIDES], { env: childEnv() });')), []);
  // #0-277 AC9: docker and devcontainer never but through the starter's sudo, whatever module tries.
  for (const [path, code] of [
    ['container/daemon.mjs', "spawn('/usr/bin/docker', ['ps'], { env: childEnv() });"],
    ['container/task-container.mjs', "execFile('devcontainer', ['up'], { env: childEnv() });"],
    ['container/run-container.mjs', "spawn('/usr/bin/docker', ['ps'], { env: childEnv() });"],
    ['container/run-container.mjs', "spawn(docker, ['ps'], { env: childEnv() });"],
    ['cli.mjs', "spawnSync('sudo', ['-u', 'factory', 'docker'], { env: childEnv() });"],
  ]) {
    assert.notDeepEqual(wrongStarts(path, planted(code)), [], `${path}: ${code}`);
  }
  assert.deepEqual(wrongStarts('container/run-container.mjs',
    planted('spawn(sudo, [...SUDO_OPTIONS, PROGRAMS[program], ...args], { env: childEnv() });')), []);
});

/** The full paths of sudo, docker and the devcontainer CLI: named by the starter alone. */
const PROGRAM_PATHS = ['/usr/bin/sudo', '/usr/bin/docker', '/usr/local/bin/devcontainer'];

test('#0-277 AC9: no module of src/ but the starter names sudo, docker or the devcontainer CLI by its path', async () => {
  const found = [];
  for (const file of await modules()) {
    const path = file.slice(SRC.length);
    const source = await readFile(file, 'utf8');
    for (const program of PROGRAM_PATHS.filter((p) => source.includes(p))) {
      if (path !== 'container/run-container.mjs') {
        found.push(`${path} names ${program}`);
      }
    }
  }
  assert.deepEqual(found, []);
  const starter = await readFile(join(SRC, 'container', 'run-container.mjs'), 'utf8');
  assert.ok(PROGRAM_PATHS.every((p) => starter.includes(`'${p}'`)), 'the starter names all three');
});

/**
 * #0-277 AC10: the dispatcher writes nothing in a directory of factory's. A module that names factory's paths (it
 * imports TASKS_ROOT, HELPER_TASKS or taskPaths from container/paths.mjs) touches no file: it imports neither node:fs
 * nor node:fs/promises, nor a module of the dispatcher's that writes files (state/files.mjs); what it puts there goes
 * through a helper's stdin (work-dir.mjs).
 */
function writesWhereFactoryIs(path, source) {
  const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => [m[0], m[1]]);
  const namesPaths = imports.some(([text, from]) => /(?:^|\/)paths\.mjs$/.test(from)
    && /\b(?:TASKS_ROOT|HELPER_TASKS|taskPaths)\b/.test(text));
  const touchesFiles = imports.some(([, from]) => /^(?:node:)?fs(?:\/promises)?$/.test(from)
    || /(?:^|\/)state\/files\.mjs$/.test(from) || /(?:^|\/)files\.mjs$/.test(from))
    || /\bimport\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]/.test(source);
  return namesPaths && touchesFiles ? [`${path} names factory's paths and touches files`] : [];
}

test('#0-277 AC10: no module of src/ both names factory\'s paths and touches a file', async () => {
  const found = [];
  let naming = 0;
  for (const file of await modules()) {
    const source = await readFile(file, 'utf8');
    if (/\b(?:TASKS_ROOT|taskPaths)\b/.test(source)) {
      naming += 1;
    }
    found.push(...writesWhereFactoryIs(file.slice(SRC.length), source));
  }
  assert.deepEqual(found, []);
  assert.ok(naming >= 4, 'the scan saw the modules that name the paths');
  const paths = "import { taskPaths } from './paths.mjs';\n";
  for (const planted of [
    `${paths}import { writeFile } from 'node:fs/promises';\n`,
    `${paths}import fs from 'node:fs';\n`,
    "import { TASKS_ROOT } from '../container/paths.mjs';\nimport { writeJsonAtomic } from '../state/files.mjs';\n",
    `${paths}const fs = await import('node:fs');\n`,
  ]) {
    assert.notDeepEqual(writesWhereFactoryIs('container/x.mjs', planted), [], planted);
  }
  assert.deepEqual(writesWhereFactoryIs('container/x.mjs', "import { M2_VOLUME } from './paths.mjs';\n"
    + "import { open } from 'node:fs/promises';\n"), []);
});

test('review rounds 2 and 3, #0-277, #0-278: no module of src/ or bin/ gives a test\'s option (git, gitBase, hooks, '
  + 'maxOutput, lstatOf, uid, sudo, apiBase)', async () => {
  const found = [];
  for (const file of await modules()) {
    found.push(...testOnlyOptions(file.slice(SRC.length), await readFile(file, 'utf8')));
  }
  const bins = (await readdir(BIN)).filter((name) => name.endsWith('.mjs'));
  assert.ok(bins.length >= 2, 'the scan sees bin/');
  for (const name of bins) {
    found.push(...testOnlyOptions(`bin/${name}`, await readFile(join(BIN, name), 'utf8')));
  }
  assert.deepEqual(found, []);
  for (const [path, code] of [
    ['cli.mjs', "pushTask({ stateDir, gitBase: 'http://127.0.0.1:1' });"],
    ['cli.mjs', 'pushTask({ stateDir, hooks: { afterInit } });'],
    ['cli.mjs', "runGit({ cwd, args, git: '/tmp/git' });"],
    ['cli.mjs', 'runGit({ cwd, args, maxOutput: 1 });'],
    ['cli.mjs', "loadBundle({ gitDir, bundle, git: '/tmp/git' });"],
    ['cli.mjs', "initBare(dir, path, { git: '/tmp/git' });"],
    ['cli.mjs', 'mainObjects(repoDir, { lstatOf });'],
    ['cli.mjs', "pushTarget(repository, 'http://127.0.0.1:1');"],
    ['cli.mjs', 'pushTask({ stateDir, git });'],
    ['github/push.mjs', "runGit({ cwd, args, git: '/tmp/git' });"],
    ['github/push.mjs', "pushTarget(repository, 'http://127.0.0.1:1');"],
    ['git/bundle.mjs', 'runGit({ cwd, args, maxOutput: 10 });'],
    ['cli.mjs', "runGit({ cwd, args, 'git': '/tmp/git' });"],
    ['cli.mjs', 'pushTask({ stateDir, "gitBase": base });'],
    ['bin/check-app.mjs', "pushTask({ stateDir, hooks: {} });"],
    ['cli.mjs', 'pushTask({ stateDir, uid: 0 });'],
    ['cli.mjs', 'mainObjects(repoDir, { uid });'],
    ['github/push.mjs', "const git = '/tmp/git';\nrunGit({ cwd, args, git });"],
    ['container/daemon.mjs', "mustRun({ program: 'docker', args, sudo: '/tmp/sudo' });"],
    ['cli.mjs', "sweepDaemon({ runId, helperImage, sudo: fake });"],
    ['container/environment.mjs', "const sudo = '/tmp/sudo';\nupContainer({ runId, carried, sudo });"],
    ['github/push.mjs', 'runContainerCommand({ program, args, sudo });'],
    ['bin/check-app.mjs', "main(['sweep'], { sudo: '/tmp/x' });"],
    // #0-278: the CLI forwards its test's gitBase and apiBase (the fake GitHub's), and no other module may.
    ['container/environment.mjs', 'pushTask({ stateDir, gitBase });'],
    ['cli.mjs', 'fetchMain({ stateDir, gitBase: base });'],
    ['cli.mjs', "openPullHeads({ repository, apiBase: 'http://127.0.0.1:1' });"],
    ['product/commands.mjs', 'openPullHeads({ repository, apiBase });'],
    ['github/push.mjs', 'fetchMain({ stateDir, apiBase });'],
    ['product/trusted-paths.mjs', 'withTaskObjects({ stateDir, hooks });'],
    ['container/daemon.mjs', 'pushTask({ stateDir, hooks });'],
    ['git/bundle.mjs', "let { git } = other;\nrunGit({ cwd, args, git });"],
  ]) {
    assert.notDeepEqual(testOnlyOptions(path, `${code}\n`), [], `${path}: ${code}`);
  }
  assert.deepEqual(testOnlyOptions('github/push.mjs',
    'export async function pushTask({ git, gitBase, hooks = {} }) {\n  initBare(dir, repo, { git });\n'
    + '  pushTarget(repository, gitBase);\n  runGit({ cwd, gitDir, git, args });\n}\n'), [],
  'a module that runs git forwards its caller\'s own option');
  assert.deepEqual(testOnlyOptions('cli.mjs', "pushTask({ stateDir, tokens }); pushTarget(repository);\n"), []);
});

/**
 * incident-platform backlog #0-278, ADR-0060 D6 as amended: no product code runs as `dispatcher`, main's included.
 * Held three ways, on top of the rule of which module starts which program (above: git, flock and sudo, each by one
 * module, so no product path is ever a program the dispatcher starts):
 *  - src/product/, which reads the product, starts nothing itself: no mention of child_process;
 *  - the adapter's commands are named only where they are checked (adapter-from-base.mjs) and where they are handed
 *    to the task container (commands.mjs), which reaches it through execInTask alone, the starter's docker exec;
 *  - test/cli.test.mjs runs the whole flow with scripts that leave a mark if run, and finds none.
 */
const NAMES_COMMANDS = /\b(?:gate|changedPaths)\.command\b|\]\.command\b/;
const COMMAND_MODULES = ['product/adapter-from-base.mjs', 'product/commands.mjs'];

function productCodeOnHost(path, source) {
  const found = [];
  if (path.startsWith('product/') && source.includes('child_process')) {
    found.push(`${path} mentions child_process`);
  }
  if (NAMES_COMMANDS.test(mask(source).code) && !COMMAND_MODULES.includes(path)) {
    found.push(`${path} names the adapter's commands`);
  }
  if (path === 'product/commands.mjs' && /\b(?:runGit|runContainerCommand|mustRun)\s*\(/.test(mask(source).code)) {
    found.push(`${path} reaches a host starter, not execInTask alone`);
  }
  return found;
}

test('#0-278 D6: no product code runs as dispatcher: src/product/ starts nothing, the commands go to the container only',
  async () => {
    const found = [];
    for (const file of await modules()) {
      found.push(...productCodeOnHost(file.slice(SRC.length), await readFile(file, 'utf8')));
    }
    assert.deepEqual(found, []);
    const commands = await readFile(join(SRC, 'product', 'commands.mjs'), 'utf8');
    assert.match(commands, /return execInTask\(\{ container, sudo, limitS, graceS, env, outputLimit,/);
    for (const [path, code] of [
      ['product/commands.mjs', "import { spawn } from 'node:child_process';\n"],
      ['cli.mjs', 'runGit({ cwd, args: adapter.gate.command });\n'],
      ['github/push.mjs', "spawnLike(adapter['changedPaths'].command);\nconst x = adapter[which].command;\n"],
      ['product/commands.mjs', 'mustRun({ program: \'docker\', args: adapter[which].command });\n'],
    ]) {
      assert.notDeepEqual(productCodeOnHost(path, code), [], `${path}: ${code}`);
    }
    assert.deepEqual(productCodeOnHost('product/commands.mjs', 'execInTask({ args: adapter[which].command });\n'), []);
  });
