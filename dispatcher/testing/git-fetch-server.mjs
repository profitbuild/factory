// Not a test file. A git smart-HTTP server for the update of FACTORY_REPO_DIR's main (incident-platform backlog
// #0-278), on node:http with the test's own `git http-backend` (git's CGI): it serves the bare repositories under
// `root` (`<root>/<owner>/<name>.git`), asks for Basic credentials, and lets through only x-access-token with a token
// `valid(token)` takes; it records every Authorization header. fake-github.mjs reads a body as text, which a fetch's
// gzip'd request is not, hence a server of its own.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { REAL_GIT } from './git-fixtures.mjs';

/**
 * @param {{ root: string, valid: (token: string) => boolean }} options
 * @returns {Promise<{ baseUrl: string, authorizations: (string | undefined)[], close: () => Promise<void> }>}
 */
export async function startGitFetchServer({ root, valid }) {
  const authorizations = [];
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const [user, token] = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':') : [];
    if (user !== 'x-access-token' || !valid(token)) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"' });
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://fake');
    const child = spawn(REAL_GIT, ['http-backend'], {
      env: {
        PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: user,
        REMOTE_ADDR: '127.0.0.1', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    req.pipe(child.stdin);
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      const end = out.indexOf('\r\n\r\n');
      const head = out.subarray(0, end).toString('utf8').split('\r\n');
      const headers = {};
      let status = 200;
      for (const line of head) {
        const [name, ...value] = line.split(': ');
        if (name.toLowerCase() === 'status') {
          status = Number.parseInt(value.join(': '), 10);
        } else {
          headers[name] = value.join(': ');
        }
      }
      res.writeHead(status, headers);
      res.end(out.subarray(end + 4));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    authorizations,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
