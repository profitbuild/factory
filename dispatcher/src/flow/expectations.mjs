/**
 * What an agent call must show on the pinned Claude Code (incident-platform backlog #0-301, ADR-0064 points 3 and 5,
 * ADR-0065): claude-code/expectations.json of the factory checkout, one file next to the managed settings
 * (claude-code/etc/managed-settings.json): the version, the builtin plugins measured on it, and each agent's tools.
 * Read and checked whole before any call: a file that is missing, not JSON, or off its form refuses the run. Each
 * agent's tools must be the ones its frontmatter gives (agents.mjs), as sets: --tools is built from the frontmatter,
 * the init event compared with this file, and the two may not drift.
 */
import { readFile } from 'node:fs/promises';

import { validate } from '../schema/validate.mjs';
import { AGENTS, FACTORY_ROOT, readAgent } from './agents.mjs';

/** The expectations are not what a call can be checked against. */
export class ExpectationsError extends Error {}

const SCHEMA = {
  type: 'object',
  required: ['claudeCodeVersion', 'builtinPlugins', 'builtinAgents', 'agents'],
  additionalProperties: false,
  properties: {
    $comment: { type: 'string' },
    claudeCodeVersion: { type: 'string', pattern: '^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$' },
    builtinPlugins: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9-]+$' }, uniqueItems: true },
    builtinAgents: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9-]*$' }, uniqueItems: true },
    agents: {
      type: 'object',
      required: AGENTS,
      additionalProperties: false,
      properties: Object.fromEntries(AGENTS.map((name) => [name, {
        type: 'object', required: ['tools'], additionalProperties: false,
        properties: { tools: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string',
          pattern: '^[A-Z][A-Za-z]*$' } } },
      }])),
    },
  },
};

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * @param {{ root?: URL }} [options] for the tests only
 * @returns {Promise<{ claudeCodeVersion: string, builtinPlugins: string[], builtinAgents: string[],
 *   agents: Record<string, { tools: string[] }> }>}
 */
export async function readExpectations({ root = FACTORY_ROOT } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(new URL('claude-code/expectations.json', root), 'utf8'));
  } catch (error) {
    throw new ExpectationsError(`claude-code/expectations.json cannot be read as JSON (${error.code ?? error.name})`);
  }
  const errors = validate(SCHEMA, parsed);
  if (errors.length > 0) {
    throw new ExpectationsError(`claude-code/expectations.json is not the expectations' form: ${errors.join('; ')}`);
  }
  for (const name of AGENTS) {
    const agent = await readAgent(name, { root });
    if (!sameSet(agent.tools, parsed.agents[name].tools)) {
      throw new ExpectationsError(`claude-code/expectations.json's tools of ${name} are not its frontmatter's`);
    }
  }
  return parsed;
}
