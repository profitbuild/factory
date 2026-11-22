/**
 * One call of a factory agent in the task container (incident-platform backlog #0-301, ADR-0064 points 1 to 5):
 *
 *   docker exec <the container's checked ID> /usr/bin/timeout ... /usr/bin/env -i <callEnv> /usr/local/bin/claude -p
 *     --plugin-dir /opt/factory --agent factory:<agent> --restricted --tools <the frontmatter's> --add-dir /workspace
 *     --output-format stream-json --verbose --json-schema <schemas/answers/<agent>.schema.json>
 *     --permission-mode dontAsk --max-turns <the frontmatter's>
 *
 * from /workspace (execInTask's -w), the container by its ID alone (execInTask), every program by its full path
 * (ADR-0065: /usr/local/bin/claude), the prompt on stdin (--tools takes several values, and would take a prompt after
 * it). Its stream goes to tasks/<runId>/calls/<n>-<agent>.jsonl as it comes (run-container.mjs's stdoutFile), and is
 * read back (stream.mjs). The init event is checked whole (INIT_CHECKS) before the answer is read; any difference
 * stops the task. The answer is the result's structured_output, held to the same schema --json-schema was given; it
 * is written to calls/<n>-<agent>.answer.json (600), the agent's words kept there and nowhere the dispatcher decides.
 *
 * The credential (incident-platform backlog #0-313, M2.7; ADR-0064 point 5 as amended): no Claude key in the
 * container, only the task's token for the dispatcher's proxy (proxy/), printed by the managed settings' apiKeyHelper
 * from the token's file (container/task-config.mjs mounts its directory read-only on /run/factory). callEnv gives the
 * proxy's address as ANTHROPIC_BASE_URL, a literal (no secret), and INIT_CHECKS holds apiKeySource to "apiKeyHelper".
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { FACTORY_MOUNT, WORKSPACE } from '../container/paths.mjs';
import { CallTimeoutError, execInTask } from '../container/task-container.mjs';
import { ensureOwnDirectory } from '../state/files.mjs';
import { answerErrors, readAnswerSchema } from './answers.mjs';
import { AGENTS, readAgent } from './agents.mjs';
import { StreamError, readStream } from './stream.mjs';

/** Claude Code in the task image, by its full path (ADR-0065). */
export const CLAUDE = '/usr/local/bin/claude';
/** The longest a call's stream may be: a long run's. */
export const STREAM_LIMIT = 64 * 1024 * 1024;
/** The longest each agent's call may run, in seconds. */
export const CALL_LIMIT_S = Object.freeze({ architect: 30 * 60, implementer: 90 * 60, 'implementer-light': 60 * 60 });
/** The system directories of PATH: no user's directory (no ~/.local/bin). */
export const CALL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The proxy's address as the container reaches it (#0-313): http, an IPv4 literal and a port, nothing else. */
export const BASE_URL = /^http:\/\/(?:[0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}$/;

/** A call did not end in an answer the dispatcher takes: the task stops, with the reason. */
export class CallError extends Error {}

/**
 * The environment of `env -i` (ADR-0064 point 5): literals the dispatcher writes, and the containerEnv the task's
 * configuration carried (task-config.mjs held its keys to the list and its values to literals). No secret: env's
 * arguments are in /proc.
 *
 * @param {{ remoteUser: string, containerEnv: Record<string, string> }} carried
 * @param {{ baseUrl: string }} proxy the run's proxy's address (#0-313: proxy/server.mjs's baseUrl)
 * @returns {string[]} NAME=value, in order
 */
export function callEnv(carried, { baseUrl }) {
  if (typeof baseUrl !== 'string' || !BASE_URL.test(baseUrl)) {
    throw new TypeError('callEnv: baseUrl must be the proxy\'s http://<IPv4>:<port>');
  }
  return [
    `HOME=/home/${carried.remoteUser}`,
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    `PATH=${CALL_PATH}`,
    ...Object.entries(carried.containerEnv ?? {}).map(([name, value]) => `${name}=${value}`),
    'DISABLE_AUTOUPDATER=1',
    'DISABLE_UPDATES=1',
    // Claude Code's traffic other than the model's calls (the telemetry among its builtin plugins, the remote
    // settings) would go to Anthropic past #0-313's proxy: ADR-0064 point 5 as amended on 2026-11-22 (incident-platform
    // PR #697; review of factory#26, gen-5d20, sec-4e1d).
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1',
    // Where the model's calls go (#0-313): the run's proxy, which swaps the task's token for the key.
    `ANTHROPIC_BASE_URL=${baseUrl}`,
  ];
}

/**
 * The command after execInTask's /usr/bin/timeout: env -i, then claude with F3's flags.
 *
 * @param {{ agent: { name: string, tools: string[], maxTurns: number }, schemaText: string,
 *   carried: object, baseUrl: string }} options
 */
export function callArgs({ agent, schemaText, carried, baseUrl }) {
  return ['/usr/bin/env', '-i', ...callEnv(carried, { baseUrl }), CLAUDE, '-p', '--plugin-dir', FACTORY_MOUNT,
    '--agent', `factory:${agent.name}`, '--restricted', '--tools', agent.tools.join(','), '--add-dir', WORKSPACE,
    '--output-format', 'stream-json', '--verbose', '--json-schema', schemaText, '--permission-mode', 'dontAsk',
    '--max-turns', String(agent.maxTurns)];
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length
  && a.every((x) => b.includes(x));

/**
 * Each field of the init event and its rule (ADR-0064 point 3, as the owner amended it for #0-301): true when the
 * field keeps it. A field of the event not here is not read; one here that is missing breaks its rule.
 */
export const INIT_CHECKS = Object.freeze({
  // factory:<agent> there, and every other one either a factory agent or a builtin of expectations.json's closed list
  // (review round 1 of factory#26, 6).
  agents: (v, { agent, expectations }) => Array.isArray(v) && v.includes(`factory:${agent.name}`)
    && v.every((a) => AGENTS.some((name) => a === `factory:${name}`) || expectations.builtinAgents.includes(a)),
  plugins: (v, { expectations }) => Array.isArray(v) && v.every(isObject)
    && v.filter((p) => p.path !== 'builtin').length === 1
    && v.some((p) => p.name === 'factory' && p.path === FACTORY_MOUNT && p.source === 'factory@inline')
    && sameSet(v.filter((p) => p.path === 'builtin').map((p) => p.name), expectations.builtinPlugins)
    && v.filter((p) => p.path === 'builtin').every((p) => p.source === `${p.name}@builtin`),
  plugin_errors: (v) => v === undefined || (Array.isArray(v) && v.length === 0),
  tools: (v, { agent, expectations }) => sameSet(v, expectations.agents[agent.name].tools),
  model: (v, { agent }) => v === agent.model,
  permissionMode: (v) => v === 'dontAsk',
  claude_code_version: (v, { expectations }) => v === expectations.claudeCodeVersion,
  mcp_servers: (v) => Array.isArray(v) && v.length === 0,
  // The credential came from the managed apiKeyHelper (#0-313, ADR-0064 point 3 as amended): measured "none" without
  // one and with ANTHROPIC_AUTH_TOKEN in the environment, so a call that got its credential any other way stops.
  apiKeySource: (v) => v === 'apiKeyHelper',
});

/** The fields of `init` that break INIT_CHECKS, by name. */
export function initViolations(init, context) {
  return Object.entries(INIT_CHECKS).filter(([field, rule]) => !rule(init?.[field], context)).map(([field]) => field);
}

/**
 * One call, read to its answer, or a CallError (CallTimeoutError past its limit).
 *
 * @param {{ container: object, task: object, n: number, agentName: string, prompt: string, carried: object,
 *   expectations: object, stateDir: string, baseUrl: string, sudo?: string }} options `n` the call's number in
 *   the task; `baseUrl` the run's proxy's (#0-313)
 * @returns {Promise<{ answer: object, file: string, answerFile: string }>}
 */
export async function callAgent({
  container, task, n, agentName, prompt, carried, expectations, stateDir, baseUrl, sudo,
}) {
  const agent = await readAgent(agentName);
  const { schema, text: schemaText } = await readAnswerSchema(agentName);
  const dir = join(stateDir, 'tasks', task.runId, 'calls');
  await ensureOwnDirectory(dir);
  const file = join(dir, `${n}-${agentName}.jsonl`);
  const result = await execInTask({ container, sudo, limitS: CALL_LIMIT_S[agentName], graceS: 30,
    input: prompt, outputLimit: STREAM_LIMIT, stdoutFile: file,
    args: callArgs({ agent, schemaText, carried, baseUrl }) });
  let stream;
  try {
    stream = await readStream(file);
  } catch (error) {
    if (error instanceof StreamError) {
      throw new CallError(`${error.message} (exit ${result.code}; ${file})`);
    }
    throw error;
  }
  const violations = initViolations(stream.init, { agent, expectations });
  if (violations.length > 0) {
    throw new CallError(`the call's init event is not the one expected: ${violations.join(', ')} (${file})`);
  }
  // An exit other than 0 is a stop, whatever the result says (review round 1 of factory#26, 7).
  if (result.code !== 0) {
    throw new CallError(`the call exited ${result.code} (${file})`);
  }
  const { result: end } = stream;
  if (end.subtype !== 'success' || end.is_error !== false) {
    const subtype = ['success', 'error_max_turns', 'error_during_execution', 'error_max_structured_output_retries']
      .includes(end.subtype) ? end.subtype : 'unknown';
    throw new CallError(`the call ended without an answer (result ${subtype}; ${file})`);
  }
  if (!Object.hasOwn(end, 'structured_output')) {
    throw new CallError(`the call's result holds no structured_output (${file})`);
  }
  const errors = answerErrors(schema, end.structured_output);
  if (errors.length > 0) {
    // By count: a pointer can hold a key the agent chose (an additional property), the agent's side's words.
    throw new CallError(`the call's answer is not its schema's (${errors.length} error${errors.length === 1 ? '' : 's'}; `
      + `${file})`);
  }
  const answerFile = join(dir, `${n}-${agentName}.answer.json`);
  const handle = await open(answerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(end.structured_output, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  return { answer: end.structured_output, file, answerFile };
}

export { CallTimeoutError };
