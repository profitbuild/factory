/**
 * What the proxy counts per task (incident-platform backlog #0-313 AC3, AC8): tasks/<runId>/proxy.json, its own file,
 * not task.json (the phases write task.json from the task they hold, so a second writer would race them; review of
 * #0-313's plan, G). One writer, the run's own proxy, each write whole and atomic under the state's lock
 * (writeJsonAtomic, withStateLock), at most once a second and once more when the proxy closes.
 *
 * - usage, summed from each response's SSE stream as it passes (sseMeter): message_start's usage and message_delta's
 *   output_tokens, read from those two events' data lines only. The meter holds one line at most (1 MiB); a response
 *   it cannot count (not SSE, a line past that, a data line off its form) adds to `unmetered`, and still passes. The
 *   stream is never held; the request's body is read only to check it (request-filter.mjs), never logged or kept.
 * - the rate-limit headers of the last response (retry-after, anthropic-ratelimit-*), for M5's slots: a name of that
 *   form, a value a number or an ISO time, or it is not kept, and counted.
 * - the names of the request headers the proxy dropped (upstream.mjs's list is a guess until AC4 compares it with a
 *   call that answered: review of #0-313's plan, E): lower case, ^[a-z0-9-]{1,64}$, at most 32 distinct, no value; one
 *   off that form, or past 32, is counted, not named.
 * - the requests forwarded, and those refused by reason.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkSchema, validate } from '../schema/validate.mjs';
import { StateError, readJson, writeJsonAtomic } from '../state/files.mjs';
import { withStateLock } from '../state/lock.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../state/proxy.schema.json', import.meta.url), 'utf8'));
checkSchema(SCHEMA);

/** The longest line the meter holds. */
export const METER_LINE = 1024 * 1024;
/** The most distinct header names kept, of those dropped and of the rate-limit ones. */
export const NAMES_KEPT = 32;
const NAME = /^[a-z0-9-]{1,64}$/;
const RATE_NAME = /^(?:retry-after|anthropic-ratelimit-[a-z0-9-]{1,48})$/;
const RATE_VALUE = /^(?:[0-9]{1,20}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z)$/;
const TOKENS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

export const proxyRecordPath = (stateDir, runId) => join(stateDir, 'tasks', runId, 'proxy.json');

/** A new record of the run `runId`. */
export function newRecord(runId) {
  return {
    version: 1, runId, forwarded: 0, refused: {},
    usage: Object.fromEntries([...TOKENS, 'unmetered'].map((k) => [k, 0])),
    rateLimits: {}, rateLimitsDropped: 0, droppedHeaders: [], droppedHeadersUncounted: 0,
  };
}

/** Keeps the names of request headers dropped (lower case, of the form, at most NAMES_KEPT). */
export function noteDropped(record, names) {
  for (const name of names) {
    if (record.droppedHeaders.includes(name)) {
      continue;
    }
    if (NAME.test(name) && record.droppedHeaders.length < NAMES_KEPT) {
      record.droppedHeaders.push(name);
    } else {
      record.droppedHeadersUncounted += 1;
    }
  }
}

/** Keeps the rate-limit headers of a response (`headers` node's, lower case), each checked. */
export function noteRateLimits(record, headers) {
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith('anthropic-ratelimit-') && name !== 'retry-after') {
      continue;
    }
    const known = Object.hasOwn(record.rateLimits, name);
    if (RATE_NAME.test(name) && typeof value === 'string' && RATE_VALUE.test(value)
      && (known || Object.keys(record.rateLimits).length < NAMES_KEPT)) {
      record.rateLimits[name] = value;
    } else {
      record.rateLimitsDropped += 1;
    }
  }
}

const count = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * A meter of one SSE response: `feed` each chunk as it passes, `end` once it has, which adds the response's usage to
 * `record.usage` (or one to `unmetered`).
 */
export function sseMeter(record) {
  let pending = [];
  let pendingBytes = 0;
  let event = null;
  let ok = true;
  const message = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let seen = false;
  const line = (text) => {
    if (text.startsWith('event:')) {
      event = text.slice(6).trim();
      return;
    }
    if (text === '') {
      event = null;
      return;
    }
    if (!text.startsWith('data:') || (event !== 'message_start' && event !== 'message_delta')) {
      return;
    }
    let data;
    try {
      data = JSON.parse(text.slice(5));
    } catch {
      ok = false;
      return;
    }
    const usage = event === 'message_start' ? data?.message?.usage : data?.usage;
    if (typeof usage !== 'object' || usage === null) {
      ok = false;
      return;
    }
    seen = true;
    for (const key of TOKENS) {
      if (usage[key] === undefined) {
        continue;
      }
      if (!count(usage[key])) {
        ok = false;
        return;
      }
      // message_delta's output_tokens is the message's so far, not a step: the last one stands.
      message[key] = usage[key];
    }
  };
  return {
    feed(chunk) {
      if (!ok) {
        return;
      }
      let start = 0;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
        pending.push(chunk.subarray(start, i));
        const text = Buffer.concat(pending).toString('utf8');
        pending = [];
        pendingBytes = 0;
        line(text.endsWith('\r') ? text.slice(0, -1) : text);
        start = i + 1;
      }
      if (start < chunk.length) {
        pendingBytes += chunk.length - start;
        if (pendingBytes > METER_LINE) {
          ok = false;
          pending = [];
          return;
        }
        pending.push(chunk.subarray(start));
      }
    },
    end() {
      if (ok && seen) {
        for (const key of TOKENS) {
          record.usage[key] += message[key];
        }
      } else {
        record.usage.unmetered += 1;
      }
    },
  };
}

/** Writes the record whole (#0-313), under the state's lock. */
export function writeProxyRecord(stateDir, record) {
  const errors = validate(SCHEMA, record);
  if (errors.length > 0) {
    throw new StateError(`the proxy's record of ${record.runId} is off its form (${errors.length} errors)`);
  }
  return withStateLock(stateDir, () => writeJsonAtomic(proxyRecordPath(stateDir, record.runId), record));
}

/**
 * The record of the run `runId`, checked against state/proxy.schema.json, or undefined when there is none.
 *
 * @returns {Promise<object | undefined>}
 */
export async function readProxyRecord(stateDir, runId) {
  const record = await withStateLock(stateDir, () => readJson(proxyRecordPath(stateDir, runId)));
  if (record !== undefined && validate(SCHEMA, record).length > 0) {
    throw new StateError(`the proxy's record of ${runId} is off its form`);
  }
  return record;
}
