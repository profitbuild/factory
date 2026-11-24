// The dispatcher's credential proxy (incident-platform backlog #0-313, AC1, AC3, AC5, AC8), against a fake of
// Anthropic's API (testing/fake-anthropic.mjs) and a key that is a marker (testing/proxy-files.mjs): no real call, no
// real key. The token: refused when missing, another proxy's, not yet active, revoked, or with its two headers apart;
// the address it listens on, and none other; the stream passed through unchanged and not buffered, its usage summed in
// proxy.json; the client's credentials and every header off the list kept from upstream, the fixed target, the paths,
// the in-flight limit, the error shape and X-Should-Retry, the throttled log that quotes nothing of a request, the
// body never read, a client gone ending the upstream request.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { IN_FLIGHT, ProxyError, presentedToken, startProxy } from '../src/proxy/server.mjs';
import { BODY_LIMIT, REQUEST_HEADERS } from '../src/proxy/upstream.mjs';
import { LOG_EVERY_MS, refusalLog } from '../src/proxy/refusal-log.mjs';
import {
  METER_LINE, NAMES_KEPT, newRecord, noteDropped, noteRateLimits, readProxyRecord, sseMeter,
} from '../src/proxy/usage.mjs';
import { sseAnswer, startFakeAnthropic } from '../testing/fake-anthropic.mjs';
import { keyMarker, localAddress, testPorts } from '../testing/proxy-files.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
const anthropic = await startFakeAnthropic();
after(async () => {
  await anthropic.close();
  await root.remove();
});
const ADDR = localAddress();
const KEY = keyMarker();
let next = 0;

/** The betas a test's proxy allows: its own list, as expectations.json's would be on the VM. */
const BETAS = Object.freeze(['b1', 'beta-allowed-2025']);

/** A proxy of a run of its own, with the fake upstream, its log lines kept. */
async function proxyOf({ ports = testPorts(), upstream = anthropic.upstream } = {}) {
  next += 1;
  const runId = `20261122T17${String(next).padStart(4, '0')}Z-0d0313`;
  await mkdir(join(root.dir, 'tasks', runId), { recursive: true, mode: 0o700 });
  const lines = [];
  const proxy = await startProxy({ addr: ADDR, ports, key: KEY, betas: BETAS, runId, stateDir: root.dir,
    err: { write: (line) => lines.push(line) }, proxyTesting: { upstream } });
  after(() => proxy.close());
  return { proxy, runId, lines };
}

/** One request to `baseUrl`, its answer read whole: { status, headers, body } or { error }. */
function send(baseUrl, { method = 'POST', path = '/v1/messages?beta=true', headers = {}, body = '{}', token,
  onFirst } = {}) {
  const url = new URL(baseUrl);
  const all = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers };
  if (token !== undefined) {
    all.authorization ??= `Bearer ${token}`;
    all['x-api-key'] ??= token;
  }
  return new Promise((resolve) => {
    const req = request({ host: url.hostname, port: url.port, method, path, headers: all }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (chunks.length === 1) {
          onFirst?.(chunk, req);
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => resolve({ error: error.code ?? error.message }));
    });
    req.on('error', (error) => resolve({ error: error.code ?? error.message }));
    req.end(body);
  });
}

const errorOf = (answer) => JSON.parse(answer.body);

test('#0-313 AC1: a request with no token, another task\'s, one not yet active, one revoked, or two credentials that '
  + 'differ is refused 401 in Anthropic\'s shape; the token in either header passes', async () => {
  const { proxy, lines } = await proxyOf();
  const other = await proxyOf();
  const seen = anthropic.requests.length;
  const refused = async (options, reason) => {
    const answer = await send(proxy.baseUrl, options);
    assert.equal(answer.status, 401, reason);
    assert.deepEqual(Object.keys(errorOf(answer)), ['type', 'error']);
    assert.equal(errorOf(answer).type, 'error');
    assert.equal(errorOf(answer).error.type, 'authentication_error');
    assert.equal(answer.headers['x-should-retry'], 'false');
    assert.equal(answer.headers['retry-after'], undefined);
  };
  await refused({ token: proxy.token }, 'not active before its container is checked');
  proxy.activate();
  other.proxy.activate();
  await refused({}, 'no token');
  await refused({ token: other.proxy.token }, 'another task\'s');
  await refused({ token: `${proxy.token}x` }, 'one longer');
  await refused({ headers: { authorization: `Bearer ${proxy.token}`, 'x-api-key': other.proxy.token } }, 'differ');
  await refused({ headers: { authorization: proxy.token } }, 'Authorization without Bearer');
  assert.equal(anthropic.requests.length, seen, 'nothing refused reached upstream');
  for (const headers of [{ 'x-api-key': proxy.token }, { authorization: `Bearer ${proxy.token}` }]) {
    assert.equal((await send(proxy.baseUrl, { headers })).status, 200);
  }
  assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200);
  proxy.revoke();
  await refused({ token: proxy.token }, 'revoked');
  await proxy.close();
  assert.equal((await send(proxy.baseUrl, { token: proxy.token })).error, 'ECONNREFUSED', 'closed: no one listens');
  assert.ok(lines.every((line) => !line.includes(proxy.token) && !line.includes(other.proxy.token)));
  assert.deepEqual(presentedToken({ 'x-api-key': 'a', authorization: 'Bearer b' }), { differ: true });
});

test('#0-313: the token is compared in constant time only, never with === (the mutation a timing test cannot see)',
  async () => {
    const source = await readFile(new URL('../src/proxy/server.mjs', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(code, /timingSafeEqual\(digest\(presented\.token\), tokenDigest\)/);
    // No equality with the token or its digest; presented.token is only ever compared with undefined.
    assert.doesNotMatch(code, /[!=]==?\s*(?:presented\.)?(?:token|tokenDigest)\b/);
    assert.doesNotMatch(code, /(?<![.\w])(?:token|tokenDigest)\s*[!=]==?/);
    assert.doesNotMatch(code, /presented\.token\s*(?:===|!==|==|!=)(?!=)(?!\s*undefined\b)/);
    assert.doesNotMatch(code, /\.equals\(|Buffer\.compare\(/);
  });

test('#0-313 AC5: the proxy listens on the configured address and the first free port of its list, never the loopback',
  async () => {
    const [taken, free] = testPorts(2);
    const holder = createServer();
    await new Promise((resolve) => { holder.listen({ host: ADDR, port: taken }, resolve); });
    try {
      const { proxy } = await proxyOf({ ports: [taken, free] });
      assert.equal(proxy.baseUrl, `http://${ADDR}:${free}`);
      assert.equal(proxy.port, free);
      proxy.activate();
      assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200);
      assert.equal((await send(`http://127.0.0.1:${free}`, { token: proxy.token })).error, 'ECONNREFUSED',
        'not on the loopback');
      await assert.rejects(proxyOf({ ports: [taken] }), (error) => {
        assert.ok(error instanceof ProxyError);
        assert.equal(error.message, 'every port of the proxy\'s configuration is taken (1)');
        return true;
      });
    } finally {
      holder.close();
    }
  });

test('#0-313 AC3, AC8: the stream passes unchanged and unbuffered, its usage summed per task in proxy.json',
  async () => {
    const { proxy, runId } = await proxyOf();
    proxy.activate();
    const whole = sseAnswer().join('');
    const release = anthropic.hold();
    let firstSeen = null;
    const pending = send(proxy.baseUrl, { token: proxy.token, onFirst: (chunk) => { firstSeen = chunk.toString(); } });
    // The first event reaches the client while upstream still holds the rest: nothing is gathered first.
    for (let i = 0; i < 100 && firstSeen === null; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    assert.equal(firstSeen, sseAnswer()[0], 'the first event, before upstream sent the rest');
    release();
    const answer = await pending;
    assert.equal(answer.status, 200);
    assert.equal(answer.body, whole, 'byte for byte');
    assert.equal((await send(proxy.baseUrl, { token: proxy.token })).body, whole);
    await proxy.close();
    const record = await readProxyRecord(root.dir, runId);
    assert.equal(record.forwarded, 2);
    assert.deepEqual(record.usage, { input_tokens: 22, output_tokens: 14, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 6, unmetered: 0 });
  });

test('#0-313 AC8: the client\'s Authorization, X-Api-Key and Cookie and every header off the list never reach '
  + 'upstream, whose target is fixed; the key is set; the names dropped go to proxy.json, no value', async () => {
  const { proxy, runId } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  const answer = await send(proxy.baseUrl, { token: proxy.token, headers: { cookie: 'c=COOKIE-VALUE',
    'x-foo': 'FOO-VALUE', 'x-stainless-arch': 'x64', 'user-agent': 'claude-cli/2.1.328', 'anthropic-beta': 'b1',
    'accept-encoding': 'gzip', host: 'evil.example', 'x_odd': 'v' }, body: '{"marker":"BODY-MARKER"}' });
  assert.equal(answer.status, 200);
  const seen = anthropic.requests[start];
  assert.equal(seen.headers['x-api-key'], KEY, 'the key, set by the proxy');
  for (const name of ['authorization', 'cookie', 'x-foo', 'x_odd']) {
    assert.equal(seen.headers[name], undefined, name);
  }
  assert.equal(seen.headers.host, anthropic.upstream.hostname, 'the fixed target, whatever Host the client gave');
  assert.equal(seen.headers['accept-encoding'], 'identity');
  for (const name of [...REQUEST_HEADERS.filter((n) => n !== 'accept'), 'x-stainless-arch']) {
    assert.ok(seen.headers[name] !== undefined, name);
  }
  assert.equal(seen.url, '/v1/messages?beta=true');
  assert.equal(seen.body, '{"marker":"BODY-MARKER"}', 'the body streamed as it was');
  // The response: the proxy's list, set-cookie and the organization's id dropped.
  assert.equal(answer.headers['set-cookie'], undefined);
  assert.equal(answer.headers['anthropic-organization-id'], undefined);
  assert.equal(answer.headers['request-id'], 'req_fake');
  assert.ok(!JSON.stringify(answer).includes(KEY), 'the key in no response');
  // An absolute-form target or a Host of the client's moves nothing.
  const absolute = await send(proxy.baseUrl, { token: proxy.token, path: 'http://evil.example/v1/messages' });
  assert.equal(absolute.status, 404);
  await proxy.close();
  const record = await readProxyRecord(root.dir, runId);
  assert.deepEqual(record.droppedHeaders, ['x-foo'], 'by name; the credentials and hop-by-hop ones by rule');
  assert.equal(record.droppedHeadersUncounted, 1, 'x_odd: off the form, counted');
  assert.ok(!JSON.stringify(record).includes('VALUE') && !JSON.stringify(record).includes('BODY-MARKER'));
});

test('#0-313 AC8: past 32 names dropped, the rest are counted; a rate-limit header off its form is not kept', () => {
  const record = newRecord('20261122T170000Z-0d0313');
  noteDropped(record, Array.from({ length: NAMES_KEPT + 8 }, (_, i) => `x-h${i}`));
  noteDropped(record, ['x-h0', 'Bad', 'x'.repeat(65)]);
  assert.equal(record.droppedHeaders.length, NAMES_KEPT);
  assert.equal(record.droppedHeadersUncounted, 8 + 2);
  noteRateLimits(record, { 'anthropic-ratelimit-requests-remaining': '49', 'retry-after': '1',
    'anthropic-ratelimit-tokens-reset': '2026-11-22T17:00:00Z', 'anthropic-ratelimit-input-tokens-limit': 'many',
    'anthropic-ratelimit-x': '1\r\nInjected: 1', 'content-type': 'text/event-stream' });
  assert.deepEqual(record.rateLimits, { 'anthropic-ratelimit-requests-remaining': '49', 'retry-after': '1',
    'anthropic-ratelimit-tokens-reset': '2026-11-22T17:00:00Z' });
  assert.equal(record.rateLimitsDropped, 2);
});

test('#0-313 AC8: the rate-limit headers of a response reach proxy.json, and the client', async () => {
  const { proxy, runId } = await proxyOf();
  proxy.activate();
  anthropic.answer.headers = { 'anthropic-ratelimit-requests-remaining': '41', 'retry-after': '3' };
  try {
    const answer = await send(proxy.baseUrl, { token: proxy.token });
    assert.equal(answer.headers['anthropic-ratelimit-requests-remaining'], '41');
  } finally {
    anthropic.answer.headers = {};
  }
  await proxy.close();
  assert.deepEqual((await readProxyRecord(root.dir, runId)).rateLimits,
    { 'anthropic-ratelimit-requests-remaining': '41', 'retry-after': '3' });
});

test('#0-313 AC8: only POST /v1/messages, with no query or ?beta=true, is forwarded; any other is 404, logged by its '
  + 'path alone', async () => {
  const { proxy, lines } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  for (const [method, path] of [['HEAD', '/api/hello'], ['POST', '/v1/messages/count_tokens'],
    ['GET', '/v1/messages'], ['POST', '/v1/messages?beta=false'], ['POST', '/v1/messages?beta=true&x=QUERY-VALUE'],
    ['POST', '/v1/complete'], ['POST', '/v1/messages/']]) {
    const answer = await send(proxy.baseUrl, { method, path, token: proxy.token });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.equal(answer.headers['x-should-retry'], 'false');
    if (method !== 'HEAD') {
      assert.equal(errorOf(answer).error.type, 'not_found_error');
    }
  }
  assert.equal(anthropic.requests.length, start, 'none reached upstream');
  assert.equal((await send(proxy.baseUrl, { path: '/v1/messages', token: proxy.token })).status, 200);
  // One line per reason in 10 s: the first refused path is named, the query never.
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `dispatcher proxy: run ${proxyRun(lines[0])}: refused (path) "/api/hello"\n`);
  assert.ok(lines.every((line) => !line.includes('QUERY-VALUE') && !line.includes('?')));
  // A first refusal whose path has a query: the line names the path before it, and nothing after.
  const fresh = await proxyOf();
  fresh.proxy.activate();
  await send(fresh.proxy.baseUrl, { path: '/v1/messages/x?secret=QUERY-VALUE#frag', token: fresh.proxy.token });
  assert.equal(fresh.lines[0], `dispatcher proxy: run ${proxyRun(fresh.lines[0])}: refused (path) "/v1/messages/x"\n`);
});

const proxyRun = (line) => /run (\S+):/.exec(line)[1];

test('#0-313 AC8: a refusal is logged once per 10 s per run and reason, the next line counting those skipped; no '
  + 'header, query or body of the request\'s', async () => {
  let now = 0;
  const lines = [];
  const log = refusalLog({ write: (line) => lines.push(line), runId: 'R', now: () => now });
  log('refused (no-token)');
  log('refused (no-token)');
  log('refused (path)', '"/x"');
  log('refused (no-token)');
  now += LOG_EVERY_MS;
  log('refused (no-token)');
  assert.deepEqual(lines, ['dispatcher proxy: run R: refused (no-token)\n',
    'dispatcher proxy: run R: refused (path) "/x"\n',
    'dispatcher proxy: run R: refused (no-token) (2 more like it not logged)\n']);
  const { proxy, lines: logged } = await proxyOf();
  proxy.activate();
  for (let i = 0; i < 5; i += 1) {
    await send(proxy.baseUrl, { headers: { 'x-api-key': `WRONG-${i}`, cookie: 'COOKIE-VALUE' },
      path: '/v1/messages?secret=QUERY-VALUE', body: 'BODY-MARKER' });
  }
  assert.equal(logged.length, 1, 'five refusals, one line');
  assert.ok(logged.every((line) => !/WRONG|COOKIE|QUERY|BODY/.test(line)), logged.join(''));
});

test('#0-313 AC8: past IN_FLIGHT requests at once, one more is 429 with Retry-After: 1 and X-Should-Retry: true',
  async () => {
    assert.equal(IN_FLIGHT, 4);
    const { proxy } = await proxyOf();
    proxy.activate();
    const release = anthropic.hold();
    const held = Array.from({ length: IN_FLIGHT }, () => send(proxy.baseUrl, { token: proxy.token }));
    const start = Date.now();
    while (anthropic.requests.filter((r) => !r.closedEarly).length < IN_FLIGHT && Date.now() - start < 5000) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    // Answered at once by the proxy, never held by upstream: past the limit it does not reach upstream.
    const over = await Promise.race([send(proxy.baseUrl, { token: proxy.token }),
      new Promise((resolve) => { setTimeout(() => resolve({ error: 'held: it reached upstream' }), 3000); })]);
    release();
    assert.equal(over.status, 429);
    assert.equal(errorOf(over).error.type, 'rate_limit_error');
    assert.equal(over.headers['retry-after'], '1');
    assert.equal(over.headers['x-should-retry'], 'true');
    for (const answer of await Promise.all(held)) {
      assert.equal(answer.status, 200);
    }
    assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200, 'the slots free again');
  });

test('#0-313 AC8: a client gone ends the upstream request; a body past the limit is 413; upstream out of reach is 503 '
  + 'with Retry-After', async () => {
  const { proxy } = await proxyOf();
  proxy.activate();
  const release = anthropic.hold();
  const start = anthropic.requests.length;
  await send(proxy.baseUrl, { token: proxy.token, onFirst: (_, req) => req.destroy() });
  const deadline = Date.now() + 5000;
  while (!anthropic.requests[start]?.closedEarly && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  release();
  assert.equal(anthropic.requests[start].closedEarly, true, 'upstream\'s request ended with the client');
  const large = await send(proxy.baseUrl, { token: proxy.token,
    headers: { 'content-length': String(BODY_LIMIT + 1) }, body: '' });
  assert.equal(large.status, 413);
  assert.equal(large.headers['x-should-retry'], 'false');
  const dead = await proxyOf({ upstream: { protocol: 'http:', hostname: '127.0.0.1', port: 9 } });
  dead.proxy.activate();
  const unreachable = await send(dead.proxy.baseUrl, { token: dead.proxy.token });
  assert.equal(unreachable.status, 503);
  assert.equal(errorOf(unreachable).error.type, 'overloaded_error');
  assert.equal(unreachable.headers['retry-after'], '1');
  assert.equal(unreachable.headers['x-should-retry'], 'true');
});

test('#0-313 AC3: the meter holds one line at most and counts a response it cannot read as unmetered', () => {
  const record = newRecord('20261122T170000Z-0d0313');
  // A data line of message_start past METER_LINE, its usage valid: dropped, not held to be read.
  const long = sseMeter(record);
  long.feed(Buffer.from('event: message_start\ndata: {"message":{"usage":{"input_tokens":5}},"pad":"'));
  long.feed(Buffer.alloc(METER_LINE + 1, 'x'));
  long.feed(Buffer.from('"}\n\n'));
  long.end();
  const bad = sseMeter(record);
  bad.feed(Buffer.from('event: message_start\ndata: {"message":{"usage":{"input_tokens":-1}}}\n\n'));
  bad.end();
  const none = sseMeter(record);
  none.feed(Buffer.from('event: ping\ndata: {}\n\n'));
  none.end();
  assert.equal(record.usage.unmetered, 3);
  assert.equal(record.usage.input_tokens, 0);
});

// The body's filter (review round 1 of factory#29, sec-5a7e). Until the owner's shape measurement on the pinned Claude
// Code is committed as a fixture, the request that passes is one made here in a call's form: client tools with no
// type, one custom tool, an allowed beta.
const CLIENT_CALL = { model: 'claude-opus-5-5', max_tokens: 32000, stream: true, system: [{ type: 'text', text: 's' }],
  messages: [{ role: 'user', content: 'TEXT-OF-THE-PROMPT' }], metadata: { user_id: 'u' },
  tools: [{ name: 'Bash', description: 'd', input_schema: { type: 'object' } },
    { type: 'custom', name: 'StructuredOutput', description: 'd', input_schema: { type: 'object' } }] };

test('review round 1 of factory#29, sec-5a7e: only a body of client tools and the measured betas reaches upstream; '
  + 'a server tool, an MCP connector, an unknown beta, a body that is no JSON object, or one past the limit sent '
  + 'chunked, is 400 (413) with nothing upstream, counted by reason, logged by reason alone', async () => {
  const { proxy, runId, lines } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  const passed = await send(proxy.baseUrl, { token: proxy.token, body: JSON.stringify(CLIENT_CALL),
    headers: { 'anthropic-beta': 'b1,beta-allowed-2025' } });
  assert.equal(passed.status, 200);
  assert.equal(anthropic.requests.length, start + 1);
  // What goes upstream is the checked value, serialized again (review round 2 of factory#29): the same value.
  assert.deepEqual(JSON.parse(anthropic.requests[start].body), CLIENT_CALL, 'the body\'s value as it was sent');
  assert.equal(anthropic.requests[start].headers['content-length'],
    String(Buffer.byteLength(JSON.stringify(CLIENT_CALL))));
  const withTools = (...tools) => JSON.stringify({ ...CLIENT_CALL, tools });
  const cases = [
    ['server-tool', withTools({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 })],
    ['server-tool', withTools({ type: 'web_fetch_20250910', name: 'web_fetch' })],
    ['server-tool', withTools(CLIENT_CALL.tools[0], { type: 'bash_20250124', name: 'bash' })],
    ['server-tool', withTools({ type: 'TOOL-TYPE-MARKER', name: 'TOOL-NAME-MARKER' })],
    ['server-tool', withTools({ type: null, name: 'x' })],
    ['server-tool', withTools('a string')],
    ['tools-not-list', JSON.stringify({ ...CLIENT_CALL, tools: { name: 'x' } })],
    ['mcp-servers', JSON.stringify({ ...CLIENT_CALL, mcp_servers: [{ type: 'url', url: 'https://MCP-MARKER' }] })],
    ['mcp-servers', JSON.stringify({ ...CLIENT_CALL, mcp_servers: null })],
    ['mcp-servers', JSON.stringify({ ...CLIENT_CALL, mcp_servers: [] })],
    ['body-not-object', '[]'],
    ['body-not-object', 'null'],
    ['body-not-object', '"BODY-MARKER"'],
    ['body-not-json', '{"model":'],
    ['body-not-json', ''],
  ];
  for (const [reason, body] of cases) {
    const answer = await send(proxy.baseUrl, { token: proxy.token, body });
    assert.equal(answer.status, 400, `${reason}: ${body.slice(0, 60)}`);
    assert.equal(errorOf(answer).error.type, 'invalid_request_error');
    assert.equal(answer.headers['x-should-retry'], 'false');
  }
  for (const beta of ['BETA-MARKER', 'b1,BETA-MARKER', 'b1,', ' , b1', 'B1']) {
    const answer = await send(proxy.baseUrl, { token: proxy.token, body: JSON.stringify(CLIENT_CALL),
      headers: { 'anthropic-beta': beta } });
    assert.equal(answer.status, 400, beta);
  }
  // Past the limit with no content-length (chunked): refused as it comes, nothing upstream.
  const { BODY_LIMIT: limit } = await import('../src/proxy/upstream.mjs');
  const chunked = await new Promise((resolve) => {
    const url = new URL(proxy.baseUrl);
    const req = request({ host: url.hostname, port: url.port, method: 'POST', path: '/v1/messages',
      headers: { 'x-api-key': proxy.token, 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('error'));
    const piece = Buffer.alloc(1024 * 1024, 'x');
    let sent = 0;
    const more = () => {
      while (sent <= limit) {
        sent += piece.length;
        if (!req.write(piece)) {
          req.once('drain', more);
          return;
        }
      }
      req.end();
    };
    more();
  });
  assert.ok(chunked === 413 || chunked === 'error', String(chunked));
  assert.equal(anthropic.requests.length, start + 1, 'nothing refused reached upstream');
  await proxy.close();
  const record = await readProxyRecord(root.dir, runId);
  assert.deepEqual(record.refused, { 'server-tool': 6, 'tools-not-list': 1, 'mcp-servers': 3, 'body-not-object': 3,
    'body-not-json': 2, beta: 5, ...(chunked === 413 ? { 'body-too-large': 1 } : {}) });
  assert.equal(record.forwarded, 1);
  const logged = lines.join('');
  for (const marker of ['MARKER', 'web_search', 'web_fetch', 'bash_2025', 'TEXT-OF-THE-PROMPT', 'b1']) {
    assert.ok(!logged.includes(marker), `the log names no ${marker}`);
  }
  assert.ok(!JSON.stringify(record).includes('MARKER'), 'nor the record');
});

test('review round 1 of factory#29, sec-5a7e: the filter\'s rules one by one, and the betas a proxy must be given',
  async () => {
    const { requestRefusal, FILTER_REASONS } = await import('../src/proxy/request-filter.mjs');
    const check = (body, beta, betas = BETAS) => requestRefusal({ body: Buffer.from(body), beta, betas });
    assert.equal(check(JSON.stringify(CLIENT_CALL), undefined), null);
    assert.equal(check(JSON.stringify(CLIENT_CALL), 'b1'), null);
    assert.equal(check(JSON.stringify(CLIENT_CALL), ['b1', 'beta-allowed-2025']), null, 'a repeated header');
    assert.equal(check(JSON.stringify(CLIENT_CALL), 'b1', []), 'beta', 'an empty list allows no beta');
    assert.equal(check(JSON.stringify({ model: 'm' }), undefined), null, 'no tools at all');
    assert.equal(check(JSON.stringify({ tools: [] }), undefined), null);
    assert.equal(check(JSON.stringify({ tools: [{ type: 'custom', name: 'x' }] }), undefined), null);
    assert.deepEqual(FILTER_REASONS, ['body-not-json', 'body-not-object', 'mcp-servers', 'tools-not-list',
      'server-tool', 'content-source', 'beta']);
    await assert.rejects(startProxy({ addr: ADDR, ports: testPorts(), key: KEY, runId: '20261123T100000Z-0d0313',
      stateDir: root.dir, err: { write() {} } }), TypeError);
  });

test('review round 2 of factory#29, sec-c41e: a content source other than base64 or text, in a message, a '
  + 'tool_result\'s content at any depth or the system, is 400 content-source with nothing upstream; base64 and text '
  + 'pass', async () => {
  const { proxy, runId } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  const user = (...content) => JSON.stringify({ ...CLIENT_CALL, messages: [{ role: 'user', content }] });
  const image = (type) => ({ type: 'image', source: { type, media_type: 'image/png', data: 'AAAA',
    url: 'https://URL-MARKER' } });
  const refused = [
    user({ type: 'image', source: { type: 'url', url: 'https://URL-MARKER/a.png' } }),
    user({ type: 'document', source: { type: 'url', url: 'https://URL-MARKER/a.pdf' } }),
    user({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x' },
      { type: 'image', source: { type: 'url', url: 'https://URL-MARKER' } }] }),
    user({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_result', content: [image('url')] }] }),
    user({ type: 'document', source: { type: 'file', file_id: 'file_1' } }),
    user({ type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'x' }] } }),
    user({ type: 'image', source: 'https://URL-MARKER' }),
    user({ type: 'image', source: null }),
    JSON.stringify({ ...CLIENT_CALL, system: [{ type: 'text', text: 's' }, { type: 'document', source: { type: 'url',
      url: 'https://URL-MARKER' } }] }),
  ];
  for (const body of refused) {
    const answer = await send(proxy.baseUrl, { token: proxy.token, body });
    assert.equal(answer.status, 400, body.slice(0, 120));
    assert.equal(errorOf(answer).error.type, 'invalid_request_error');
  }
  assert.equal(anthropic.requests.length, start, 'nothing upstream');
  for (const body of [user(image('base64')), user({ type: 'document', source: { type: 'text', media_type: 'text/plain',
    data: 'x' } }), user({ type: 'tool_result', tool_use_id: 't', content: [image('base64')] }),
  JSON.stringify({ ...CLIENT_CALL, system: 'a system as a string' })]) {
    assert.equal((await send(proxy.baseUrl, { token: proxy.token, body })).status, 200, body.slice(0, 120));
  }
  await proxy.close();
  const record = await readProxyRecord(root.dir, runId);
  assert.equal(record.refused['content-source'], refused.length);
  assert.equal(record.forwarded, 4);
});

test('review round 2 of factory#29: what goes upstream is the value the filter checked: a key given twice is sent '
  + 'as the one checked, never as the raw bytes', async () => {
  const { proxy } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  const raw = '{"model":"m","messages":[],"tools":[{"name":"x","type":"web_search_20250305","type":"custom"}]}';
  assert.equal((await send(proxy.baseUrl, { token: proxy.token, body: raw })).status, 200);
  const sent = anthropic.requests[start];
  assert.deepEqual(JSON.parse(sent.body), { model: 'm', messages: [], tools: [{ name: 'x', type: 'custom' }] });
  assert.ok(!sent.body.includes('web_search'), 'the raw bytes are not what is sent');
  assert.equal(sent.headers['content-length'], String(Buffer.byteLength(sent.body)));
  // Bytes that are no UTF-8: sent as what the check read (replacement characters), valid UTF-8.
  const bad = Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","messages":[]}')]);
  const answer = await new Promise((resolve) => {
    const url = new URL(proxy.baseUrl);
    const req = request({ host: url.hostname, port: url.port, method: 'POST', path: '/v1/messages',
      headers: { 'x-api-key': proxy.token, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.end(bad);
  });
  assert.equal(answer, 200);
  assert.equal(JSON.parse(anthropic.requests[start + 1].body).model, '\ufffd\ufffd');
});

test('review round 2 of factory#29: a client gone before its body is whole sends nothing upstream and is not counted '
  + 'as forwarded', async () => {
  const { proxy, runId } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  await new Promise((resolve) => {
    const url = new URL(proxy.baseUrl);
    const req = request({ host: url.hostname, port: url.port, method: 'POST', path: '/v1/messages',
      headers: { 'x-api-key': proxy.token, 'content-length': '1000' } });
    req.on('error', () => resolve());
    req.write('{"model":');
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  await proxy.close();
  assert.equal(anthropic.requests.length, start, 'nothing upstream');
  assert.equal((await readProxyRecord(root.dir, runId)).forwarded, 0);
});

test('review round 2 of factory#29 (FAC-A01): the filter\'s reasons are each a key of proxy.json\'s refused, so a '
  + 'reason added in one place and not the other fails here, not in a record on the VM', async () => {
  const { FILTER_REASONS } = await import('../src/proxy/request-filter.mjs');
  const schema = JSON.parse(await readFile(new URL('../src/state/proxy.schema.json', import.meta.url), 'utf8'));
  const keys = Object.keys(schema.properties.refused.properties);
  for (const reason of FILTER_REASONS) {
    assert.ok(keys.includes(reason), reason);
  }
  // And every other key is a refusal of the server's own.
  const own = ['no-token', 'credentials-differ', 'unknown-token', 'token-not-active', 'path', 'in-flight',
    'body-too-large', 'upstream'];
  assert.deepEqual([...keys].sort(), [...own, ...FILTER_REASONS].sort());
});
