// PreToolUse (Bash) of the factory's plugin, through hooks/hooks.json: refuses a command run in the background
// (`run_in_background: true`) in a session of any of the plugin's agents. An agent's turns are its budget (`maxTurns`);
// a command in the background returns at once, and the agent then spends a turn on every look at its output, so a run
// can spend them all and end without an answer (incident-platform backlog #0-206). The factory's own gate runs the
// full set of tests after the agent anyway.
//
// In hooks.json and not in an agent's frontmatter: Claude Code ignores a plugin agent's frontmatter `hooks:`
// (incident-platform ADR-0060 D5 as amended, backlog #0-299). One session runs one agent, so the hook holds for it alone.
//
// Fails closed: Claude Code runs the call after any exit status but 2, so every way out but a call this script has read
// and found in the foreground is exit 2: bad JSON, a missing field, a value other than false, an exception, an input
// that does not end. hooks.json's `onFailure: "block"` covers a `node` that does not start. A refusal says what to do
// instead and quotes nothing of the input, which is the agent's. It runs whenever it is loaded (no check that it is the
// main module, which a symlinked path would fail, letting every call run); its tests run it as Claude Code does.
import { setTimeout as delay } from 'node:timers/promises';

const NAME = 'foreground-bash';
/** The longest the hook waits for its input; Claude Code writes it at once. */
const INPUT_TIMEOUT_MS = 10_000;
/** Bigger is not a tool call's input. */
const MAX_INPUT = 1024 * 1024;

const BACKGROUND_REFUSAL = 'run the command in the foreground (no run_in_background): it returns when it ends, '
  + 'with its output, so there is nothing to poll, and every look at a background command\'s output spends one of '
  + 'your turns. For a long test run, give the Bash call a timeout and narrow the run to the module and the tests you '
  + 'changed; the factory\'s own gate runs the full set after you.';

function refuse(reason) {
  process.stderr.write(`BLOCKED by ${NAME}: ${reason}\n`);
  process.exit(2);
}

/**
 * The decision for one hook input, already parsed: null lets the call run, a string is the refusal.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
function decide(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'the hook\'s input is not a JSON object, so the call is refused';
  }
  if (input.tool_name !== 'Bash') {
    return 'this hook guards the Bash tool only and was given another, so the call is refused';
  }
  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return 'the hook\'s input has no tool_input object, so the call is refused';
  }
  if (toolInput.run_in_background === undefined || toolInput.run_in_background === false) {
    return null;
  }
  return BACKGROUND_REFUSAL;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) {
      refuse('the hook\'s input is too large, so the call is refused');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const timer = new AbortController();
  delay(INPUT_TIMEOUT_MS, undefined, { signal: timer.signal })
    .then(() => refuse('the hook\'s input did not end in time, so the call is refused'), () => {});
  const text = await readInput();
  timer.abort();
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    refuse('the hook\'s input is not JSON, so the call is refused');
  }
  const refusal = decide(input);
  if (refusal !== null) {
    refuse(refusal);
  }
  process.exit(0);
}

process.on('uncaughtException', () => refuse('the guard failed, so the call is refused'));
process.on('unhandledRejection', () => refuse('the guard failed, so the call is refused'));
await main();
