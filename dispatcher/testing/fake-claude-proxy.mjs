// Not a test file. What the fake daemon's Claude Code does with a scenario entry's `proxy` (incident-platform backlog
// #0-313): what the real one does with the managed settings' apiKeyHelper and the call's ANTHROPIC_BASE_URL. It reads
// the token from the file the container holds on /run/factory (the token directory's bind, mapped to the test's
// directory), and sends one `POST /v1/messages?beta=true` to the base URL of its argv with the token in both
// Authorization: Bearer and x-api-key, as measurement 1 saw, a body holding `bodyMarker`, and the headers the entry
// gives. The exchange (the token file's mode, the status, the response's headers and body, the token used) is appended
// to <fake dir>/proxy-calls.jsonl. Synchronous, in a child of its own, as the fake's exec is.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = `
const [url, token, headers, body] = process.argv.slice(1);
const res = await fetch(url + '/v1/messages?beta=true', { method: 'POST', body,
  headers: { authorization: 'Bearer ' + token, 'x-api-key': token, 'content-type': 'application/json',
    'anthropic-version': '2023-06-01', ...JSON.parse(headers) } })
  .catch((error) => ({ error: error.cause?.code ?? error.message }));
const out = res.error ? { error: res.error }
  : { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
process.stdout.write(JSON.stringify(out));
`;

/**
 * @param {string[]} argv the call's, after the container's ID
 * @param {string} tokenDir the host's path of the container's /run/factory
 * @param {string} fakeDir the fake's own directory
 * @param {{ headers?: Record<string, string>, bodyMarker?: string }} entry the scenario's `proxy`
 */
export function callProxy(argv, tokenDir, fakeDir, entry) {
  const url = argv.find((a) => a.startsWith('ANTHROPIC_BASE_URL='))?.slice('ANTHROPIC_BASE_URL='.length) ?? '';
  const tokenFile = join(tokenDir, 'token');
  let token = '';
  let mode = null;
  try {
    token = readFileSync(tokenFile, 'utf8');
    mode = statSync(tokenFile).mode & 0o777;
  } catch {
    // no token: the call is sent without one, as Claude Code's would fail
  }
  const body = JSON.stringify({ model: 'claude-opus-5-5', stream: true, marker: entry.bodyMarker ?? '' });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CLIENT, url, token,
    JSON.stringify(entry.headers ?? {}), body], { encoding: 'utf8', timeout: 20_000 });
  const result = child.stdout ? JSON.parse(child.stdout) : { error: `exit ${child.status}` };
  appendFileSync(join(fakeDir, 'proxy-calls.jsonl'), `${JSON.stringify({ url, mode, token, ...result })}\n`);
}
