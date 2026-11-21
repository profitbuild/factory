// No module of src/ but the starter holds what a container call wrote to stderr (incident-platform backlog #0-284 AC5;
// ADR-0062 point 6): the starter (container/run-container.mjs) keeps it in a file of the state and returns only the
// file's path, `stderrFile` (its shape: test/run-container.test.mjs). Here, on the source of every other module of
// src/, read as text with testing/child-process-scan.mjs's tokenizer (comments, strings and template literals blanked,
// a template's `${}` with it):
//  1. no module names `stderrFile` in its code: the path goes only into a message, inside a template literal
//     (`${stderrNote(result.stderrFile)}`), so no module can hand it to a read;
//  2. no module that reaches the starter through its imports reads a `stderr` field (`.stderr`, `{ stderr }`), but the
//     dispatcher's own `process.stderr`: a result of the starter's had one before #0-284, and must not again.
// Its bounds: it does not see a field named by a computed key (`r['std' + 'err']`), a read of the file through a path
// built again from the state directory, or code inside a template's `${}` but the path itself; the review reads those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mask } from '../testing/child-process-scan.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const STARTER = 'container/run-container.mjs';

/** Where `source` breaks the rules, `reaches` whether its module reaches the starter. */
export function stderrViolations(source, { reaches }) {
  // The dispatcher's own stderr is not a field of a result: taken out before the rules.
  const code = mask(source).code.replace(/\bprocess\s*\.\s*stderr\b/g, 'process');
  const found = [];
  if (/\bstderrFile\b/.test(code)) {
    found.push('names stderrFile in its code (the path goes only into a template literal\'s message)');
  }
  if (reaches) {
    if (/(?:\?\.|\.)\s*stderr\b/.test(code)) {
      found.push('reads a field stderr');
    }
    if (/\{[^{}]*\bstderr\b[^{}]*\}\s*=/.test(code) || /\(\s*\{[^{}]*\bstderr\b[^{}]*\}\s*\)\s*=>/.test(code)) {
      found.push('destructures a field stderr');
    }
  }
  return found;
}

async function modules() {
  const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => relative(SRC, join(e.parentPath, e.name)));
}

/** The modules of src/ each module imports, by its relative imports. */
async function importGraph(files) {
  const graph = new Map();
  for (const file of files) {
    const source = await readFile(join(SRC, file), 'utf8');
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.{1,2}\/[^']+)'/gms)]
      .map((m) => normalize(join(dirname(file), m[1])));
    graph.set(file, imports);
  }
  return graph;
}

/** The modules from which `target` is reached through imports. */
function reaching(graph, target) {
  const reached = new Set([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, imports] of graph) {
      if (!reached.has(file) && imports.some((i) => reached.has(i))) {
        reached.add(file);
        grew = true;
      }
    }
  }
  reached.delete(target);
  return reached;
}

test('#0-284 AC5: no module of src/ but the starter holds a container call\'s stderr, nor names its file but in a '
  + 'message', async () => {
  const files = await modules();
  const graph = await importGraph(files);
  const reach = reaching(graph, STARTER);
  for (const expected of ['container/task-container.mjs', 'container/daemon.mjs', 'container/work-dir.mjs',
    'container/environment.mjs', 'container/task-bundle.mjs', 'product/commands.mjs', 'cli.mjs']) {
    assert.ok(reach.has(expected), `the scan sees ${expected} reach the starter`);
  }
  const found = [];
  for (const file of files.filter((f) => f !== STARTER)) {
    const source = await readFile(join(SRC, file), 'utf8');
    for (const violation of stderrViolations(source, { reaches: reach.has(file) })) {
      found.push(`${file}: ${violation}`);
    }
  }
  assert.deepEqual(found, []);
});

test('#0-284 AC5: planted code is refused: a read of the file, a field stderr, its destructuring; a message is not',
  () => {
    const refused = {
      'a read of the file': 'await readFile(result.stderrFile, \'utf8\');',
      'the path passed on': 'return { file: result.stderrFile };',
      'destructured path': 'const { stderrFile } = result;',
      'a field stderr': 'const text = result.stderr;',
      'optional chaining': 'log(result?.stderr);',
      'destructured stderr': 'const { code, stderr } = await execInTask(call);',
      'destructured parameter': 'const f = ({ stderr }) => stderr;',
    };
    for (const [what, code] of Object.entries(refused)) {
      assert.notDeepEqual(stderrViolations(code, { reaches: true }), [], what);
    }
    for (const [what, code] of Object.entries({
      'a message': 'throw new Error(`failed; ${stderrNote(result.stderrFile)}`);',
      'the dispatcher\'s own stderr': 'process.stderr.write(`dispatcher: ${error.message}\\n`);',
      'a comment': '// result.stderr and stderrFile are the starter\'s',
      'a string': 'const what = \'its stderr, the agent\\\'s side\\\'s\';',
    })) {
      assert.deepEqual(stderrViolations(code, { reaches: true }), [], what);
    }
    assert.deepEqual(stderrViolations('const { stderr } = spawnSync(git);', { reaches: false }), [],
      'a module that does not reach the starter reads its own child\'s stderr (git, flock)');
  });
