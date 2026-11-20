// Every function of node:child_process called in dispatcher/src/ takes its env from childEnv (incident-platform backlog
// #0-276 AC7): spawn, exec, execFile, fork and their Sync forms. The scan and its bounds are
// testing/child-process-scan.mjs's; here it runs on every module of src/, and on planted code it must refuse, so a scan
// that passed everything would fail here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { childProcessViolations } from '../testing/child-process-scan.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

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
