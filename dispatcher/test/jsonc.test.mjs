// The dispatcher's JSONC reader (incident-platform backlog #0-277 AC9): JSON with comments and trailing commas, as a
// devcontainer configuration is written; a key twice, an unterminated comment, text after the value, nesting or size
// past the bounds refused, naming where and never what.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JsoncError, MAX_BYTES, MAX_DEPTH, parseJsonc } from '../src/container/jsonc.mjs';
import { CONFIG, CONFIG_TEXT } from '../testing/task-product.mjs';

const refused = (text, pattern) => assert.throws(() => parseJsonc(text), (error) => {
  assert.ok(error instanceof JsoncError, error.message);
  assert.match(error.message, pattern);
  return true;
});

test('comments, trailing commas and a BOM are read; the values are JSON\'s', () => {
  assert.deepEqual(parseJsonc(CONFIG_TEXT), CONFIG);
  assert.deepEqual(parseJsonc('﻿{"a": [1, 2,], /* x */ "b": {"c": null,},} // end'), { a: [1, 2], b: { c: null } });
  assert.deepEqual(parseJsonc('"a // not a comment /* nor this */"'), 'a // not a comment /* nor this */');
  assert.deepEqual(parseJsonc('[-0.5e3, true, false, "\\u00e9\\n", {}, []]'), [-500, true, false, 'é\n', {}, []]);
  assert.deepEqual(parseJsonc('//only a comment\n7'), 7);
  const proto = parseJsonc('{"__proto__": {"x": 1}}');
  assert.deepEqual(Object.keys(proto), ['__proto__']);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype, 'a key named __proto__ is a key, not the prototype');
});

test('a key twice in one object is refused, at any depth, where it is', () => {
  refused('{"a": 1, "a": 2}', /^a key that the object already holds at line 1, column 10$/);
  refused('{"x": {\n  "build": 1,\n  "build": 2}}', /already holds at line 3, column 3/);
  assert.deepEqual(parseJsonc('{"a": {"b": 1}, "b": {"a": 2}}'), { a: { b: 1 }, b: { a: 2 } });
});

test('what is not JSONC is refused, naming where and never the text', () => {
  for (const [text, pattern] of [
    ['', /the text ends where a value is expected/],
    ['{"a": 1', /"," or "}" is expected/],
    ['{"a" 1}', /":" is expected/],
    ['{a: 1}', /a key \(a string\) is expected/],
    ["{'a': 1}", /a key \(a string\) is expected/],
    ['{,}', /a key \(a string\) is expected/],
    ['[,]', /a value is expected/],
    ['[1,,]', /a value is expected/],
    ['{"a": 1,,}', /a key \(a string\) is expected/],
    ['{"a": 1} {"b": 2}', /text after the value at line 1, column 10/],
    ['{"a": 1} /* open', /an unterminated comment/],
    ['"a\nb"', /a malformed string/],
    ['"\\x"', /a malformed string/],
    ['01', /text after the value/],
    ['NaN', /a value is expected/],
    ['[1 2]', /"," or "]" is expected/],
    ['{"SECRET-VALUE": }', /^a value is expected at line 1, column 18$/],
  ]) {
    refused(text, pattern);
  }
});

test('nesting and size are bounded', () => {
  assert.equal(parseJsonc(`${'['.repeat(MAX_DEPTH)}${']'.repeat(MAX_DEPTH)}`).length, 1);
  refused(`${'['.repeat(MAX_DEPTH + 1)}${']'.repeat(MAX_DEPTH + 1)}`, new RegExp(`more than ${MAX_DEPTH} levels`));
  refused(`"${'x'.repeat(MAX_BYTES)}"`, new RegExp(`more than ${MAX_BYTES} bytes`));
  assert.throws(() => parseJsonc(Buffer.from('{}')), TypeError);
});
