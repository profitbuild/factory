/**
 * The dispatcher's own reader of JSONC, the format of a devcontainer configuration (incident-platform backlog #0-277,
 * ADR-0062 point 4): JSON with comments, built-ins only (ADR-0060 D2). The task configuration a product ships is read
 * with it as data, from the base (`git show <base>:<taskImage>`), and checked against the closed list
 * (task-config.mjs); the devcontainer CLI never reads that file: it reads the override the dispatcher writes, as
 * strict JSON.
 *
 * What it takes, beyond JSON (RFC 8259):
 * - comments, `// ...` to the end of the line and `/* ... *\/`, anywhere whitespace may be;
 * - a trailing comma after the last member of an object or the last element of an array: the devcontainer CLI's
 *   reader (jsonc-parser) takes one, so a configuration written for it may hold one; since the dispatcher hands the
 *   CLI its own strict JSON, never the product's text, a leniency here changes nothing the CLI reads;
 * - a byte order mark at the start.
 * What it refuses, beyond what JSON refuses: a key twice in one object (JSON.parse and jsonc-parser keep the last, so a
 * duplicate is ambiguous to a reader of the file: refused, not chosen); an unterminated comment; more than MAX_DEPTH
 * levels; more than MAX_BYTES. A refusal names the line and column, never the text there.
 */

/** The largest configuration read. */
export const MAX_BYTES = 256 * 1024;
/** The deepest nesting of objects and arrays. */
export const MAX_DEPTH = 64;

/** The text is not JSONC, or is out of the reader's bounds. */
export class JsoncError extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// A JSON string: no raw control character, escapes as JSON has them.
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const WORDS = { true: true, false: false, null: null };

/**
 * @param {string} text
 * @returns {unknown}
 * @throws {JsoncError}
 */
export function parseJsonc(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseJsonc: text must be a string');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new JsoncError(`the text is more than ${MAX_BYTES} bytes`);
  }
  let at = text.startsWith('﻿') ? 1 : 0;

  const where = (index = at) => {
    const before = text.slice(0, index).split('\n');
    return `line ${before.length}, column ${before.at(-1).length + 1}`;
  };
  const fail = (what, index = at) => { throw new JsoncError(`${what} at ${where(index)}`); };

  const skip = () => {
    for (;;) {
      const c = text[at];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        at += 1;
      } else if (c === '/' && text[at + 1] === '/') {
        const end = text.indexOf('\n', at);
        at = end < 0 ? text.length : end + 1;
      } else if (c === '/' && text[at + 1] === '*') {
        const end = text.indexOf('*/', at + 2);
        if (end < 0) {
          fail('an unterminated comment');
        }
        at = end + 2;
      } else {
        return;
      }
    }
  };

  const token = (pattern) => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) {
      return null;
    }
    at += match[0].length;
    return match[0];
  };

  const value = (depth) => {
    skip();
    const c = text[at];
    if (c === '{' || c === '[') {
      if (depth >= MAX_DEPTH) {
        fail(`more than ${MAX_DEPTH} levels of nesting`);
      }
      return c === '{' ? object(depth + 1) : array(depth + 1);
    }
    if (c === '"') {
      const raw = token(STRING) ?? fail('a malformed string');
      return JSON.parse(raw);
    }
    for (const [word, result] of Object.entries(WORDS)) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return result;
      }
    }
    const number = token(NUMBER);
    if (number !== null) {
      return JSON.parse(number);
    }
    return fail(at >= text.length ? 'the text ends where a value is expected' : 'a value is expected');
  };

  const object = (depth) => {
    at += 1;
    const result = {};
    const seen = new Set();
    skip();
    if (text[at] === '}') {
      at += 1;
      return result;
    }
    for (;;) {
      skip();
      if (text[at] === '}' && seen.size > 0) {
        at += 1;
        return result;
      }
      const keyAt = at;
      if (text[at] !== '"') {
        fail('a key (a string) is expected');
      }
      const key = JSON.parse(token(STRING) ?? fail('a malformed key'));
      if (seen.has(key)) {
        fail('a key that the object already holds', keyAt);
      }
      seen.add(key);
      skip();
      if (text[at] !== ':') {
        fail('":" is expected');
      }
      at += 1;
      Object.defineProperty(result, key, { value: value(depth), enumerable: true, writable: true, configurable: true });
      skip();
      if (text[at] === ',') {
        at += 1;
      } else if (text[at] === '}') {
        at += 1;
        return result;
      } else {
        fail('"," or "}" is expected');
      }
    }
  };

  const array = (depth) => {
    at += 1;
    const result = [];
    skip();
    if (text[at] === ']') {
      at += 1;
      return result;
    }
    for (;;) {
      skip();
      if (text[at] === ']' && result.length > 0) {
        at += 1;
        return result;
      }
      result.push(value(depth));
      skip();
      if (text[at] === ',') {
        at += 1;
      } else if (text[at] === ']') {
        at += 1;
        return result;
      } else {
        fail('"," or "]" is expected');
      }
    }
  };

  const result = value(0);
  skip();
  if (at < text.length) {
    fail('text after the value');
  }
  return result;
}
