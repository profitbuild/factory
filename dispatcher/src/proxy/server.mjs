/**
 * The dispatcher's credential proxy (incident-platform backlog #0-313, M2.7; ADR-0060 D4, ADR-0064 point 5 and
 * ADR-0062 points 4 and 5 as amended): Claude's key stays outside the task container, which holds only its task's
 * token and reaches Claude through this proxy.
 *
 * One proxy per run, in the run's own process (`cli.mjs run`): it lives and dies with the run, so the token is valid
 * for the run's life and no longer, a run killed takes its proxy with it, and the key is in memory only while a run
 * lives. In M5 each slot's run has its own, on the next free port of /etc/factory-proxy.conf (conf.mjs), and knows no
 * token but its own.
 *
 * - It listens on ADDR:<port> alone (conf.mjs): the proxy's own address, on the dummy interface provision.sh sets up,
 *   never a wildcard, the loopback or the VM's own (#0-313 AC5); the VM's filter keeps the port unreachable from
 *   outside (provision.sh).
 * - The token: 32 random bytes (base64url), made when the proxy starts, valid once `activate()` is called (the task's
 *   container checked, its token file written) and until `revoke()` (the run's phases over, in a finally). A request
 *   carries it in x-api-key or `Authorization: Bearer` (Claude Code sends both, #0-313's measurement 1); both present
 *   must agree. It is compared in constant time (SHA-256 digests, timingSafeEqual). Anything else is 401 (AC1).
 * - The path: only `POST /v1/messages`, with no query or exactly `?beta=true` (#0-313's measurement 3 saw nothing
 *   else; the owner's answer on the plan: HEAD /api/hello and count_tokens are 404 until AC4 shows a need). Anything
 *   else is 404, logged by its path alone (refusal-log.mjs).
 * - At most IN_FLIGHT requests at once; one more is 429 with Retry-After: 1 (AC8).
 * - The body and the betas, checked before anything goes upstream (request-filter.mjs; review round 1 of factory#29,
 *   sec-5a7e): only the client's own tools, no MCP connector, and only the betas Claude Code's calls send. A request
 *   past that is 400 invalid_request_error.
 * - Every refusal is in Anthropic's error shape, `{ type: "error", error: { type, message } }`, the message the proxy's
 *   own words, with X-Should-Retry false on 400, 401, 403, 404 and 413, and true with Retry-After: 1 on 429 and 503
 *   (opencomputer's modelproxy, its design only), so Claude Code retries only what can succeed.
 * - Authentication first, then the path, then the limit: a request without the token learns nothing of the rest.
 * The order of checks, the streaming and what is counted are upstream.mjs's and usage.mjs's.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { refusalLog, pathForLog } from './refusal-log.mjs';
import { UPSTREAM, forward, upstreamAgent } from './upstream.mjs';
import { newRecord, noteDropped, noteRateLimits, sseMeter, writeProxyRecord } from './usage.mjs';

/** The most requests of the task at once (#0-313 AC8; the owner's answer on the plan). */
export const IN_FLIGHT = 4;
/** The most connections the proxy holds open at once. */
export const MAX_CONNECTIONS = 16;
/** The paths forwarded (#0-313: the owner's answer on the plan, 2). */
export const FORWARDED = Object.freeze(['/v1/messages', '/v1/messages?beta=true']);
/** How often, at most, the record is written while requests come. */
export const RECORD_EVERY_MS = 1000;

/** The proxy could not start: the task stops, and no token is issued. */
export class ProxyError extends Error {}

const RETRY = new Set([429, 503]);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

/** The token a request carries, from x-api-key or Authorization: Bearer; `differ` when both are given and differ. */
export function presentedToken(headers) {
  const key = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : undefined;
  const bearer = typeof headers.authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(headers.authorization)?.[1]
    : undefined;
  if (key !== undefined && bearer !== undefined && key !== bearer) {
    return { differ: true };
  }
  return { token: key ?? bearer };
}

/**
 * Starts the run's proxy on the first free port of `ports`, at `addr`.
 *
 * @param {{ addr: string, ports: number[], key: string, betas: readonly string[], runId: string, stateDir: string,
 *   err: { write: (line: string) => void }, proxyTesting?: { upstream?: object } }} options `betas` the
 *   anthropic-beta values allowed (expectations.json's anthropicBetas); `proxyTesting.upstream` a fake upstream, for
 *   the tests only
 * @returns {Promise<{ baseUrl: string, token: string, port: number, activate: () => void, revoke: () => void,
 *   close: () => Promise<void> }>}
 */
export async function startProxy({ addr, ports, key, betas, runId, stateDir, err, proxyTesting = {} }) {
  if (!Array.isArray(betas) || !betas.every((beta) => typeof beta === 'string')) {
    throw new TypeError('startProxy: betas must be the list of anthropic-beta values allowed');
  }
  const upstream = proxyTesting.upstream ?? UPSTREAM;
  const agent = upstreamAgent(upstream);
  const token = randomBytes(32).toString('base64url');
  const tokenDigest = digest(token);
  const log = refusalLog({ write: (line) => err.write(line), runId });
  const record = newRecord(runId);
  let active = false;
  let inFlight = 0;
  let timer = null;
  let writing = Promise.resolve();

  const persist = () => {
    writing = writing.then(() => writeProxyRecord(stateDir, record)).catch((error) => {
      log('could not write its record', `(${error.code ?? error.constructor.name})`);
    });
    return writing;
  };
  const touch = () => {
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        persist();
      }, RECORD_EVERY_MS);
    }
  };
  const refuse = (res, status, type, message, reason, detail = '') => {
    record.refused[reason] = (record.refused[reason] ?? 0) + 1;
    touch();
    log(`refused (${reason})`, detail);
    const headers = { 'content-type': 'application/json', 'x-should-retry': RETRY.has(status) ? 'true' : 'false' };
    if (RETRY.has(status)) {
      headers['retry-after'] = '1';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };

  const server = createServer({ requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 5_000 },
    async (req, res) => {
      const presented = presentedToken(req.headers);
      if (presented.differ) {
        refuse(res, 401, 'authentication_error', 'the request\'s two credentials differ', 'credentials-differ');
        return;
      }
      if (presented.token === undefined) {
        refuse(res, 401, 'authentication_error', 'the request carries no token of a task', 'no-token');
        return;
      }
      // Constant time, whatever the token's length (#0-313).
      if (!timingSafeEqual(digest(presented.token), tokenDigest)) {
        refuse(res, 401, 'authentication_error', 'the token is no running task\'s', 'unknown-token');
        return;
      }
      if (!active) {
        refuse(res, 401, 'authentication_error', 'the token is no running task\'s', 'token-not-active');
        return;
      }
      if (req.method !== 'POST' || !FORWARDED.includes(req.url)) {
        refuse(res, 404, 'not_found_error', 'the proxy forwards POST /v1/messages alone', 'path', pathForLog(req.url));
        return;
      }
      if (inFlight >= IN_FLIGHT) {
        refuse(res, 429, 'rate_limit_error', `the task has ${IN_FLIGHT} requests in flight already`, 'in-flight');
        return;
      }
      inFlight += 1;
      let meter = null;
      try {
        const how = await forward({ req, res, path: req.url, key, betas, upstream, agent,
          onDropped: (names) => {
            if (names.length > 0) {
              noteDropped(record, names);
              log('dropped request headers off the list', `(${names.length}; their names in proxy.json)`);
            }
          },
          onResponse: (status, headers) => {
            noteRateLimits(record, headers);
            meter = /^text\/event-stream\b/.test(headers['content-type'] ?? '') ? sseMeter(record) : null;
          },
          onChunk: (chunk) => meter?.feed(chunk),
          refuse: (status, type, message, reason) => refuse(res, status, type, message, reason),
        });
        // Forwarded: what reached upstream, done or ended midway; not a refusal, nor a client gone before its body.
        if (how === 'done' || how === 'aborted') {
          record.forwarded += 1;
          if (meter === null) {
            record.usage.unmetered += 1;
          } else {
            meter.end();
          }
        }
      } finally {
        inFlight -= 1;
        touch();
      }
    });
  server.maxConnections = MAX_CONNECTIONS;

  let port = null;
  for (const candidate of ports) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: addr, port: candidate, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      port = candidate;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw new ProxyError(`the proxy cannot listen on the configured address (${error.code ?? error.name})`);
      }
    }
  }
  if (port === null) {
    throw new ProxyError(`every port of the proxy's configuration is taken (${ports.length})`);
  }
  await persist();
  return {
    baseUrl: `http://${addr}:${port}`,
    token,
    port,
    activate() {
      active = true;
    },
    revoke() {
      active = false;
    },
    async close() {
      active = false;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      agent?.destroy();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // The last counts, whatever came since the last write.
      await persist();
    },
  };
}
