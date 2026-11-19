// Not a test file: node --test runs every file under test/, so the helpers live here.
// A fake of the few GitHub REST endpoints the app-token code calls, on node:http (incident-platform backlog #0-269).
// Each route is a function of the request returning { status, body, delayMs? }; every request is recorded, its body
// parsed; `delayMs` holds the answer back, for a test that acts while a request is in flight.
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
      const request = {
        method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers,
        body: raw === '' ? undefined : JSON.parse(raw),
      };
      requests.push(request);
      const route = routes[`${req.method} ${url.pathname}`];
      const { status, body, delayMs = 0 } = route ? route(request) : { status: 404, body: { message: 'Not Found' } };
      setTimeout(() => {
        res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
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
