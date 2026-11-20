// The one helper of every GitHub call (incident-platform backlog #0-275 AC4, #0-261), against the fake GitHub: a 5xx,
// a 429, a rate limit's 403, a timeout or a network error (DNS) is retried and not counted as an attempt; ten in a row
// are GitHubUnavailableError, which blocks the task (tasks.test.mjs); a 404, a 422 or a plain 403 is not retried. The
// waits are 1 s doubling to 60 s with jitter, no shorter than Retry-After held to 60 s; the clock is injected, so no
// test waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffMs, FIRST_DELAY_MS, githubCall, GitHubUnavailableError, isTransient, MAX_DELAY_MS, MAX_IN_A_ROW, withRetries,
} from '../src/github/retry.mjs';
import { createTask, runPhases } from '../src/state/tasks.mjs';
import { startFakeGitHub } from '../testing/fake-github.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const PATH = '/repos/o/r/pulls';
const OK = { status: 200, body: [{ number: 7 }] };

/** A fake GitHub answering GET PATH with `answers` in turn, then OK; and a retry that records its waits. */
async function fakeWith(t, answers) {
  let n = 0;
  const github = await startFakeGitHub({ [`GET ${PATH}`]: () => answers[n++] ?? OK });
  t.after(github.close);
  const waits = [];
  const retries = [];
  const retry = {
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0.5,
    onRetry: (r) => retries.push(r.failures),
  };
  const call = () => githubCall({ baseUrl: github.baseUrl, method: 'GET', path: PATH, bearer: 'tok', timeoutMs: 200 },
    retry);
  return { github, call, waits, retries };
}

const status = (code, headers = {}) => ({ status: code, body: { message: `fake ${code}` }, headers });

test('AC4: a 503, 500, 502 or 429 is retried until GitHub answers, and the retries are not attempts', async (t) => {
  for (const code of [503, 500, 502, 504, 429]) {
    const { github, call, retries } = await fakeWith(t, [status(code), status(code), status(code)]);
    assert.deepEqual(await call(), [{ number: 7 }], `${code}`);
    assert.equal(github.requests.length, 4, `${code}: three retries and the answer`);
    assert.deepEqual(retries, [1, 2, 3]);
  }
});

test('AC4: a timeout is retried', async (t) => {
  const { github, call } = await fakeWith(t, [{ ...OK, delayMs: 400 }, { ...OK, delayMs: 400 }]);
  assert.deepEqual(await call(), [{ number: 7 }]);
  assert.equal(github.requests.length, 3);
});

test('AC4: a network error, a refused connection or a DNS error, is retried', async (t) => {
  const closed = await startFakeGitHub({});
  await closed.close();
  let calls = 0;
  const dns = async (url, init) => {
    calls += 1;
    if (calls <= 2) {
      // What undici throws when the name does not resolve.
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'),
        { code: 'ENOTFOUND' }) });
    }
    return fetch(url, init);
  };
  const github = await startFakeGitHub({ [`GET ${PATH}`]: () => OK });
  t.after(github.close);
  const sleep = async () => {};
  assert.deepEqual(await githubCall({ baseUrl: github.baseUrl, method: 'GET', path: PATH, bearer: 't', fetchImpl: dns },
    { sleep }), [{ number: 7 }]);
  assert.equal(calls, 3);

  const failures = [];
  await assert.rejects(githubCall({ baseUrl: closed.baseUrl, method: 'GET', path: PATH, bearer: 't' },
    { sleep, onRetry: ({ error }) => failures.push(error.kind) }), GitHubUnavailableError);
  assert.deepEqual(failures, Array(MAX_IN_A_ROW - 1).fill('network'), 'the refused connection, retried');
});

test('AC4: ten transient failures in a row are GitHubUnavailableError, with the reason and no token', async (t) => {
  const { github, call, waits } = await fakeWith(t, Array(20).fill(status(503)));
  await assert.rejects(call(), (error) => {
    assert.ok(error instanceof GitHubUnavailableError, error.message);
    assert.match(error.message, new RegExp(`^GitHub failed 10 times in a row, each time transiently .*; the last: `
      + `GitHub GET ${PATH}: 503 fake 503$`));
    assert.ok(!error.message.includes('tok'));
    assert.equal(error.cause.status, 503);
    return true;
  });
  assert.equal(github.requests.length, MAX_IN_A_ROW);
  assert.equal(waits.length, MAX_IN_A_ROW - 1, 'no wait after the tenth');
});

test('AC4: nine in a row and then an answer is a success: "in a row" counts consecutive failures only', async (t) => {
  const { call } = await fakeWith(t, Array(MAX_IN_A_ROW - 1).fill(status(503)));
  assert.deepEqual(await call(), [{ number: 7 }]);
});

test('AC4: ten 503s in a phase make the task BLOCKED with the reason', async (t) => {
  const { call } = await fakeWith(t, Array(20).fill(status(503)));
  const state = await makeStateDir();
  t.after(state.remove);
  const task = await createTask(state.dir, { runId: '20261120T101500Z-000001' });
  const left = await runPhases(state.dir, task, [{ name: 'ship', run: async () => { await call(); return {}; } }]);
  assert.equal(left.status, 'blocked');
  assert.match(left.reason, /^ship: GitHub failed 10 times in a row, .*503 fake 503$/);
});

test('AC4: a 404, a 422, a 401 or a plain 403 is not retried: one request, thrown at once', async (t) => {
  for (const code of [404, 422, 401, 403, 400]) {
    const { github, call, retries } = await fakeWith(t, [status(code)]);
    await assert.rejects(call(), (error) => error.status === code && !(error instanceof GitHubUnavailableError));
    assert.equal(github.requests.length, 1, `${code}`);
    assert.deepEqual(retries, []);
  }
});

test('AC4: a 403 that is a rate limit (Retry-After, or x-ratelimit-remaining 0) is retried', async (t) => {
  for (const headers of [{ 'retry-after': '3' }, { 'x-ratelimit-remaining': '0' }, { 'retry-after': 'garbage' }]) {
    const { github, call } = await fakeWith(t, [status(403, headers)]);
    assert.deepEqual(await call(), [{ number: 7 }], JSON.stringify(headers));
    assert.equal(github.requests.length, 2);
  }
  const { github, call } = await fakeWith(t, [status(403, { 'x-ratelimit-remaining': '4999' })]);
  await assert.rejects(call(), { status: 403 });
  assert.equal(github.requests.length, 1, 'a 403 with requests left is an answer');
});

test('the waits: 1 s doubling to 60 s, jittered within [d/2, d)', async (t) => {
  const { call, waits } = await fakeWith(t, Array(20).fill(status(503)));
  await assert.rejects(call(), GitHubUnavailableError);
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 60, 60, 60].map((s) => s * 1000 * 0.75));
  assert.equal(backoffMs(1, () => 0), FIRST_DELAY_MS / 2);
  assert.ok(backoffMs(1, () => 0.999999) < FIRST_DELAY_MS);
  assert.equal(backoffMs(30, () => 0), MAX_DELAY_MS / 2);
  assert.ok(backoffMs(30, () => 0.999999) < MAX_DELAY_MS);
});

test('Retry-After of a 429 sets the wait when it is longer, held to 60 s', async (t) => {
  const { call, waits } = await fakeWith(t, [status(429, { 'retry-after': '7' }), status(429, { 'retry-after': '3600' }),
    status(429, { 'retry-after': '0' })]);
  await call();
  assert.deepEqual(waits, [7000, MAX_DELAY_MS, 4 * 1000 * 0.75]);
  const date = new Date(Date.now() + 20_000).toUTCString();
  const late = await fakeWith(t, [status(429, { 'retry-after': date })]);
  await late.call();
  assert.ok(late.waits[0] > 15_000 && late.waits[0] <= 20_000, `${late.waits[0]}`);
});

test('isTransient reads status and kind, never the message', () => {
  assert.equal(isTransient(new Error('503 timeout network')), false);
  assert.equal(isTransient(Object.assign(new Error('x'), { kind: 'timeout' })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { kind: 'network' })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { kind: 'other' })), false);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 599 })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 600 })), false);
  assert.equal(isTransient(undefined), false);
});

test('a call that is not githubRequest\'s goes through withRetries too, under the same rule', async () => {
  let n = 0;
  const value = await withRetries(async () => {
    n += 1;
    if (n < 3) {
      throw Object.assign(new Error('x'), { status: 502 });
    }
    return 'done';
  }, { sleep: async () => {} });
  assert.equal(value, 'done');
  await assert.rejects(withRetries(async () => { throw new TypeError('a bug'); }, { sleep: async () => {} }),
    TypeError);
});
