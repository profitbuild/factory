// One agent call (incident-platform backlog #0-301 AC1; ADR-0064 points 2 to 5), on the fake daemon, with recorded
// stream-json (testing/stream-json.mjs): F3's command by the container's ID, every program by its full path, --tools
// from the frontmatter, the prompt on stdin, --json-schema the answer schema's very bytes, env -i's list of literals;
// the stream kept in tasks/<runId>/calls/, 600; the init event checked whole before the answer is read, each field a
// stop; the answer held to its schema; a stream off 2.1.328's form refused by line, never quoted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { setUpTaskContainer } from '../src/container/environment.mjs';
import { readTaskConfig } from '../src/container/task-container.mjs';
import { CALL_PATH, CallError, INIT_CHECKS, callAgent, callArgs, callEnv } from '../src/flow/call.mjs';
import { readAgent } from '../src/flow/agents.mjs';
import { readAnswerSchema } from '../src/flow/answers.mjs';
import { readExpectations } from '../src/flow/expectations.mjs';
import { createTask } from '../src/state/tasks.mjs';
import { makeFakeDaemon } from '../testing/fake-daemon.mjs';
import { REAL_GIT } from '../testing/git-fixtures.mjs';
import { HELPER_IMAGE, makeStateDir } from '../testing/state-dir.mjs';
import { ARCHITECT_ANSWER, IMPLEMENTER_ANSWER, initEvent, resultEvent, stream } from '../testing/stream-json.mjs';
import { CONFIG_PATH, makeTaskProduct } from '../testing/task-product.mjs';

const root = await makeStateDir();
after(root.remove);
const RUN_ID = '20261122T120000Z-0c0301';
const expectations = await readExpectations();

// One task container for every case: each call is a new number in it.
const fake = makeFakeDaemon(root.dir);
const product = await makeTaskProduct(root.dir);
const stateDir = fake.stateDir;
const ready = await setUpTaskContainer({ stateDir, repoDir: product.repoDir, task: await createTask(stateDir,
  { runId: RUN_ID }), adapter: { taskImage: CONFIG_PATH }, helperImage: HELPER_IMAGE, ...fake.runner, git: REAL_GIT });
assert.equal(ready.task.status, 'running', ready.task.reason);
let n = 0;

/** A call of `agent` whose fake Claude Code prints `lines`. */
async function callWith(agent, lines, { exit = 0 } = {}) {
  n += 1;
  fake.update((s) => { s.scenario.claude = [{ stream: lines, exit }]; });
  return callAgent({ container: ready.container, task: ready.task, n, agentName: agent, prompt: `the task, call ${n}`,
    carried: ready.carried, expectations, stateDir, ...fake.runner });
}

const refused = async (agent, lines, pattern) => {
  await assert.rejects(callWith(agent, lines), (error) => {
    assert.ok(error instanceof CallError, `${error.constructor.name}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes('agent-words'), error.message);
    return true;
  });
};

test('#0-301 AC1: a call is F3 by the container\'s ID, full paths, --tools from the frontmatter, the prompt on stdin, '
  + 'the schema\'s bytes, env -i\'s literals; its stream and answer kept 600', async () => {
  const { answer, file, answerFile } = await callWith('architect', stream('architect', ARCHITECT_ANSWER));
  assert.deepEqual(answer, ARCHITECT_ANSWER);
  const [call] = fake.claudeCalls().slice(-1);
  const exec = fake.calls().filter((c) => c.args[0] === 'exec').at(-1);
  const at = exec.args.indexOf(ready.container.id);
  assert.ok(at > 0, 'the container by its checked ID');
  assert.deepEqual(exec.args.slice(at + 1, at + 2), ['/usr/bin/timeout']);
  assert.ok(exec.args.includes('-w') && exec.args[exec.args.indexOf('-w') + 1] === '/workspace', 'from /workspace');
  const agent = await readAgent('architect');
  const { text } = await readAnswerSchema('architect');
  assert.deepEqual(call.argv.slice(call.argv.indexOf('/usr/bin/env')), callArgs({ agent, schemaText: text,
    carried: ready.carried }));
  const argv = call.argv;
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(argv[argv.indexOf('/usr/bin/env') + 1], '-i');
  assert.ok(argv.includes('/usr/local/bin/claude'));
  assert.equal(flag('--plugin-dir'), '/opt/factory');
  assert.equal(flag('--agent'), 'factory:architect');
  assert.ok(argv.includes('--restricted'));
  assert.equal(flag('--tools'), agent.tools.join(','), '--tools the frontmatter\'s');
  assert.equal(flag('--add-dir'), '/workspace');
  assert.equal(flag('--output-format'), 'stream-json');
  assert.ok(argv.includes('--verbose'));
  assert.equal(flag('--json-schema'), JSON.stringify(JSON.parse(await readFile(new URL(
    '../../schemas/answers/architect.schema.json', import.meta.url), 'utf8'))), 'the very schema validate.mjs holds');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--max-turns'), String(agent.maxTurns));
  assert.equal(call.stdin, `the task, call ${n}`, 'the prompt on stdin');
  assert.ok(!argv.includes(`the task, call ${n}`), 'never in argv');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(answerFile)).mode & 0o777, 0o600);
  assert.ok(file.startsWith(join(stateDir, 'tasks', RUN_ID, 'calls', '/').slice(0, -1)));
});

test('#0-301: env -i\'s list holds literals alone: HOME, the locale, PATH\'s system directories, the accepted '
  + 'containerEnv and the three switches', async () => {
  const carried = await readTaskConfig({ repoDir: product.repoDir, base: product.base, path: CONFIG_PATH,
    git: REAL_GIT });
  const env = callEnv(carried);
  assert.deepEqual(env, ['HOME=/home/dev', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', `PATH=${CALL_PATH}`,
    ...Object.entries(carried.containerEnv).map(([k, v]) => `${k}=${v}`), 'DISABLE_AUTOUPDATER=1', 'DISABLE_UPDATES=1',
    'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1']);
  assert.ok(!CALL_PATH.includes('.local'), 'no user\'s directory on PATH');
});

/** A value of each init field that breaks its rule. */
const OFF = {
  agents: [['claude', 'factory:implementer'], ['factory:architect', 'evil:spy'], 'factory:architect', undefined],
  plugins: [
    [{ name: 'factory', path: '/opt/factory', source: 'factory@inline' }],
    [...initEvent('architect').plugins, { name: 'evil', path: '/x', source: 'evil@market' }],
    initEvent('architect').plugins.map((p) => (p.name === 'factory' ? { ...p, path: '/workspace' } : p)),
    initEvent('architect').plugins.map((p) => (p.name === 'factory' ? { ...p, source: 'factory@market' } : p)),
    [...initEvent('architect').plugins, { name: 'cc-plugin-new', path: 'builtin', source: 'cc-plugin-new@builtin' }],
    undefined],
  plugin_errors: [[{ plugin: 'factory', error: 'agent-words' }], 'x'],
  tools: [['Read', 'Grep', 'Glob', 'Bash', 'Edit'], ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch'],
    ['Read', 'Read', 'Glob', 'Bash', 'Edit', 'Write'], undefined],
  model: ['claude-sonnet-5-5', undefined],
  permissionMode: ['default', 'bypassPermissions', undefined],
  claude_code_version: ['2.1.329', undefined],
  mcp_servers: [[{ name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' }], undefined],
};

test('#0-301 AC1: each field of the init event off its rule stops the call, naming the field; the answer is not read',
  async () => {
    assert.deepEqual(Object.keys(OFF).sort(), Object.keys(INIT_CHECKS).sort(), 'a case for every rule');
    for (const [field, values] of Object.entries(OFF)) {
      for (const value of values) {
        const init = initEvent('architect');
        if (value === undefined) {
          delete init[field];
        } else {
          init[field] = value;
        }
        if (field === 'plugin_errors' && value === undefined) {
          continue;
        }
        await refused('architect', [init, resultEvent(ARCHITECT_ANSWER)],
          new RegExp(`^the call's init event is not the one expected: ${field} \\(`));
      }
    }
    // plugin_errors absent, or empty, keeps its rule; a builtin plugin listed in another order too.
    for (const init of [initEvent('architect', { plugin_errors: [] }),
      initEvent('architect', { plugins: [...initEvent('architect').plugins].reverse() })]) {
      assert.deepEqual((await callWith('architect', [init, resultEvent(ARCHITECT_ANSWER)])).answer, ARCHITECT_ANSWER);
    }
  });

test('#0-301 AC1: the expected tools are the pinned version\'s for the agent, and implementer-light\'s model its own',
  async () => {
    const light = await readAgent('implementer-light');
    assert.equal(light.model, 'claude-sonnet-5-5');
    await refused('implementer-light', stream('implementer-light', IMPLEMENTER_ANSWER,
      { init: { model: 'claude-opus-5-5' } }), /: model \(/);
    assert.deepEqual((await callWith('implementer-light', stream('implementer-light', IMPLEMENTER_ANSWER))).answer,
      IMPLEMENTER_ANSWER);
  });

test('#0-301 AC1: no structured_output, a result that is no success, or an answer off its schema stops the call',
  async () => {
    const init = initEvent('architect');
    const { structured_output: dropped, ...bare } = resultEvent(ARCHITECT_ANSWER);
    assert.ok(dropped);
    await refused('architect', [init, bare], /^the call's result holds no structured_output \(/);
    await refused('architect', [init, resultEvent(null, { subtype: 'error_max_turns', is_error: true })],
      /^the call ended without an answer \(result error_max_turns; /);
    await refused('architect', [init, resultEvent(ARCHITECT_ANSWER, { is_error: true })],
      /^the call ended without an answer \(result success; /);
    await refused('architect', [init, resultEvent(null, { subtype: 'agent-words' })],
      /^the call ended without an answer \(result unknown; /);
    await refused('architect', [init, resultEvent({ ...ARCHITECT_ANSWER, 'agent-words': 1 })],
      /^the call's answer is not its schema's \(1 error; /);
    await refused('architect', [init, resultEvent({ ...ARCHITECT_ANSWER, blocked: 'agent-words' })],
      /^the call's answer is not its schema's \(1 error; /);
    await refused('implementer', [initEvent('implementer'), resultEvent(ARCHITECT_ANSWER)],
      /^the call's answer is not its schema's \(\d+ errors; /);
  });

test('#0-301 AC1: a stream off 2.1.328\'s form is refused by its line, never quoted', async () => {
  const init = initEvent('architect');
  const end = resultEvent(ARCHITECT_ANSWER);
  for (const [lines, pattern] of [
    [[], /^the call's stream is empty/],
    [['agent-words', end], /^line 1 of the call's stream is not JSON/],
    [[init, 'agent-words {', end], /^line 2 of the call's stream is not JSON/],
    [[init, { type: 'agent-words' }, end], /^line 2 of the call's stream is not one of Claude Code 2\.1\.328's events/],
    [[init, { type: 'system', subtype: 'compact_boundary' }, end], /^line 2 .* not one of Claude Code 2\.1\.328's/],
    [[{ type: 'assistant', message: {} }, init, end], /^the call's stream does not begin with its init event/],
    [[init, init, end], /^line 2 of the call's stream is a second init event/],
    [[init], /^the call's stream has no result/],
    [[init, end, end], /^line 3 of the call's stream follows its result/],
  ]) {
    await refused('architect', lines, pattern);
  }
});
