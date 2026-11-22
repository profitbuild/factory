/**
 * The findings of a fix-review run (incident-platform backlog #0-301, points B and the owner's B):
 * `cli.mjs run --resume <branch> --findings <file>`, the owner's file on the VM: the dispatcher's user's, 600, at most
 * MAX_FINDINGS_BYTES, JSON held to schemas/findings.schema.json (ids `^([a-z]+-[0-9a-f]{4}|ver-[0-9a-f]{8})$`, each
 * once). The dispatcher decides on the ids alone: the implementer's answer must name each exactly once, in `fixed`
 * or `disputed`, and nothing else; the file and the text go into the prompt only.
 */
import { readFile } from 'node:fs/promises';

import { readOwnFile } from '../config/own-file.mjs';
import { validate } from '../schema/validate.mjs';
import { FACTORY_ROOT } from './agents.mjs';

/** The findings are not ones a fix-review run is given. */
export class FindingsError extends Error {}

export const MAX_FINDINGS_BYTES = 256 * 1024;

/**
 * @param {string} path
 * @param {{ root?: URL }} [options] for the tests only
 * @returns {Promise<{ id: string, severity: string, file: string, text: string }[]>}
 */
export async function readFindings(path, { root = FACTORY_ROOT } = {}) {
  const text = await readOwnFile(path, { what: 'the findings', forbiddenMode: 0o077, maxBytes: MAX_FINDINGS_BYTES,
    refuse: (message) => new FindingsError(message) });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FindingsError(`the findings ${path} are not JSON`);
  }
  const schema = JSON.parse(await readFile(new URL('schemas/findings.schema.json', root), 'utf8'));
  const errors = validate(schema, parsed);
  if (errors.length > 0) {
    throw new FindingsError(`the findings ${path} are not schemas/findings.schema.json's form: ${errors.join('; ')}`);
  }
  const ids = parsed.findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length) {
    throw new FindingsError(`the findings ${path} name an id twice`);
  }
  return parsed.findings;
}

/**
 * Whether the implementer's answer names each finding exactly once, in fixed or disputed, and no other id.
 *
 * @returns {string | null} why not, by counts, or null
 */
export function coverageProblem(findings, answer) {
  const named = [...answer.fixed, ...answer.disputed.map((d) => d.id)];
  const ids = findings.map((f) => f.id);
  const missing = ids.filter((id) => !named.includes(id)).length;
  const extra = named.filter((id) => !ids.includes(id)).length;
  const twice = named.length - new Set(named).size;
  return missing + extra + twice === 0 ? null : `the answer names ${missing} finding(s) in neither fixed nor `
    + `disputed, ${extra} id(s) it was not given, and ${twice} twice`;
}
