// The build zone's parts that need no container (incident-platform backlog #0-301): the item's closed parser (both
// forms of BACKLOG.md), the findings' file, each agent's answer schema against its definition's example (AC5), the
// expectations (AC6) and the managed settings, the limits that stop a run before any call (AC3), and the recorded
// stream's keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENTS, readAgent } from '../src/flow/agents.mjs';
import { ANSWER_SCHEMAS, answerErrors, readAnswerSchema } from '../src/flow/answers.mjs';
import { readExpectations } from '../src/flow/expectations.mjs';
import { FindingsError, coverageProblem, readFindings } from '../src/flow/findings.mjs';
import { ItemError, parseItem } from '../src/flow/item.mjs';
import { INIT_CHECKS, initViolations } from '../src/flow/call.mjs';
import { MAX_AGENT_CALLS, MAX_ROUNDS, MAX_TEST_FIXES, buildPhases } from '../src/flow/phases.mjs';
import { createTask, runPhases, updateTask, loadTask } from '../src/state/tasks.mjs';
import { openBreaker } from '../src/state/breaker.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';
import { INIT_KEYS, RESULT_KEYS, initEvent, resultEvent } from '../testing/stream-json.mjs';

const ROOT = new URL('../../', import.meta.url);

// The two forms of a BACKLOG.md item (the owner's A): Complexity in the middle of a line; "AC<n>." lines with or
// without the heading.
const WITH_HEADING = `### 0-12. A thing with its heading
**Type:** feature · **Priority:** High · **Status:** Open.
**Autopilot:** yes · **Risk:** low · **Complexity:** low · **Depends on:** none

**Acceptance criteria.**
AC1. It works.
AC2. It is tested.
`;
const WITHOUT_HEADING = `### 0-13. A thing with no heading for its criteria
**Autopilot:** human-only · **Risk:** high · **Complexity:** high · **Depends on:** #0-12

AC1. The criteria stand alone.
`;
const BACKLOG = `# Backlog\n\n## Open\n\n${WITH_HEADING}\n${WITHOUT_HEADING}\n## Done\n\n### 0-1. Done\n`;

test('#0-301 (the owner\'s A): an item is read by its one heading, its one Complexity anywhere in a line, and at least '
  + 'one AC<n>. line, the heading of the criteria optional', () => {
  const texts = [{ path: 'BACKLOG.md', text: BACKLOG }, { path: '.ai/plan/queue.md', text: '# Queue\n' }];
  const low = parseItem('0-12', texts);
  assert.equal(low.complexity, 'low');
  assert.equal(low.file, 'BACKLOG.md');
  assert.ok(low.block.startsWith('### 0-12. ') && !low.block.includes('0-13'), 'the block ends at the next heading');
  assert.equal(parseItem('0-13', texts).complexity, 'high');
  const refused = (id, text, pattern) => assert.throws(() => parseItem(id, [{ path: 'BACKLOG.md', text }]),
    (error) => error instanceof ItemError && pattern.test(error.message) && !error.message.includes('agent-words'));
  refused('0-99', BACKLOG, /^the item 0-99 is in no queue file of the adapter's$/);
  refused('0-12', `${WITH_HEADING}\n${WITH_HEADING}`, /^the item 0-12 has 2 headings in the queue files, not one$/);
  refused('0-12', WITH_HEADING.replace(' · **Complexity:** low', ''), /has no single Complexity of low, medium or high$/);
  refused('0-12', WITH_HEADING.replace('**Complexity:** low', '**Complexity:** agent-words'), /no single Complexity/);
  refused('0-12', WITH_HEADING.replace('**Complexity:** low', '**Complexity:** lowest'), /no single Complexity/);
  refused('0-12', `${WITH_HEADING}**Complexity:** high\n`, /no single Complexity/);
  refused('0-12', WITH_HEADING.replace(/AC[12]\. /g, ' - '), /has no acceptance criteria \(no line AC<n>\.\)$/);
  refused('0-12', WITH_HEADING.replace('AC1. It works.\nAC2. It is tested.', 'See AC1. elsewhere.'),
    /has no acceptance criteria/);
  assert.throws(() => parseItem('0-1', [{ path: 'BACKLOG.md', text: '### 0-1.\n' }]), /in no queue file/);
});

test('#0-301 (B): the findings are the owner\'s file, 600, JSON of findings.schema.json, ids of review and of verify, '
  + 'each once; an answer names each exactly once', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const path = join(state.dir, 'findings.json');
  const write = async (value, mode = 0o600) => {
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    await chmod(path, mode);
  };
  const finding = (id) => ({ id, severity: 'blocking', file: 'src/a.java', text: 'agent-words of the review' });
  await write({ findings: [finding('sec-7f3a'), finding('ver-0123abcd')] });
  const found = await readFindings(path);
  assert.deepEqual(found.map((f) => f.id), ['sec-7f3a', 'ver-0123abcd']);
  for (const [value, pattern] of [
    [{ findings: [finding('sec-7f3')] }, /findings\.schema\.json's form/],
    [{ findings: [finding('ver-0123abc')] }, /findings\.schema\.json's form/],
    [{ findings: [finding('SEC-7f3a')] }, /findings\.schema\.json's form/],
    [{ findings: [] }, /findings\.schema\.json's form/],
    [{ findings: [{ ...finding('sec-7f3a'), severity: 'minor' }] }, /form/],
    [{ findings: [finding('sec-7f3a')], extra: 1 }, /form/],
    [{ findings: [finding('sec-7f3a'), finding('sec-7f3a')] }, /name an id twice$/],
    ['not json', /are not JSON$/],
  ]) {
    await write(value);
    await assert.rejects(readFindings(path), (error) => error instanceof FindingsError && pattern.test(error.message));
  }
  await write({ findings: [finding('sec-7f3a')] }, 0o644);
  await assert.rejects(readFindings(path), /has mode 644/);
  const ids = [finding('sec-7f3a'), finding('ver-0123abcd')];
  assert.equal(coverageProblem(ids, { fixed: ['sec-7f3a'], disputed: [{ id: 'ver-0123abcd', reason: 'x' }] }), null);
  assert.match(coverageProblem(ids, { fixed: ['sec-7f3a'], disputed: [] }), /names 1 finding\(s\) in neither/);
  assert.match(coverageProblem(ids, { fixed: ['sec-7f3a', 'ver-0123abcd', 'gen-0000'], disputed: [] }),
    /1 id\(s\) it was not given/);
  assert.match(coverageProblem(ids, { fixed: ['sec-7f3a', 'ver-0123abcd'], disputed: [{ id: 'sec-7f3a', reason: 'x' }] }),
    /and 1 twice$/);
});

/** The JSON of an agent definition's "## Answer (JSON)". */
async function definitionExample(agent) {
  const text = await readFile(new URL(`agents/${agent}.md`, ROOT), 'utf8');
  const match = /## Answer \(JSON\)[\s\S]*?```json\n([\s\S]*?)\n```/.exec(text);
  assert.ok(match, `agents/${agent}.md has its answer's example`);
  return JSON.parse(match[1]);
}

test('#0-301 AC5: each agent\'s answer is held to its schema of schemas/answers/, the one --json-schema is given; the '
  + 'example of its definition keeps it, and an answer off it does not', async () => {
  for (const agent of AGENTS) {
    const { schema, text, path } = await readAnswerSchema(agent);
    assert.equal(path, `schemas/answers/${ANSWER_SCHEMAS[agent]}.schema.json`);
    assert.equal(text, JSON.stringify(JSON.parse(await readFile(new URL(path, ROOT), 'utf8'))), '--json-schema\'s bytes');
    const example = await definitionExample(agent);
    assert.deepEqual(answerErrors(schema, example), [], `${agent}'s example`);
    for (const key of Object.keys(example)) {
      const { [key]: dropped, ...missing } = example;
      assert.ok(dropped !== undefined || key);
      assert.notDeepEqual(answerErrors(schema, missing), [], `${agent} without ${key}`);
    }
    assert.notDeepEqual(answerErrors(schema, { ...example, extra: 1 }), [], `${agent} with a field more`);
    assert.notDeepEqual(answerErrors(schema, { ...example, blocked: 'no' }), [], `${agent}'s blocked a boolean`);
    assert.notDeepEqual(answerErrors(schema, { ...example, commitMessage: 'x'.repeat(8001) }), [],
      `${agent}'s commitMessage bounded`);
  }
});

test('#0-301 AC6: the expected version is one file of the factory\'s, MAJOR.MINOR.PATCH, with the builtin plugins and '
  + 'each agent\'s tools, its frontmatter\'s', async () => {
  const expectations = await readExpectations();
  assert.match(expectations.claudeCodeVersion, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/);
  assert.equal(expectations.claudeCodeVersion, '2.1.328', 'ADR-0065\'s pin');
  assert.deepEqual(expectations.builtinPlugins, ['cc-plugin-sec-default', 'cc-plugin-agents-md', 'cc-plugin-telemetry',
    'cc-plugin-privacy', 'cc-plugin-plugin-authoring'], 'the owner\'s measurement of 2026-11-22');
  for (const name of AGENTS) {
    assert.deepEqual([...expectations.agents[name].tools].sort(), [...(await readAgent(name)).tools].sort(), name);
  }
});

test('#0-301 (D): the managed settings are exactly the ADR\'s keys, strictPluginOnlyCustomization true, the agents\' '
  + 'tools allowed, and never allowManagedHooksOnly nor disableSideloadFlags', async () => {
  const settings = JSON.parse(await readFile(new URL('claude-code/etc/managed-settings.json', ROOT), 'utf8'));
  assert.deepEqual(Object.keys(settings).sort(), ['allowManagedPermissionRulesOnly', 'disableAllHooks', 'permissions',
    'strictKnownMarketplaces', 'strictPluginOnlyCustomization'].sort());
  assert.equal(settings.allowManagedPermissionRulesOnly, true);
  assert.equal(settings.strictPluginOnlyCustomization, true, 'a boolean: 2.1.328 takes an object as invalid');
  assert.deepEqual(settings.strictKnownMarketplaces, []);
  assert.equal(settings.disableAllHooks, false);
  assert.deepEqual(Object.keys(settings.permissions), ['allow']);
  const tools = new Set();
  for (const name of AGENTS) {
    (await readAgent(name)).tools.forEach((tool) => tools.add(tool));
  }
  assert.deepEqual([...settings.permissions.allow].sort(), [...tools].sort());
  assert.ok(!('allowManagedHooksOnly' in settings) && !('disableSideloadFlags' in settings));
});

test('#0-301 (I): the recorded streams carry the keys 2.1.328 wrote, and the made init event keeps every rule',
  async () => {
    const expectations = await readExpectations();
    for (const name of AGENTS) {
      assert.deepEqual(Object.keys(initEvent(name)), [...INIT_KEYS]);
      assert.deepEqual(initViolations(initEvent(name), { agent: await readAgent(name), expectations }), [], name);
    }
    assert.deepEqual(Object.keys(resultEvent({})), [...RESULT_KEYS]);
    assert.ok(Object.keys(INIT_CHECKS).every((field) => INIT_KEYS.includes(field) || field === 'plugin_errors'));
  });

test('#0-301 AC3: a call past MAX_AGENT_CALLS, and a review round past MAX_ROUNDS, stop the run before any call, '
  + 'with their reasons and stages, counted in the breaker', async (t) => {
  assert.deepEqual([MAX_TEST_FIXES, MAX_ROUNDS, MAX_AGENT_CALLS], [2, 3, 45]);
  const state = await makeStateDir();
  t.after(state.remove);
  // No container, no queue: each limit is checked before the phase reads anything or calls anyone.
  const context = { stateDir: state.dir, repoDir: '/nonexistent', adapter: { queue: { files: [] } }, container: null,
    carried: null, expectations: null };
  const findings = [{ id: 'sec-7f3a', severity: 'blocking', file: 'a', text: 't' }];
  const calls = Array.from({ length: MAX_AGENT_CALLS }, (_, i) => ({ n: i + 1, agent: 'implementer',
    mode: 'fix-tests', outcome: 'answered' }));
  const cases = [
    [{ round: MAX_ROUNDS }, findings, 'fix-review: 3 review rounds reached (MAX_ROUNDS)'],
    [{ calls }, findings, 'fix-review: 45 agent calls reached (MAX_AGENT_CALLS)'],
    [{ calls }, null, 'plan: 45 agent calls reached (MAX_AGENT_CALLS)'],
  ];
  for (const [i, [changes, given, reason]] of cases.entries()) {
    const task = await updateTask(state.dir, await createTask(state.dir, { runId: `20261122T13000${i}Z-0d0301`,
      item: '0-1' }), changes);
    const left = await runPhases(state.dir, task, buildPhases({ ...context, findings: given }));
    assert.equal(left.status, 'blocked');
    assert.equal(left.reason, reason);
    assert.equal((await loadTask(state.dir, task.runId)).calls.length, changes.calls?.length ?? 0, 'no call made');
  }
  const { state: breaker } = await openBreaker(state.dir);
  assert.equal(breaker.consecutiveBlocked, cases.length, 'each stop counted');
  assert.deepEqual(breaker.history.map((h) => h.stage), ['fix-review', 'fix-review', 'plan']);
});

test('#0-301 AC6: expectations whose tools are not an agent\'s frontmatter\'s, or off their form, refuse the run',
  async (t) => {
    const { ExpectationsError } = await import('../src/flow/expectations.mjs');
    const state = await makeStateDir();
    t.after(state.remove);
    const { cp, mkdir } = await import('node:fs/promises');
    const root = new URL(`file://${state.dir}/`);
    await cp(new URL('agents/', ROOT), new URL('agents/', root), { recursive: true });
    await mkdir(new URL('claude-code/', root));
    const good = JSON.parse(await readFile(new URL('claude-code/expectations.json', ROOT), 'utf8'));
    const write = (value) => writeFile(new URL('claude-code/expectations.json', root),
      typeof value === 'string' ? value : JSON.stringify(value));
    await write(good);
    assert.equal((await readExpectations({ root })).claudeCodeVersion, good.claudeCodeVersion);
    for (const [value, pattern] of [
      [{ ...good, agents: { ...good.agents, architect: { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit'] } } },
        /tools of architect are not its frontmatter's$/],
      [{ ...good, claudeCodeVersion: 'v2.1.328' }, /not the expectations' form/],
      [{ ...good, extra: 1 }, /not the expectations' form/],
      ['{', /cannot be read as JSON/],
    ]) {
      await write(value);
      await assert.rejects(readExpectations({ root }), (error) => error instanceof ExpectationsError
        && pattern.test(error.message));
    }
  });

test('#0-301 (review round 1 of factory#26, arc-5c1e and 9): git failing, a queue file the base lacks, and a queue of '
  + 'another kind each stop the item in its stage through stopItem', async (t) => {
  // On buildPhases itself, not through main() (the owner accepted it, review of factory#26 after round 1): main()
  // never gets here with a queue file the base lacks, since the adapter's check (adapter-from-base.mjs) refuses the run
  // before any phase, and a git that fails would fail main()'s own reads of the base first.
  const state = await makeStateDir();
  t.after(state.remove);
  const { execFileSync } = await import('node:child_process');
  // A bare clone of one commit, as FACTORY_REPO_DIR is.
  const work = join(state.dir, 'work');
  const repoDir = join(state.dir, 'repo.git');
  const run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  run(['init', '-q', '-b', 'main', work]);
  await writeFile(join(work, 'README.md'), '# r\n');
  run(['-C', work, 'add', '.']);
  run(['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x']);
  run(['clone', '-q', '--bare', work, repoDir]);
  const head = run(['-C', repoDir, 'rev-parse', 'HEAD']);
  const failing = join(state.dir, 'git');
  // base-tree.mjs names git's first lines of stderr, as before #0-301: git's, of the dispatcher's own clone.
  await writeFile(failing, '#!/bin/sh\nexit 128\n', { mode: 0o700 });
  const kind = { kind: 'backlog-md', files: ['README.md'] };
  const cases = [
    [{ queue: kind }, failing, /^item: git ls-tree of the base failed \(exit 128\)/],
    [{ queue: { ...kind, files: ['no-such-queue.md'] } }, undefined, /^item: .*no-such-queue\.md/],
    [{ queue: { ...kind, kind: 'linear' } }, undefined,
      /^item: the adapter's queue is not of the kind backlog-md, the one the dispatcher reads$/],
  ];
  for (const [i, [adapter, git, reason]] of cases.entries()) {
    const task = await createTask(state.dir, { runId: `20261122T14000${i}Z-0e0301`, item: '0-1', baseSha: head });
    const left = await runPhases(state.dir, task, buildPhases({ stateDir: state.dir, repoDir,
      adapter, container: null, carried: null, expectations: null, git }));
    assert.equal(left.status, 'blocked', `case ${i}`);
    assert.match(left.reason, reason);
  }
  const { state: breaker } = await openBreaker(state.dir);
  assert.deepEqual(breaker.history.map((h) => h.stage), ['item', 'item', 'item']);
});

test('#0-301 (review round 1 of factory#26, 8): the agents of task.schema.json, CALL_LIMIT_S and ANSWER_SCHEMAS are '
  + 'agents.mjs\'s AGENTS', async () => {
  const { CALL_LIMIT_S } = await import('../src/flow/call.mjs');
  const task = JSON.parse(await readFile(new URL('dispatcher/src/state/task.schema.json', ROOT), 'utf8'));
  const sorted = (list) => [...list].sort();
  assert.deepEqual(sorted(task.properties.calls.items.properties.agent.enum), sorted(AGENTS));
  assert.deepEqual(sorted(Object.keys(CALL_LIMIT_S)), sorted(AGENTS));
  assert.deepEqual(sorted(Object.keys(ANSWER_SCHEMAS)), sorted(AGENTS));
});

test('#0-301 (review round 1 of factory#26, 4): an answer\'s commitMessage is a subject of one line of at most 100, '
  + 'a blank line and a body, printable, with no line of the dispatcher\'s trailers', async () => {
  for (const agent of ['architect', 'implementer']) {
    const { schema } = await readAnswerSchema(agent);
    const { ARCHITECT_ANSWER, IMPLEMENTER_ANSWER } = await import('../testing/stream-json.mjs');
    const example = agent === 'architect' ? ARCHITECT_ANSWER : IMPLEMENTER_ANSWER;
    const ok = (value) => answerErrors(schema, { ...example, commitMessage: value }).length === 0;
    assert.ok(schema.properties.commitMessage, agent);
    for (const value of [null, 'feat(x): a thing', 'feat(x): a thing\n\nWhy, and how.\nMore.', 'x'.repeat(100),
      'fix: y\n\nThe Task: in a sentence is fine', `fix: y\n\n${'b'.repeat(7000)}`]) {
      assert.ok(ok(value), `${agent}: ${JSON.stringify(value).slice(0, 40)}`);
    }
    for (const value of ['', 'x'.repeat(101), 'a\nb', 'a\n\nb\tc', 'a\r\n\r\nb', 'a\n\nb\u0007', 'Task: x',
      'a\n\nFactory-Run-Id: 1', 'a\n\nbody\nFeature: y', 'a\n\nTask: 0-1', `a\n\n${'b'.repeat(8000)}`,
      // A body of blank lines alone (review of factory#26 after round 1, 5).
      'a\n\n', 'a\n\n\n\n', 'a\n\n  \n ']) {
      assert.ok(!ok(value), `${agent}: ${JSON.stringify(value).slice(0, 40)}`);
    }
  }
});

test('#0-301 (review round 1 of factory#26, arc-5c1e): GitHub out of reach in a phase blocks the task through '
  + 'stopItem, counted in the breaker with its stage', async (t) => {
  const { GitHubUnavailableError } = await import('../src/github/retry.mjs');
  const state = await makeStateDir();
  t.after(state.remove);
  const task = await createTask(state.dir, { runId: '20261122T160000Z-100301', item: '0-1' });
  const left = await runPhases(state.dir, task, [{ name: 'ship', run: async () => {
    throw new GitHubUnavailableError('GitHub did not answer: ten transient failures in a row');
  } }]);
  assert.equal(left.status, 'blocked');
  assert.equal(left.reason, 'ship: GitHub did not answer: ten transient failures in a row');
  const { state: breaker } = await openBreaker(state.dir);
  assert.deepEqual(breaker.history.map((h) => h.stage), ['ship']);
  assert.equal(breaker.consecutiveBlocked, 1);
});
