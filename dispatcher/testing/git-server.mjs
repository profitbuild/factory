// Not a test file. A fake git smart-HTTP server for builder-app's push (incident-platform backlog #0-271, #0-276), on
// fake-github.mjs: the receive-pack advertisement of an empty repository, then a report for each ref pushed. It asks
// for Basic credentials and accepts only x-access-token with `token`; it records every Authorization header and each
// ref update git sends (old, new, ref); `state.reply(ref)` answers 'ok' or a refusal with the remote's own text.
import { startFakeGitHub } from './fake-github.mjs';

const pkt = (line) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
export const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/**
 * @param {{ token: string, path?: string }} options
 * @returns {Promise<{ url: string, baseUrl: string, requests: object[], authorizations: (string | undefined)[],
 *   updates: { old: string, new: string, ref: string }[], state: { reply: (ref: string) => string },
 *   close: () => Promise<void> }>}
 */
export async function startGitServer({ token, path = '/profitbuild/incident-platform.git' }) {
  const authorizations = [];
  const updates = [];
  const state = { reply: () => 'ok' };
  const authorized = ({ headers }) => {
    authorizations.push(headers.authorization);
    return headers.authorization === basic('x-access-token', token);
  };
  const challenge = { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="fake"' }, body: '' };
  const server = await startFakeGitHub({
    [`GET ${path}/info/refs`]: (request) => (authorized(request) ? {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement', 'Cache-Control': 'no-cache' },
      body: `${pkt('# service=git-receive-pack\n')}0000`
        + `${pkt(`${'0'.repeat(40)} capabilities^{}\0report-status delete-refs ofs-delta\n`)}0000`,
    } : challenge),
    [`POST ${path}/git-receive-pack`]: (request) => {
      if (!authorized(request)) {
        return challenge;
      }
      const text = typeof request.body === 'string' ? request.body : '';
      const reports = [];
      for (const [, old, now, ref] of text.matchAll(/([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\0\n ]+)/g)) {
        updates.push({ old, new: now, ref });
        const reply = state.reply(ref);
        reports.push(pkt(reply === 'ok' ? `ok ${ref}\n` : `ng ${ref} ${reply}\n`));
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
        body: `${pkt('unpack ok\n')}${reports.join('')}0000`,
      };
    },
  });
  return { ...server, authorizations, updates, state, url: `${server.baseUrl}${path}` };
}
