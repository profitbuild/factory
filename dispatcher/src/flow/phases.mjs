/**
 * The build zone's phases (incident-platform backlog #0-301, migration step M2.3; ADR-0063 D3), from today's
 * autopilot's backlog-autopilot.js, run by state/tasks.mjs's runPhases, which writes the task after each:
 *   plan        the architect (mode plan);
 *   implement   the implementer, or implementer-light when the item's Complexity is low (mode implement);
 *   fix-review  instead of plan and implement, in a run given findings (`--findings`): the implementer (mode
 *               fix-review), its answer naming each finding's id exactly once; a new review round, at most MAX_ROUNDS;
 *   path-gate   the adapter's changedPaths (product/commands.mjs): an exit other than 0 stops the task. What it prints
 *               is advisory, and no check of the dispatcher's rests on it (#0-278); the dispatcher's own check of the
 *               paths written is #0-302's;
 *   test-gate   the adapter's gate: pass with an artifact ends the phase; pass with none stops; stop stops; fixable
 *               calls the implementer in mode fix-tests, at most MAX_TEST_FIXES times, then stops with "tests still
 *               failing after 2 fix attempts".
 * Every stop is a StopError, which runPhases turns into stopItem: the task BLOCKED with its stage, and the breaker's
 * count. Every agent call is recorded in task.calls before it starts (a call killed counts too), and a call past
 * MAX_AGENT_CALLS stops the task. An agent's answer `blocked: true` stops it with a reason of the dispatcher's own,
 * naming the answer's file; the agent's words stay in that file. Not carried over (ADR-0063 D3): the bot's
 * preflight, the pick, the review rounds, verify, acceptance, ship. The agents make no commit (#0-302): an answer's
 * commitMessage is kept in its call's record, as agentText.
 */
import { BLOCKING } from '../container/environment.mjs';
import { GitHubUnavailableError } from '../github/retry.mjs';
import { CallError, callAgent } from './call.mjs';
import { coverageProblem } from './findings.mjs';
import { ItemError, readItem } from './item.mjs';
import { fixReviewPrompt, fixTestsPrompt, implementPrompt, planPrompt } from './prompts.mjs';
import { runProductCommand } from '../product/commands.mjs';
import { validate } from '../schema/validate.mjs';
import { StopError, updateTask } from '../state/tasks.mjs';
import GATE_SCHEMA from '../../../schemas/gate.schema.json' with { type: 'json' };

/** Today's autopilot's limits. */
export const MAX_TEST_FIXES = 2;
export const MAX_ROUNDS = 3;
export const MAX_AGENT_CALLS = 45;
/** The longest the adapter's commands may run, in seconds. */
export const PATH_GATE_LIMIT_S = 10 * 60;
export const TEST_GATE_LIMIT_S = 60 * 60;

const RUNNER = ['version', 'runId', 'phase'];
/** The fields a phase returns to runPhases: the task as the phase last wrote it, but what only the runner sets. */
const fieldsOf = (task) => Object.fromEntries(Object.entries(task).filter(([k]) => !RUNNER.includes(k)));

/**
 * The phases of a run.
 *
 * @param {{ stateDir: string, repoDir: string, adapter: object, container: object, carried: object,
 *   expectations: object, findings?: object[] | null, baseUrl: string, sudo?: string, git?: string }} context
 *   `findings` a fix-review run's (findings.mjs); `baseUrl` the run's proxy's, for every agent call (#0-313)
 * @returns {{ name: string, run: (task: object) => Promise<object> }[]}
 */
export function buildPhases({
  stateDir, repoDir, adapter, container, carried, expectations, findings = null, baseUrl, sudo, git,
}) {
  /**
   * Whether `error` stops the item (review round 1 of factory#26, arc-5c1e): a call's, the item's, or one of the task
   * container's blocking failures (environment.mjs's BLOCKING: the starter's, a stream past its limit, a stderr not
   * kept, a signal, sudo; git's and the base tree's), or GitHub out of reach. Anything else is a bug, and is thrown.
   */
  const stops = (error) => error instanceof CallError || error instanceof ItemError
    || error instanceof GitHubUnavailableError || BLOCKING.some((kind) => error instanceof kind);

  /** Runs `work`; an error that stops the item is a StopError in `stage`, with the task `task()` gives. */
  const guarded = async (stage, task, work) => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof StopError) && stops(error)) {
        throw new StopError(stage, error.message, task());
      }
      throw error;
    }
  };

  const item = (task) => guarded('item', () => task, () => readItem({ repoDir, base: task.baseSha, adapter,
    id: task.item, git }));

  /** MAX_AGENT_CALLS, checked before a phase reads anything for its call, and again by the call itself. */
  const callsLeft = (task, stage) => {
    if (task.calls.length >= MAX_AGENT_CALLS) {
      throw new StopError(stage, `${MAX_AGENT_CALLS} agent calls reached (MAX_AGENT_CALLS)`, task);
    }
  };

  /** One agent call, recorded before and after; its answer, or a StopError in `stage`. */
  const call = async (task, { stage, agentName, mode, prompt }) => {
    callsLeft(task, stage);
    const n = task.calls.length + 1;
    let current = await updateTask(stateDir, task, { calls: [...task.calls, { n, agent: agentName, mode,
      outcome: 'started' }] });
    const settle = (fields) => updateTask(stateDir, current, { calls: current.calls.map((c) => (c.n === n
      ? { ...c, ...fields } : c)) });
    try {
      const { answer, file, answerFile } = await callAgent({ container, task: current, n, agentName, prompt, carried,
        expectations, stateDir, baseUrl, sudo });
      current = await settle({ outcome: 'answered', file, answerFile,
        agentText: { commitMessage: answer.commitMessage } });
      if (answer.blocked === true) {
        throw new StopError(stage, `the ${agentName} answered blocked (its answer: ${answerFile})`, current);
      }
      return { task: current, answer };
    } catch (error) {
      if (!(error instanceof StopError) && stops(error)) {
        current = await settle({ outcome: 'failed' });
        throw new StopError(stage, error.message, current);
      }
      throw error;
    }
  };

  const implementer = (it) => (it.complexity === 'low' ? 'implementer-light' : 'implementer');

  const plan = { name: 'plan', run: async (task) => {
    callsLeft(task, 'plan');
    const it = await item(task);
    const { task: after } = await call(task, { stage: 'plan', agentName: 'architect', mode: 'plan',
      prompt: planPrompt(it) });
    return fieldsOf(after);
  } };

  const implement = { name: 'implement', run: async (task) => {
    callsLeft(task, 'implement');
    const it = await item(task);
    const { task: after } = await call(task, { stage: 'implement', agentName: implementer(it), mode: 'implement',
      prompt: implementPrompt(it) });
    return fieldsOf(after);
  } };

  const fixReview = { name: 'fix-review', run: async (task) => {
    if (task.round >= MAX_ROUNDS) {
      throw new StopError('fix-review', `${MAX_ROUNDS} review rounds reached (MAX_ROUNDS)`, task);
    }
    callsLeft(task, 'fix-review');
    const it = await item(task);
    const next = await updateTask(stateDir, task, { round: task.round + 1 });
    const { task: after, answer } = await call(next, { stage: 'fix-review', agentName: implementer(it),
      mode: 'fix-review', prompt: fixReviewPrompt(it, findings) });
    const problem = coverageProblem(findings, answer);
    if (problem) {
      throw new StopError('fix-review', problem, after);
    }
    return fieldsOf(after);
  } };

  const pathGate = { name: 'path-gate', run: async (task) => {
    const result = await guarded('path-gate', () => task, () => runProductCommand({ container, repoDir, task,
      which: 'changedPaths', limitS: PATH_GATE_LIMIT_S, sudo, git }));
    if (result.code !== 0) {
      throw new StopError('path-gate', `the adapter's changedPaths refused the task's changes (exit ${result.code})`,
        task);
    }
    return fieldsOf(task);
  } };

  const testGate = { name: 'test-gate', run: async (task) => {
    // MAX_TEST_FIXES counts this gate's fixes, not the task's (review round 1 of factory#26, gen-3c1f): a gate starts
    // at 0, so a fix-review run's gate may fix as a first run's could.
    let current = await updateTask(stateDir, task, { fixes: 0 });
    for (;;) {
      const result = await guarded('test-gate', () => current, () => runProductCommand({ container, repoDir,
        task: current, which: 'gate', limitS: TEST_GATE_LIMIT_S, sudo, git }));
      let gate;
      try {
        gate = JSON.parse(result.stdout.toString('utf8'));
      } catch {
        throw new StopError('test-gate', `the gate's answer is not JSON (exit ${result.code})`, current);
      }
      const errors = validate(GATE_SCHEMA, gate);
      if (errors.length > 0) {
        throw new StopError('test-gate', `the gate's answer is not gate.schema.json's (${errors.length} error(s))`,
          current);
      }
      if (gate.status === 'pass') {
        if (gate.artifact === null) {
          throw new StopError('test-gate', 'the gate passed with no artifact', current);
        }
        return fieldsOf(current);
      }
      if (gate.status === 'stop') {
        throw new StopError('test-gate', 'the gate stopped: the environment failed, a human looks', current);
      }
      const { fixes } = current;
      if (fixes >= MAX_TEST_FIXES) {
        throw new StopError('test-gate', `tests still failing after ${MAX_TEST_FIXES} fix attempts`, current);
      }
      callsLeft(current, 'fix-tests');
      const it = await item(current);
      current = await updateTask(stateDir, current, { fixes: fixes + 1 });
      ({ task: current } = await call(current, { stage: 'fix-tests', agentName: implementer(it), mode: 'fix-tests',
        prompt: fixTestsPrompt(it, gate, fixes + 1) }));
    }
  } };

  return findings === null ? [plan, implement, pathGate, testGate] : [fixReview, pathGate, testGate];
}
