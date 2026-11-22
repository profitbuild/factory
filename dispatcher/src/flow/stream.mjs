/**
 * An agent call's stream-json, read back from the file the starter wrote it to (incident-platform backlog #0-301,
 * ADR-0064 point 3): line by line, never whole in memory, each line at most MAX_LINE bytes. Fail closed: the first
 * line must be the `system` event of subtype `init`; every line must be JSON and an event of a type Claude Code
 * 2.1.328 writes (EVENT_TYPES; a `system` event of no other subtype than init); the last must be the one `result`.
 * A stream that breaks any of it is refused by the line's number and what it is not, never by what it holds: the
 * stream is the agent's side's.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** The stream is not one the dispatcher reads an answer from. */
export class StreamError extends Error {}

/** The longest line read, and the event types of 2.1.328's stream-json (the spike of #0-300, rounds A to D). */
export const MAX_LINE = 1024 * 1024;
export const EVENT_TYPES = Object.freeze(['system', 'assistant', 'user', 'result']);
export const SYSTEM_SUBTYPES = Object.freeze(['init']);

/**
 * @param {string} path the call's .jsonl
 * @returns {Promise<{ init: object, result: object, lines: number }>}
 */
export async function readStream(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  let init = null;
  let result = null;
  for await (const line of lines) {
    n += 1;
    if (Buffer.byteLength(line) > MAX_LINE) {
      throw new StreamError(`line ${n} of the call's stream is longer than ${MAX_LINE} bytes`);
    }
    if (result !== null) {
      throw new StreamError(`line ${n} of the call's stream follows its result`);
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new StreamError(`line ${n} of the call's stream is not JSON`);
    }
    if (typeof event !== 'object' || event === null || !EVENT_TYPES.includes(event.type)
      || (event.type === 'system' && !SYSTEM_SUBTYPES.includes(event.subtype))) {
      throw new StreamError(`line ${n} of the call's stream is not one of Claude Code 2.1.328's events`);
    }
    if (n === 1 && !(event.type === 'system' && event.subtype === 'init')) {
      throw new StreamError('the call\'s stream does not begin with its init event');
    }
    if (event.type === 'system') {
      if (init !== null) {
        throw new StreamError(`line ${n} of the call's stream is a second init event`);
      }
      init = event;
    } else if (event.type === 'result') {
      result = event;
    }
  }
  if (n === 0) {
    throw new StreamError('the call\'s stream is empty');
  }
  if (result === null) {
    throw new StreamError('the call\'s stream has no result');
  }
  return { init, result, lines: n };
}
