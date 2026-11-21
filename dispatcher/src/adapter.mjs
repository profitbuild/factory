/**
 * A product's adapter, `.factory/adapter.json`, and its gate's answer, against the factory's schemas
 * (schemas/adapter.schema.json, schemas/gate.schema.json; incident-platform ADR-0060 D6, backlog #0-275 AC5).
 *
 * The schema checks the adapter's spelling only. The adapter is read from the base commit of the dispatcher's clone of
 * the product's main, as a blob, and its paths are checked against that base's tree, by product/adapter-from-base.mjs
 * (incident-platform backlog #0-278). A refusal lists where the document breaks the schema, never a value found there.
 */
import adapterSchema from '../../schemas/adapter.schema.json' with { type: 'json' };
import gateSchema from '../../schemas/gate.schema.json' with { type: 'json' };
import { checkSchema, validate } from './schema/validate.mjs';

checkSchema(adapterSchema);
checkSchema(gateSchema);

/** An adapter, or a gate's answer, does not keep its schema. */
export class AdapterError extends Error {}

const refuse = (what, errors) => new AdapterError(`${what} breaks its schema: ${errors.join('; ')}`);

/**
 * The adapter in `value`, refused unless it keeps schemas/adapter.schema.json.
 *
 * @param {unknown} value
 * @returns {object} a deep frozen copy
 */
export function checkAdapter(value) {
  const errors = validate(adapterSchema, value);
  if (errors.length > 0) {
    throw refuse('the adapter', errors);
  }
  return deepFreeze(structuredClone(value));
}

/**
 * A gate's answer, refused unless it keeps schemas/gate.schema.json.
 *
 * @param {unknown} value
 * @returns {{ status: 'pass' | 'fixable' | 'stop', exitCode: number, modules: string, log: string, head: string,
 *   artifact: string | null, summary: string[] }}
 */
export function checkGateAnswer(value) {
  const errors = validate(gateSchema, value);
  if (errors.length > 0) {
    throw refuse('the gate\'s answer', errors);
  }
  return value;
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
