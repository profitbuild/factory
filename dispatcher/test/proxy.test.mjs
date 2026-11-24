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
function send(baseUrl, {
  method = 'POST', path = '/v1/messages?beta=true', headers = {}, body = '{"messages":[]}', token, onFirst,
} = {}) {
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
    'accept-encoding': 'gzip', host: 'evil.example', 'x_odd': 'v' }, body: '{"messages":[],"marker":"BODY-MARKER"}' });
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
  assert.equal(seen.body, '{"messages":[],"marker":"BODY-MARKER"}', 'the body as it was sent');
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
    assert.equal(check(JSON.stringify({ model: 'm', messages: [] }), undefined), null, 'no tools at all');
    assert.equal(check(JSON.stringify({ messages: [], tools: [] }), undefined), null);
    assert.equal(check(JSON.stringify({ messages: [], tools: [{ type: 'custom', name: 'x' }] }), undefined), null);
    assert.deepEqual(FILTER_REASONS, ['body-not-json', 'body-not-object', 'depth', 'size', 'messages-form',
      'mcp-servers', 'tools-not-list', 'server-tool', 'content-type', 'content-source', 'content-file', 'beta',
      'invalid']);
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
  // The headers and part of the body written (the write's callback: they left this side), then the client gone.
  await new Promise((resolve) => {
    const url = new URL(proxy.baseUrl);
    const req = request({ host: url.hostname, port: url.port, method: 'POST', path: '/v1/messages',
      headers: { 'x-api-key': proxy.token, 'content-length': '1000' } });
    req.on('error', () => {});
    req.write('{"model":', () => { req.destroy(); resolve(); });
  });
  // Waited for by the proxy's own count of it (review round 3 of factory#29, GEN-07), never a fixed delay: a client
  // the proxy never saw would leave gone at 0, and the test would fail, not pass for the wrong reason.
  let record;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    record = await readProxyRecord(root.dir, runId);
    if (record.gone === 1) {
      break;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  await proxy.close();
  assert.equal(record.gone, 1, 'the proxy saw the client go before its body');
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
    'body-too-large', 'upstream', 'internal'];
  assert.deepEqual([...keys].sort(), [...own, ...FILTER_REASONS].sort());
});

/** A request of a call's shape in the fixture (the owner's measurement, 2026-11-24), its values made up. */
const readFixture = async () => JSON.parse(await readFile(new URL(
  '../testing/fixtures/claude-code-2.1.328-request-shape.json', import.meta.url), 'utf8'));

async function measuredCall(call) {
  const block = (shape) => ({ type: shape.type, ...(shape.type === 'text' ? { text: 't' } : {}) });
  const content = (shape) => (shape === 'string' ? 's' : shape.map(block));
  const values = { context_management: {}, max_tokens: 1, metadata: { user_id: 'u' }, model: 'claude-opus-5-5',
    output_config: {}, stream: true, thinking: {}, system: content(call.system),
    messages: call.messages.map((m) => ({ role: m.role, content: content(m.content) })),
    tools: call.tools.map((tool, i) => Object.fromEntries(tool.keys.map((key) => [key, { name: `tool-${i}`,
      description: 'd', input_schema: { type: 'object' }, defer_loading: true }[key]]))) };
  assert.deepEqual(Object.keys(values).sort(), call.bodyKeys, 'every key of the measured body, and no other');
  const headers = Object.fromEntries(call.headerNames.filter((name) => !['authorization', 'x-api-key', 'host',
    'connection', 'content-length'].includes(name)).map((name) => [name, name === 'anthropic-beta'
    ? call.betas.join(',') : name === 'content-type' ? 'application/json' : 'v']));
  return { call, body: JSON.stringify(values), headers };
}

test('#0-313 (the owner\'s measurement, 2026-11-24): the call Claude Code 2.1.328 makes passes the filter whole, its '
  + 'betas those of expectations.json; the headers it sends off the list are dropped and named', async () => {
  const fixture = await readFixture();
  const { readExpectations } = await import('../src/flow/expectations.mjs');
  const { anthropicBetas, claudeCodeVersion } = await readExpectations();
  // The fixture's version is the pin's (review round 3 of factory#29, FAC-A01): a bump with no new measurement fails.
  assert.equal(fixture.claudeCodeVersion, claudeCodeVersion);
  assert.deepEqual(fixture.calls.map((c) => c.variant), ['A', 'B'], 'both variants of the measurement');
  for (const measured of fixture.calls) {
    const { call, body, headers } = await measuredCall(measured);
    assert.deepEqual([...anthropicBetas].sort(), [...call.betas].sort(), 'the list is the measured one');
    assert.ok(call.tools.every((tool) => !tool.keys.includes('type')), 'no tool of the call is typed');
    const { filterRequest } = await import('../src/proxy/request-filter.mjs');
    const checked = filterRequest({ body: Buffer.from(body), beta: headers['anthropic-beta'], betas: anthropicBetas });
    assert.equal(checked.reason, null);
    next += 1;
    const runId = `20261124T19${String(next).padStart(4, '0')}Z-0d0313`;
    await mkdir(join(root.dir, 'tasks', runId), { recursive: true, mode: 0o700 });
    const proxy = await startProxy({ addr: ADDR, ports: testPorts(), key: KEY, betas: anthropicBetas, runId,
      stateDir: root.dir, err: { write() {} }, proxyTesting: { upstream: anthropic.upstream } });
    proxy.activate();
    const start = anthropic.requests.length;
    const answer = await send(proxy.baseUrl, { token: proxy.token, headers, body });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(anthropic.requests[start].body), JSON.parse(body));
    assert.equal(anthropic.requests[start].headers['anthropic-beta'], call.betas.join(','));
    await proxy.close();
    // The measured headers off the list (review of #0-313's plan, E): known now, dropped knowingly; AC4 shows whether
    // a call answers without them.
    assert.deepEqual((await readProxyRecord(root.dir, runId)).droppedHeaders.sort(),
      ['anthropic-dangerous-direct-browser-access', 'x-app', 'x-claude-code-session-id']);
  }
});

// Review round 3 of factory#29, sec-d3e7 (a regression of round 2): a hostile tree in the body must neither throw out
// of the filter nor leave the handler a rejection, at any layer.
const nested = (n) => `${'['.repeat(n)}${']'.repeat(n)}`;

test('review round 3 of factory#29, sec-d3e7: a body nested 100 000 deep, under messages, metadata or a tool\'s '
  + 'input_schema, is 400 depth with nothing upstream, and the proxy answers the next call', async () => {
  const { MAX_DEPTH } = await import('../src/proxy/request-filter.mjs');
  assert.equal(MAX_DEPTH, 64);
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const { proxy, runId } = await proxyOf();
    proxy.activate();
    const start = anthropic.requests.length;
    for (const body of [`{"messages":[{"role":"user","content":${nested(100_000)}}]}`,
      `{"messages":[],"metadata":${nested(100_000)}}`,
      `{"messages":[],"tools":[{"name":"x","input_schema":${nested(100_000)}}]}`]) {
      assert.ok(Buffer.byteLength(body) < 32 * 1024 * 1024);
      const answer = await send(proxy.baseUrl, { token: proxy.token, body });
      assert.equal(answer.status, 400);
      assert.equal(errorOf(answer).error.type, 'invalid_request_error');
      assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200, 'the proxy answers the next call');
    }
    assert.equal(anthropic.requests.length, start + 3, 'only the three good calls went upstream');
    await proxy.close();
    assert.equal((await readProxyRecord(root.dir, runId)).refused.depth, 3);
    assert.deepEqual(rejections, [], 'no rejection left');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('review round 3 of factory#29, sec-d3e7: a body at MAX_DEPTH passes, one level deeper is refused, under any key',
  async () => {
    const { MAX_DEPTH, filterRequest } = await import('../src/proxy/request-filter.mjs');
    const check = (body) => filterRequest({ body: Buffer.from(body), betas: [] }).reason;
    // The body is one level, metadata's value the next: n nested arrays make 1 + n.
    assert.equal(check(`{"messages":[],"metadata":${nested(MAX_DEPTH - 1)}}`), null);
    assert.equal(check(`{"messages":[],"metadata":${nested(MAX_DEPTH)}}`), 'depth');
    assert.equal(check(`{"messages":[{"content":[{"type":"tool_result","content":${nested(MAX_DEPTH)}}]}]}`), 'depth');
    assert.equal(check(`{"messages":[],"x":{"a":${'{"a":'.repeat(MAX_DEPTH)}1${'}'.repeat(MAX_DEPTH)}}}`), 'depth',
      'objects count as arrays do');
  });

test('review round 3 of factory#29, sec-d3e7: filterRequest turns any exception into a refusal (invalid), never a '
  + 'throw', async () => {
  const { filterRequest } = await import('../src/proxy/request-filter.mjs');
  // A beta that is no string makes split throw: caught inside filterRequest, whatever throws.
  assert.deepEqual(filterRequest({ body: Buffer.from('{"messages":[]}'), beta: 42, betas: [] }),
    { reason: 'invalid', json: null });
  assert.deepEqual(filterRequest({ body: Buffer.from('{"messages":[]}'), betas: null, beta: 'b' }),
    { reason: 'invalid', json: null });
});

test('review round 3 of factory#29, sec-d3e7: whatever throws in a request\'s handling is 500 api_error, '
  + 'X-Should-Retry false, logged by its reason, with no rejection left and the proxy still answering', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    next += 1;
    const runId = `20261124T20${String(next).padStart(4, '0')}Z-0d0313`;
    await mkdir(join(root.dir, 'tasks', runId), { recursive: true, mode: 0o700 });
    const lines = [];
    const proxy = await startProxy({ addr: ADDR, ports: testPorts(), key: KEY, betas: BETAS, runId, stateDir: root.dir,
      err: { write: (line) => lines.push(line) }, proxyTesting: { upstream: anthropic.upstream,
        filter: () => { throw new RangeError('agent-words: Maximum call stack size exceeded'); } } });
    proxy.activate();
    for (let i = 0; i < 2; i += 1) {
      const answer = await send(proxy.baseUrl, { token: proxy.token });
      assert.equal(answer.status, 500);
      assert.equal(errorOf(answer).error.type, 'api_error');
      assert.equal(answer.headers['x-should-retry'], 'false');
    }
    await proxy.close();
    assert.equal((await readProxyRecord(root.dir, runId)).refused.internal, 2);
    assert.ok(lines.every((line) => !line.includes('agent-words')), lines.join(''));
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(rejections, [], 'no rejection left');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('review round 3 of factory#29: messages must be an array of objects each with a string or array content, and '
  + 'no object of the content may carry a file_id', async () => {
  const { filterRequest } = await import('../src/proxy/request-filter.mjs');
  const check = (value) => filterRequest({ body: Buffer.from(JSON.stringify(value)), betas: [] }).reason;
  for (const value of [{}, { messages: {} }, { messages: 'x' }, { messages: [1] }, { messages: [null] },
    { messages: [{ role: 'user' }] }, { messages: [{ role: 'user', content: 3 }] },
    { messages: [{ role: 'user', content: { type: 'text', text: 't' } }] }]) {
    assert.equal(check(value), 'messages-form', JSON.stringify(value));
  }
  const user = (...content) => ({ messages: [{ role: 'user', content }] });
  // A container_upload block is refused by its type since round 4 (content-type); a file_id on an allowed block, or
  // on its source, by this rule.
  for (const value of [user({ type: 'text', text: 't', file_id: 'file_1' }),
    user({ type: 'tool_result', content: [{ type: 'document', file_id: 'file_1',
      source: { type: 'text', data: 'x' } }] }),
    user({ type: 'image', source: { type: 'base64', data: 'AAAA', file_id: 'file_1' } }),
    { messages: [], system: [{ type: 'text', text: 's' }, { type: 'text', text: 's', file_id: 'f' }] }]) {
    assert.equal(check(value), 'content-file', JSON.stringify(value));
  }
  assert.equal(check(user({ type: 'container_upload', file_id: 'file_1' })), 'content-type');
  assert.equal(check(user({ type: 'text', text: 'a file_id in words only' })), null);
});

// Review round 4 of factory#29: the content's block types, the body's nodes, and the callbacks of upstream's listeners.

test('review round 4 of factory#29 (FAC-S02): a content block of a type off BLOCK_TYPES, or with none, is 400 '
  + 'content-type, nested in a tool_result too, nothing upstream; each allowed type passes', async () => {
  const { BLOCK_TYPES, filterRequest } = await import('../src/proxy/request-filter.mjs');
  assert.deepEqual(BLOCK_TYPES, ['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking',
    'redacted_thinking']);
  const check = (value) => filterRequest({ body: Buffer.from(JSON.stringify(value)), betas: [] }).reason;
  const user = (...content) => ({ messages: [{ role: 'user', content }] });
  const nestedIn = (block) => user({ type: 'tool_result', tool_use_id: 't', content: [block] });
  for (const block of [{ type: 'server_tool_use', id: 's', name: 'web_fetch', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 's', content: [] }, { type: 'mcp_tool_use', id: 'm', name: 'x' },
    { type: 'container_upload', file_id: 'f' }, { type: 'TYPE-MARKER' }, { text: 'no type' }, { type: 3 }, 'a string',
    ['an array']]) {
    assert.equal(check(user(block)), 'content-type', JSON.stringify(block));
    assert.equal(check(nestedIn(block)), 'content-type', `nested: ${JSON.stringify(block)}`);
    assert.equal(check({ messages: [], system: [block] }), 'content-type', `system: ${JSON.stringify(block)}`);
  }
  assert.equal(check(user({ type: 'tool_result', tool_use_id: 't', content: { type: 'text' } })), 'content-type',
    'a content that is neither a string nor an array');
  for (const block of [{ type: 'text', text: 't' }, { type: 'image', source: { type: 'base64', data: 'A' } },
    { type: 'document', source: { type: 'text', data: 'x' } }, { type: 'tool_use', id: 'u', name: 'Bash', input: {} },
    { type: 'tool_result', tool_use_id: 'u', content: 'string' }, { type: 'thinking', thinking: 't', signature: 's' },
    { type: 'redacted_thinking', data: 'x' }]) {
    assert.equal(check(user(block)), null, block.type);
  }
  // Through the proxy: refused, nothing upstream.
  const { proxy } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  const answer = await send(proxy.baseUrl, { token: proxy.token,
    body: JSON.stringify(nestedIn({ type: 'server_tool_use', id: 's', name: 'web_fetch', input: {} })) });
  assert.equal(answer.status, 400);
  assert.equal(anthropic.requests.length, start);
  await proxy.close();
});

test('review round 4 of factory#29 (SEC-21): a body of MAX_NODES + 1 arrays is 400 size on its bytes, nothing '
  + 'upstream, the next call 200; one at the limit passes; the parsed tree is held to it too', async () => {
  const { MAX_NODES, filterRequest, treeBounds, byteShape } = await import('../src/proxy/request-filter.mjs');
  assert.equal(MAX_NODES, 100_000);
  // The body, messages and metadata: three nodes, then n empty arrays.
  const flat = (n) => `{"messages":[],"metadata":[${Array(n).fill('[]').join(',')}]}`;
  assert.equal(filterRequest({ body: Buffer.from(flat(MAX_NODES - 3)), betas: [] }).reason, null, 'at the limit');
  assert.equal(filterRequest({ body: Buffer.from(flat(MAX_NODES - 2)), betas: [] }).reason, 'size');
  assert.equal(byteShape(Buffer.from(flat(MAX_NODES - 2))), 'size', 'refused on the bytes, before JSON.parse');
  // Before JSON.parse: a body past the limit and no JSON at all is refused by its size, never parsed.
  assert.equal(filterRequest({ body: Buffer.from(`${flat(MAX_NODES)}not JSON`), betas: [] }).reason, 'size');
  assert.equal(byteShape(Buffer.from(`{"messages":[],"s":"${'['.repeat(MAX_NODES + 1)}"}`)), null,
    'brackets in a string are no nodes');
  assert.equal(byteShape(Buffer.from('{"s":"\\"[[[","messages":[]}')), null, 'an escaped quote keeps the string open');
  // The second layer, on the tree, whatever the bytes said.
  assert.equal(treeBounds({ messages: [], metadata: Array.from({ length: MAX_NODES }, () => []) }), 'size');
  assert.equal(treeBounds({ messages: [], metadata: Array.from({ length: MAX_NODES - 3 }, () => []) }), null);
  const { proxy, runId } = await proxyOf();
  proxy.activate();
  const start = anthropic.requests.length;
  assert.equal((await send(proxy.baseUrl, { token: proxy.token, body: flat(MAX_NODES) })).status, 400);
  assert.equal(anthropic.requests.length, start, 'nothing upstream');
  assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200, 'the next call');
  await proxy.close();
  assert.equal((await readProxyRecord(root.dir, runId)).refused.size, 1);
});

/** A proxy with test's own callbacks (proxyTesting): the record and the log lines kept. */
async function proxyWith(proxyTesting) {
  next += 1;
  const runId = `20261124T21${String(next).padStart(4, '0')}Z-0d0313`;
  await mkdir(join(root.dir, 'tasks', runId), { recursive: true, mode: 0o700 });
  const lines = [];
  const proxy = await startProxy({ addr: ADDR, ports: testPorts(), key: KEY, betas: BETAS, runId, stateDir: root.dir,
    err: { write: (line) => lines.push(line) }, proxyTesting: { upstream: anthropic.upstream, ...proxyTesting } });
  proxy.activate();
  return { proxy, runId, lines };
}

test('review round 4 of factory#29 (SEC-21): a callback that counts a response and throws (the rate-limit headers, '
  + 'the stream\'s meter) stops that count, never the stream: the client gets the whole answer, the next call 200',
async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const whole = sseAnswer().join('');
    for (const accounting of [
      { noteRateLimits: () => { throw new Error('agent-words in a header'); } },
      { sseMeter: () => ({ feed() { throw new Error('agent-words in a chunk'); }, end() {} }) },
      { sseMeter: () => ({ feed() {}, end() { throw new Error('agent-words at the end'); } }) },
    ]) {
      const { proxy, runId, lines } = await proxyWith({ accounting });
      const answer = await send(proxy.baseUrl, { token: proxy.token });
      assert.equal(answer.status, 200);
      assert.equal(answer.body, whole, 'the stream went on');
      assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200, 'the next call');
      await proxy.close();
      const record = await readProxyRecord(root.dir, runId);
      assert.ok(record.accountingErrors >= 2, JSON.stringify(record));
      assert.ok(lines.every((line) => !line.includes('agent-words')), lines.join(''));
    }
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('review round 4 of factory#29 (SEC-21): a listener of upstream\'s response that throws past the callbacks '
  + 'destroys both sides, counted internal; an exception after the headers went ends the socket; the proxy answers '
  + 'the next call', async () => {
  const { forward } = await import('../src/proxy/upstream.mjs');
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    let calls = 0;
    // The first exchange's onResponse, and the second's onChunk, throw inside upstream's listeners, unguarded (faults
    // past the callbacks); the third throws after forward is over, its headers gone; the fourth is as it comes.
    const { proxy, runId, lines } = await proxyWith({ forward: async (options) => {
      calls += 1;
      if (calls === 1) {
        return forward({ ...options, onResponse: () => { throw new Error('agent-words in a listener'); } });
      }
      if (calls === 2) {
        return forward({ ...options, onChunk: () => { throw new Error('agent-words in a chunk\'s listener'); } });
      }
      if (calls === 3) {
        await forward(options);
        throw new Error('agent-words after the headers');
      }
      return forward(options);
    } });
    const first = await send(proxy.baseUrl, { token: proxy.token });
    assert.ok(first.error !== undefined || first.status === 200, JSON.stringify(first).slice(0, 80));
    const second = await send(proxy.baseUrl, { token: proxy.token });
    assert.ok(second.error !== undefined || second.status === 200, JSON.stringify(second).slice(0, 80));
    const third = await send(proxy.baseUrl, { token: proxy.token });
    assert.ok(third.error !== undefined || third.status === 200, JSON.stringify(third).slice(0, 80));
    assert.equal((await send(proxy.baseUrl, { token: proxy.token })).status, 200, 'the next call');
    await proxy.close();
    assert.equal((await readProxyRecord(root.dir, runId)).refused.internal, 3);
    assert.ok(lines.every((line) => !line.includes('agent-words')), lines.join(''));
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});
