// Not a test file. A fake of Anthropic's API for the credential proxy's tests (incident-platform backlog #0-313): a
// node:http server on the loopback that records each request it is sent (method, path, headers, the body's bytes)
// and answers `POST /v1/messages` with an SSE stream of Claude's form, its usage in message_start and message_delta,
// with the rate-limit headers a test gives. `hold` makes it send the stream's first event and wait until the test
// releases it before the rest: a proxy that buffered the stream would hold that first event too, and the test would
// see nothing before the release (AC8's test that a stream is not buffered). `closedEarly` marks a request the proxy
// ended before its answer did (a client gone).
import { createServer } from 'node:http';

/** The SSE stream of one answer, `usage` in message_start's message and the last output_tokens in message_delta. */
export function sseAnswer({ input = 11, output = 7, cacheRead = 3, text = 'ok-0313' } = {}) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    event('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant',
      model: 'claude-opus-5-5', content: [], usage: { input_tokens: input, output_tokens: 1,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('ping', { type: 'ping' }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: output } }),
    event('message_stop', { type: 'message_stop' }),
  ];
}

/**
 * @param {{ headers?: Record<string, string>, status?: number }} [options] what each answer carries
 * @returns {Promise<{ upstream: object, requests: object[], hold: () => () => void, answer: object,
 *   close: () => Promise<void> }>}
 */
export async function startFakeAnthropic({ headers = {}, status = 200 } = {}) {
  const requests = [];
  const answer = { events: sseAnswer(), headers, status, held: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const entry = { method: req.method, url: req.url, headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'), closedEarly: false };
      requests.push(entry);
      // The proxy ended this request before its answer did: a client gone (AC8).
      res.on('close', () => { entry.closedEarly = !res.writableFinished; });
      res.writeHead(answer.status, { 'content-type': 'text/event-stream', 'request-id': 'req_fake',
        'set-cookie': 'session=upstream', 'anthropic-organization-id': 'org-fake', ...answer.headers });
      const [first, ...rest] = answer.events;
      res.write(first);
      if (answer.held) {
        await answer.held;
      }
      for (const part of rest) {
        res.write(part);
      }
      res.end();
    });
  });
  await new Promise((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  return {
    upstream: { protocol: 'http:', hostname: '127.0.0.1', port: server.address().port },
    requests,
    answer,
    /** Holds the next answers after their first event; the function returned releases them. */
    hold() {
      let release;
      answer.held = new Promise((resolve) => { release = resolve; });
      return () => { answer.held = null; release(); };
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
