// Not a test file: node --test runs every file under test/, so the helpers live here.
// A fake of the few GitHub REST endpoints the app-token code calls, on node:http (incident-platform backlog #0-269).
// Each route is a function of the request returning { status, body, headers?, delayMs? }; every request is recorded,
// its body parsed when it is JSON and kept as text otherwise (git's pack); `delayMs` holds the answer back, for a test
// that acts while a request is in flight. A body that is a string or a Buffer is sent as it is, with the route's
// `headers` (git's smart HTTP, incident-platform backlog #0-271); any other body is sent as JSON.
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

/** A fresh RSA key pair in the format GitHub issues an app's key (PKCS#1 PEM). */
export function appKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
}

/**
 * Starts the fake. `routes` maps "METHOD /path" (the path without its query) to a handler.
 *
 * @returns {Promise<{ baseUrl: string, requests: object[], close: () => Promise<void> }>}
 */
export async function startFakeGitHub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      let body;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const request = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body };
      requests.push(request);
      const route = routes[`${req.method} ${url.pathname}`];
      const answer = route ? route(request) : { status: 404, body: { message: 'Not Found' } };
      const { status, body: sent, headers = {}, delayMs = 0 } = answer;
      const verbatim = sent === undefined || typeof sent === 'string' || Buffer.isBuffer(sent);
      setTimeout(() => {
        res.writeHead(status, verbatim ? headers : { 'Content-Type': 'application/json', ...headers });
        res.end(verbatim ? sent : JSON.stringify(sent));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    // Idle keep-alive connections closed too, so that close() does not wait out their timeout.
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

/** The JWT's three parts, the first two decoded. */
export function decodeJwt(jwt) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}
