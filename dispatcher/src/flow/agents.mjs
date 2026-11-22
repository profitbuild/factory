/**
 * The factory's build agents as the dispatcher calls them (incident-platform backlog #0-301, ADR-0064 point 2): read
 * from the factory checkout the dispatcher runs from, agents/<name>.md, the very tree a task container holds read-only
 * as /opt/factory (FACTORY_CHECKOUT), never from a product's clone. Their frontmatter is read by a closed parser:
 * exactly name, description, tools, model and maxTurns, one `key: value` line each, as dispatcher/test/plugin.test.mjs
 * holds them; any other form refuses the run. `tools` gives the call's --tools, `model` what its init event must
 * show, `maxTurns` its --max-turns: one source each, never a copy.
 */
import { readFile } from 'node:fs/promises';

/** The factory checkout's root, the dispatcher's own. */
export const FACTORY_ROOT = new URL('../../../', import.meta.url);

/** The agents the flow calls. */
export const AGENTS = Object.freeze(['architect', 'implementer', 'implementer-light']);

/** An agent's definition is not one the dispatcher can call. */
export class AgentDefinitionError extends Error {}

const KEYS = ['name', 'description', 'tools', 'model', 'maxTurns'];
const TOOL = /^[A-Z][A-Za-z]*$/;
const MODEL = /^claude-[a-z0-9-]+$/;

/**
 * The frontmatter of an agent's file, parsed: refused unless it is exactly the five keys, well formed.
 *
 * @param {string} name one of AGENTS
 * @param {string} text the file's
 * @returns {{ name: string, tools: string[], model: string, maxTurns: number }}
 */
export function parseAgent(name, text) {
  const refuse = (why) => { throw new AgentDefinitionError(`agents/${name}.md: ${why}`); };
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    refuse('no frontmatter between --- lines');
  }
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z]+): (\S.*)$/.exec(line);
    if (!field || !KEYS.includes(field[1]) || Object.hasOwn(fields, field[1])) {
      refuse('its frontmatter is not exactly name, description, tools, model and maxTurns, one line each');
    }
    fields[field[1]] = field[2];
  }
  if (Object.keys(fields).length !== KEYS.length || fields.name !== name) {
    refuse('its frontmatter is not exactly name, description, tools, model and maxTurns, its name the file\'s');
  }
  const tools = fields.tools.split(', ');
  if (tools.length === 0 || !tools.every((t) => TOOL.test(t)) || new Set(tools).size !== tools.length) {
    refuse('its tools are not a list of tool names, each once');
  }
  if (!MODEL.test(fields.model)) {
    refuse('its model is not a model\'s name');
  }
  if (!/^[1-9][0-9]{0,3}$/.test(fields.maxTurns)) {
    refuse('its maxTurns is not a positive integer');
  }
  return { name, tools, model: fields.model, maxTurns: Number(fields.maxTurns) };
}

/**
 * @param {string} name one of AGENTS
 * @param {{ root?: URL }} [options] for the tests only
 */
export async function readAgent(name, { root = FACTORY_ROOT } = {}) {
  if (!AGENTS.includes(name)) {
    throw new TypeError(`readAgent: ${name} is not one of ${AGENTS.join(', ')}`);
  }
  return parseAgent(name, await readFile(new URL(`agents/${name}.md`, root), 'utf8'));
}
