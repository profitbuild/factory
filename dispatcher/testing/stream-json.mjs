// Not a test file. Agent calls' stream-json for the tests (incident-platform backlog #0-301, point I): no test may call
// Claude Code, so the streams are made here, in the form Claude Code 2.1.328 writes them, as the spike of #0-300
// (rounds A to D, dispatcher/testing/spike-0-300.mjs) and the owner's measurement of 2026-11-22 (F3, managed
// settings, apiKeyHelper) saw it: the first line the system event of subtype init, with the fields INIT_KEYS, the
// last the result. What no measurement has seen yet is the result's structured_output, the field --json-schema adds:
// it is written here as the documented form gives it, and AC4's first real call on the VM records the stream that
// replaces this one (test/stream-json-fixture.test.mjs holds the keys to INIT_KEYS and RESULT_KEYS).
import { readFileSync } from 'node:fs';

const EXPECTATIONS = JSON.parse(readFileSync(new URL('../../claude-code/expectations.json', import.meta.url), 'utf8'));
const MODELS = { architect: 'claude-opus-5-5', implementer: 'claude-opus-5-5',
  'implementer-light': 'claude-sonnet-5-5' };

/** The init event's keys, as 2.1.328 wrote them in the measurements. */
export const INIT_KEYS = Object.freeze(['type', 'subtype', 'cwd', 'session_id', 'tools', 'mcp_servers', 'model',
  'permissionMode', 'slash_commands', 'apiKeySource', 'claude_code_version', 'output_style', 'agents', 'skills',
  'plugins']);
/** The result event's keys, with structured_output (--json-schema's). */
export const RESULT_KEYS = Object.freeze(['type', 'subtype', 'is_error', 'duration_ms', 'num_turns', 'result',
  'session_id', 'structured_output']);

/** The init event of a call of `agent` on F3, as the pinned Claude Code writes it, with `changes` over it. */
export function initEvent(agent, changes = {}) {
  return {
    type: 'system', subtype: 'init', cwd: '/workspace', session_id: '00000000-0000-4000-8000-000000000301',
    tools: [...EXPECTATIONS.agents[agent].tools], mcp_servers: [], model: MODELS[agent], permissionMode: 'dontAsk',
    slash_commands: ['compact', 'context'], apiKeySource: 'none', claude_code_version: EXPECTATIONS.claudeCodeVersion,
    output_style: 'default',
    agents: ['claude', 'Explore', 'factory:architect', 'factory:implementer', 'factory:implementer-light',
      'general-purpose', 'Plan', 'statusline-setup'],
    skills: ['code-review'],
    plugins: [{ name: 'factory', path: '/opt/factory', source: 'factory@inline' },
      ...EXPECTATIONS.builtinPlugins.map((name) => ({ name, path: 'builtin', source: `${name}@builtin` }))],
    ...changes,
  };
}

/** The result of a call that answered `answer`, with `changes` over it. */
export function resultEvent(answer, changes = {}) {
  return { type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, num_turns: 3, result: 'done',
    session_id: '00000000-0000-4000-8000-000000000301', structured_output: answer, ...changes };
}

/** A whole call's stream: init, an assistant's turn and the tool's answer, the result. */
export function stream(agent, answer, { init = {}, result = {} } = {}) {
  return [
    initEvent(agent, init),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    resultEvent(answer, result),
  ];
}

/** Answers that keep each agent's schema. */
export const ARCHITECT_ANSWER = Object.freeze({ blocked: false, reason: null,
  plan: { summary: 's', precedent: 'p', steps: ['a'], files: ['f'], tests: ['t'],
    acceptanceMapping: [{ ac: 'AC1', test: 't' }] },
  adrs: [], risks: [], areas: { security: false, migration: false, k8sOrBuild: false, docs: false }, modules: [],
  rules: [], commitMessage: 'docs(x): plan 0-1\n\nThe plan.' });
export const IMPLEMENTER_ANSWER = Object.freeze({ blocked: false, reason: null, summary: 'done',
  commitMessage: 'feat(x): the item\n\nWhat changed.', fixed: [], disputed: [], noticedNotTouched: [], followUps: [] });
