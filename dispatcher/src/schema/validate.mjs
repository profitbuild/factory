/**
 * A JSON Schema validator of Node's built-ins only (ADR-0060 D2; incident-platform backlog #0-275 AC5), for the
 * factory's own schemas: the adapter's and the gate's (schemas/), and the task's state (src/state/task.schema.json).
 *
 * A subset of draft 2020-12, as far as those schemas need and no further: `type` (one or a list), `const`, `enum`;
 * for a string `minLength` (in code points) and `pattern` (a JavaScript regular expression, flag `u`); for a number
 * `minimum`; for an array `items`, `minItems`, `uniqueItems`; for an object `properties`, `required` and
 * `additionalProperties` (false, or a schema); `$defs` and a local `$ref` (`#/$defs/<name>`). The annotations
 * `$schema`, `$id`, `title`, `description` and `$comment` are allowed and mean nothing.
 *
 * A schema that uses any other keyword is refused (checkSchema), so a schema can never claim a check this code does
 * not make. An error names where in the document it is (a JSON Pointer) and what the schema expects, never the value
 * found there: a document is the product's, and could hold anything.
 */
import { isDeepStrictEqual } from 'node:util';

/** A schema uses a keyword this validator does not check, or is not a schema. */
export class SchemaError extends Error {}

const ANNOTATIONS = ['$schema', '$id', 'title', 'description', '$comment'];
const KEYWORDS = new Set([...ANNOTATIONS, 'type', 'const', 'enum', 'minLength', 'pattern', 'minimum', 'items',
  'minItems', 'uniqueItems', 'properties', 'required', 'additionalProperties', '$defs', '$ref']);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const pointer = (path, key) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const where = (path) => (path === '' ? '/' : path);

function resolveRef(root, ref) {
  const match = /^#\/\$defs\/([^/~]+)$/.exec(ref);
  const target = match && isObject(root.$defs) ? root.$defs[match[1]] : undefined;
  if (!isObject(target)) {
    throw new SchemaError(`$ref ${JSON.stringify(ref)} names no #/$defs/<name> of the schema`);
  }
  return target;
}

/**
 * Refuses a schema with a keyword outside the subset, a malformed keyword, or a $ref to nothing.
 *
 * @param {object} schema
 */
export function checkSchema(schema, root = schema, at = '#') {
  if (!isObject(schema)) {
    throw new SchemaError(`${at}: a schema must be an object`);
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(keyword)) {
      throw new SchemaError(`${at}: the keyword ${keyword} is not one this validator checks`);
    }
    if (keyword === 'type') {
      const types = Array.isArray(value) ? value : [value];
      if (types.length === 0 || !types.every((type) => TYPES.has(type))) {
        throw new SchemaError(`${at}: type must name JSON types`);
      }
    } else if (keyword === 'pattern') {
      new RegExp(value, 'u');
    } else if (keyword === 'enum' && (!Array.isArray(value) || value.length === 0)) {
      throw new SchemaError(`${at}: enum must be a list`);
    } else if (keyword === 'required' && !(Array.isArray(value) && value.every((name) => typeof name === 'string'))) {
      throw new SchemaError(`${at}: required must be a list of names`);
    } else if (['minLength', 'minItems'].includes(keyword) && !(Number.isInteger(value) && value >= 0)) {
      throw new SchemaError(`${at}: ${keyword} must be a non-negative integer`);
    } else if (keyword === 'uniqueItems' && typeof value !== 'boolean') {
      throw new SchemaError(`${at}: uniqueItems must be a boolean`);
    } else if (keyword === 'minimum' && typeof value !== 'number') {
      throw new SchemaError(`${at}: minimum must be a number`);
    } else if (keyword === '$ref') {
      resolveRef(root, value);
    } else if (keyword === 'items') {
      checkSchema(value, root, `${at}/items`);
    } else if (keyword === 'additionalProperties' && value !== false) {
      checkSchema(value, root, `${at}/additionalProperties`);
    } else if (keyword === 'properties' || keyword === '$defs') {
      if (!isObject(value)) {
        throw new SchemaError(`${at}: ${keyword} must be an object`);
      }
      for (const [name, sub] of Object.entries(value)) {
        checkSchema(sub, root, `${at}/${keyword}/${name}`);
      }
    }
  }
  return schema;
}

function hasType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'string': return typeof value === 'string';
    default: return false;
  }
}

function validateAt(schema, value, path, root, errors) {
  if (schema.$ref !== undefined) {
    validateAt(resolveRef(root, schema.$ref), value, path, root, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => hasType(value, type))) {
      errors.push(`${where(path)}: must be ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${where(path)}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => isDeepStrictEqual(value, option))) {
    errors.push(`${where(path)}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      errors.push(`${where(path)}: must have at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${where(path)}: must match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${where(path)}: must be at least ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${where(path)}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems && value.some((item, i) => value.findIndex((other) => isDeepStrictEqual(item, other)) < i)) {
      errors.push(`${where(path)}: must not repeat an item`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => validateAt(schema.items, item, pointer(path, i), root, errors));
    }
  }
  if (isObject(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        errors.push(`${pointer(path, name)}: missing`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        validateAt(properties[name], item, pointer(path, name), root, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer(path, name)}: unknown field`);
      } else if (isObject(schema.additionalProperties)) {
        validateAt(schema.additionalProperties, item, pointer(path, name), root, errors);
      }
    }
  }
}

/**
 * Every place where `value` breaks `schema`, in document order; an empty list when it conforms.
 *
 * @param {object} schema checked by checkSchema first
 * @param {unknown} value
 * @returns {string[]}
 */
export function validate(schema, value) {
  checkSchema(schema);
  const errors = [];
  validateAt(schema, value, '', schema, errors);
  return errors;
}
