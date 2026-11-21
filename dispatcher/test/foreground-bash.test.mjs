// The plugin's foreground-bash hook (hooks/foreground-bash.mjs, incident-platform backlog #0-299, #0-206): run as
// Claude Code runs it, `node <script>` with the call's JSON on stdin. Exit 2 refuses the call, and every way but a Bash
// call in the foreground must end in it: Claude Code runs the call after any other status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../hooks/foreground-bash.mjs', import.meta.url));
const COMMAND = 'echo s3cr3t-marker';

/**
 * Runs the hook on `stdin`. `preload`, a module's source, is given to node with --import, before the hook: the tests
 * make the hook fail from outside it, with the hook's file unchanged. `nodeArgs` go to node before them.
 */
function run(stdin, { end = true, preload, nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...nodeArgs, ...(preload === undefined ? []
      : ['--import', `data:text/javascript,${encodeURIComponent(preload)}`]), SCRIPT];
    const child = spawn(process.execPath, args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // The hook may stop reading and exit before a large input is written whole.
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') { reject(error); } });
    child.stdin.write(stdin);
    if (end) {
      child.stdin.end();
    }
  });
}

const call = (toolInput, toolName = 'Bash') => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse',
  tool_name: toolName, tool_input: toolInput });

test('a Bash call in the background is refused, with what to do instead and nothing of the input', async () => {
  for (const background of [true, 'true', 1, 'false', null, {}]) {
    const result = await run(call({ command: COMMAND, run_in_background: background }));
    assert.equal(result.code, 2, JSON.stringify(background));
    assert.match(result.stderr, /^BLOCKED by foreground-bash: /);
    assert.doesNotMatch(result.stderr, /s3cr3t-marker/);
  }
  const { stderr } = await run(call({ command: COMMAND, run_in_background: true }));
  assert.match(stderr, /run the command in the foreground/);
  assert.match(stderr, /timeout/);
});

test('a Bash call in the foreground runs: run_in_background false or absent', async () => {
  for (const toolInput of [{ command: COMMAND }, { command: COMMAND, run_in_background: false, timeout: 600000 }]) {
    const result = await run(call(toolInput));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' }, JSON.stringify(toolInput));
  }
});

test('bad JSON, an empty input, no tool_input and another tool are refused', async () => {
  const cases = {
    'not JSON': `{"tool_name":"Bash","tool_input":{"command":"${COMMAND}"`,
    empty: '',
    'JSON null': 'null',
    'an array': '[]',
    'no tool_input': JSON.stringify({ tool_name: 'Bash' }),
    'tool_input a string': JSON.stringify({ tool_name: 'Bash', tool_input: COMMAND }),
    'tool_input an array': JSON.stringify({ tool_name: 'Bash', tool_input: [] }),
    'another tool': call({ command: COMMAND }, 'Write'),
    'no tool_name': JSON.stringify({ tool_input: { command: COMMAND } }),
  };
  for (const [what, stdin] of Object.entries(cases)) {
    const result = await run(stdin);
    assert.equal(result.code, 2, what);
    assert.match(result.stderr, /^BLOCKED by foreground-bash: .*so the call is refused\n$/, what);
    assert.doesNotMatch(result.stderr, /s3cr3t-marker/, what);
  }
});

test('an input that does not end is refused once the hook stops waiting', { timeout: 30_000 }, async () => {
  const result = await run(call({ command: COMMAND }), { end: false });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /did not end in time/);
});

test('an input over 1 MiB is refused, even a Bash call in the foreground, and its text is not quoted', async () => {
  const command = `echo ${'s3cr3t-marker '.repeat(Math.ceil((1024 * 1024) / 14))}`;
  const stdin = call({ command });
  assert.ok(Buffer.byteLength(stdin) > 1024 * 1024);
  const result = await run(stdin);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^BLOCKED by foreground-bash: the hook's input is too large, so the call is refused\n$/);
  assert.doesNotMatch(result.stderr, /s3cr3t-marker/);
});

test('an exception, a rejected promise and a failing read end in a refusal, never in node\'s exit 1',
  { timeout: 30_000 }, async () => {
  const failures = {
    // After the hook's module has run up to its read of stdin, so its handlers are in place; stdin is left open.
    'an uncaught exception': "setTimeout(() => { throw new Error('s3cr3t-marker'); }, 50);",
    'an unhandled rejection': "setTimeout(() => { Promise.reject(new Error('s3cr3t-marker')); }, 50);",
    // Under node's default mode a rejection is raised as an exception, which the exception's handler would refuse
    // alone; a NODE_OPTIONS of the session can make it a warning, and then only the rejection's handler refuses it.
    'an unhandled rejection, as a warning': "setTimeout(() => { Promise.reject(new Error('s3cr3t-marker')); }, 50);",
    // The read itself throws: main()'s promise, awaited at the module's top, rejects.
    'a failing read of stdin': "process.stdin[Symbol.asyncIterator] = () => { throw new Error('s3cr3t-marker'); };",
  };
  for (const [what, preload] of Object.entries(failures)) {
    const result = await run(call({ command: COMMAND }), { end: what === 'a failing read of stdin', preload,
      nodeArgs: what.endsWith('as a warning') ? ['--unhandled-rejections=warn'] : [] });
    assert.equal(result.code, 2, what);
    assert.equal(result.stderr, 'BLOCKED by foreground-bash: the guard failed, so the call is refused\n', what);
  }
});
