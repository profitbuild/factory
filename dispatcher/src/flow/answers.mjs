/**
 * An agent's answer (incident-platform backlog #0-301, the owner's g1): schemas/answers/<schema>.schema.json of the
 * factory checkout, one per agent, implementer-light's the implementer's. The very bytes go to the call's
 * --json-schema (minified) and to validate.mjs: one schema, never two. A schema off validate.mjs's subset refuses the
 * run; an answer off its schema stops the task, naming where, never what the agent wrote.
 */
import { readFile } from 'node:fs/promises';

import { checkSchema, validate } from '../schema/validate.mjs';
import { FACTORY_ROOT } from './agents.mjs';

/** Each agent's schema file. */
export const ANSWER_SCHEMAS = Object.freeze({ architect: 'architect', implementer: 'implementer',
  'implementer-light': 'implementer' });

/**
 * @param {string} agent
 * @param {{ root?: URL }} [options] for the tests only
 * @returns {Promise<{ schema: object, text: string, path: string }>} `text` what --json-schema is given
 */
export async function readAnswerSchema(agent, { root = FACTORY_ROOT } = {}) {
  const name = ANSWER_SCHEMAS[agent];
  if (!name) {
    throw new TypeError(`readAnswerSchema: ${agent} has no answer schema`);
  }
  const path = `schemas/answers/${name}.schema.json`;
  const schema = JSON.parse(await readFile(new URL(path, root), 'utf8'));
  checkSchema(schema);
  return { schema, text: JSON.stringify(schema), path };
}

/** Where `answer` breaks `schema`: a list, empty when it keeps it. */
export function answerErrors(schema, answer) {
  return validate(schema, answer);
}
