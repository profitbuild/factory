/**
 * The proxy's upstream (incident-platform backlog #0-313, AC3 and AC8): Anthropic's API, one fixed target, and the
 * headers that cross the proxy each way.
 *
 * - The target is UPSTREAM, https://api.anthropic.com:443, its Host and TLS server name fixed: never taken from the
 *   request (its Host, an absolute-form target, a header). A test gives a fake one (proxyTesting.upstream, plain
 *   http on the loopback), which the options scan keeps from src/.
 * - Request headers: a list of those allowed (REQUEST_HEADERS, and x-stainless-*, the SDK's), each passed as it is;
 *   `accept-encoding` is set to identity, so the stream the meter reads is plain SSE; `content-length` as Node writes
 *   it; `x-api-key` set to the key. Every other header is dropped, a client's Authorization, X-Api-Key and Cookie
 *   always among them (AC8), and the name of each dropped one goes to proxy.json (not the three credentials', nor
 *   the hop-by-hop ones', which are dropped by rule). The list is a guess until AC4 compares it with a call that
 *   answered (review of #0-313's plan, E).
 * - Response headers: those of RESPONSE_HEADERS and anthropic-ratelimit-*; `set-cookie` and every other is dropped.
 * - The request's body is held to BODY_LIMIT and checked before anything goes upstream (request-filter.mjs: review
 *   round 1 of factory#29, sec-5a7e, which reverses #0-313's first rule "the body is never read"); it is read only for
 *   that check, never logged, written or kept after the request. The response is streamed, each chunk written as it
 *   comes, with backpressure: never held.
 * - Timeouts: CONNECT_MS to a socket, HEADERS_MS to the response's headers, IDLE_MS with no byte of the stream
 *   (Anthropic sends a ping event within that). A client that closes ends the upstream request with it.
 */
import { request as httpRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';

import { filterRequest, readBody } from './request-filter.mjs';

/** Anthropic's API: the one target (#0-313). */
export const UPSTREAM = Object.freeze({ protocol: 'https:', hostname: 'api.anthropic.com', port: 443 });

/** The request headers passed as they are, besides x-stainless-*. */
export const REQUEST_HEADERS = Object.freeze(['anthropic-version', 'anthropic-beta', 'content-type', 'accept',
  'user-agent']);
const STAINLESS = /^x-stainless-[a-z0-9-]{1,48}$/;
/** Dropped by rule, so not named in proxy.json: the client's credentials and the hop-by-hop headers. */
const BY_RULE = new Set(['authorization', 'x-api-key', 'cookie', 'host', 'connection', 'keep-alive',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-connection', 'content-length',
  'accept-encoding']);
/** The response headers passed, besides anthropic-ratelimit-*. */
export const RESPONSE_HEADERS = Object.freeze(['content-type', 'content-length', 'request-id', 'retry-after',
  'x-should-retry']);

export const BODY_LIMIT = 32 * 1024 * 1024;
export const CONNECT_MS = 10_000;
export const HEADERS_MS = 120_000;
export const IDLE_MS = 300_000;

/**
 * The headers upstream is sent, from a request's (node's, lower case), and the names dropped that proxy.json may name.
 *
 * @param {Record<string, string | string[]>} headers
 * @param {{ key: string, hostname: string, contentLength?: string }} options
 * @returns {{ headers: Record<string, string>, dropped: string[] }}
 */
export function upstreamHeaders(headers, { key, hostname, contentLength }) {
  const out = {};
  const dropped = [];
  for (const [name, value] of Object.entries(headers)) {
    if ((REQUEST_HEADERS.includes(name) || STAINLESS.test(name)) && typeof value === 'string') {
      out[name] = value;
    } else if (!BY_RULE.has(name)) {
      dropped.push(name);
    }
  }
  out.host = hostname;
  out['accept-encoding'] = 'identity';
  if (contentLength !== undefined) {
    out['content-length'] = contentLength;
  }
  // Set last, so no header of the request's can stand in its place (#0-313 AC8).
  out['x-api-key'] = key;
  return { headers: out, dropped };
}

/** The headers a client is sent, from upstream's (node's, lower case). */
export function clientHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => typeof value === 'string'
    && (RESPONSE_HEADERS.includes(name) || /^anthropic-ratelimit-[a-z0-9-]{1,48}$/.test(name))));
}

/** An agent of the proxy's, to `upstream`: a few kept-alive sockets, TLS 1.2 or later, the server's name fixed. */
export function upstreamAgent(upstream) {
  return upstream.protocol === 'https:'
    ? new Agent({ keepAlive: true, maxSockets: 8, minVersion: 'TLSv1.2', servername: upstream.hostname })
    : undefined;
}

/**
 * Forwards one request (`req`, `res`: the client's) to `upstream`, streaming both ways.
 *
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string,
 *   key: string, betas: readonly string[], upstream: object, agent?: object,
 *   onResponse: (status: number, headers: object) => void,
 *   onChunk: (chunk: Buffer) => void, onDropped: (names: string[]) => void,
 *   refuse: (status: number, type: string, message: string, reason: string) => void }} options `refuse` answers the
 *   client before upstream's headers (400, 413, 503); `betas` the anthropic-beta values allowed
 * @returns {Promise<'done' | 'refused' | 'aborted' | 'gone'>} once the exchange is over: `gone` a client that left
 *   before its body was whole, nothing sent upstream
 */
export async function forward({ req, res, path, key, betas, upstream, agent, onResponse, onChunk, onDropped, refuse }) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > BODY_LIMIT)) {
    refuse(413, 'request_too_large', 'the request body is larger than the proxy takes', 'body-too-large');
    return 'refused';
  }
  // The body whole, to the limit, then checked (request-filter.mjs): nothing goes upstream before.
  const body = await readBody(req, BODY_LIMIT);
  if (body === 'aborted') {
    // Gone before its body was whole: nothing went upstream (review round 2 of factory#29: not counted as forwarded).
    return 'gone';
  }
  if (body === 'too-large') {
    refuse(413, 'request_too_large', 'the request body is larger than the proxy takes', 'body-too-large');
    return 'refused';
  }
  const { reason: refusal, json } = filterRequest({ body, beta: req.headers['anthropic-beta'], betas });
  if (refusal !== null) {
    refuse(400, 'invalid_request_error', 'the request asks for what the proxy does not forward: only the client\'s '
      + 'own tools, and the betas of Claude Code\'s calls', refusal);
    return 'refused';
  }
  // What goes upstream is what was checked: the parsed body serialized again (review round 2 of factory#29).
  const checked = Buffer.from(json, 'utf8');
  const { headers, dropped } = upstreamHeaders(req.headers, { key, hostname: upstream.hostname,
    contentLength: String(checked.length) });
  onDropped(dropped);
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    let answered = false;
    const end = (how) => {
      if (!settled) {
        settled = true;
        resolve(how);
      }
    };
    const up = send({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: 'POST',
      path, headers, agent, servername: upstream.protocol === 'https:' ? upstream.hostname : undefined });
    const fail = () => {
      if (settled) {
        return;
      }
      if (!answered && !res.headersSent) {
        refuse(503, 'overloaded_error', 'the proxy could not reach Anthropic', 'upstream');
        end('refused');
      } else {
        res.destroy();
        end('aborted');
      }
      up.destroy();
    };
    const headersTimer = setTimeout(fail, HEADERS_MS);
    up.on('socket', (socket) => {
      if (socket.connecting) {
        const connectTimer = setTimeout(fail, CONNECT_MS);
        socket.once('connect', () => clearTimeout(connectTimer));
        socket.once('secureConnect', () => clearTimeout(connectTimer));
        socket.once('close', () => clearTimeout(connectTimer));
      }
    });
    up.on('error', () => {
      clearTimeout(headersTimer);
      fail();
    });
    up.on('response', (upRes) => {
      answered = true;
      clearTimeout(headersTimer);
      onResponse(upRes.statusCode, upRes.headers);
      res.writeHead(upRes.statusCode, clientHeaders(upRes.headers));
      res.flushHeaders();
      up.setTimeout(IDLE_MS, () => fail());
      upRes.on('data', (chunk) => {
        onChunk(chunk);
        // Each chunk as it comes, never held (#0-313 AC8): backpressure pauses upstream, nothing is gathered.
        if (!res.write(chunk)) {
          upRes.pause();
          res.once('drain', () => upRes.resume());
        }
      });
      upRes.on('end', () => {
        res.end();
        end('done');
      });
      upRes.on('error', () => fail());
    });
    // A client gone ends the upstream request (#0-313 AC8: no work for no one).
    res.on('close', () => {
      clearTimeout(headersTimer);
      if (!res.writableFinished) {
        up.destroy();
        end('aborted');
      }
    });
    up.end(checked);
  });
}
