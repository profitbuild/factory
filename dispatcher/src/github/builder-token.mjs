/**
 * builder-app's token, for the dispatcher (incident-platform backlog #0-271, ADR-0060 D5 as amended, stage 4.2): the
 * first secret that writes to incident-platform with no one at the keyboard. Minted from the app's key after every
 * check of checked-token.mjs, narrowed to profitbuild/incident-platform, kept in memory until 5 minutes before it
 * expires, never on the disk, in process.env or in a log; handed to `git push` only, through GIT_ASKPASS.
 *
 * The app's id, its installation's id and its key's path come from the dispatcher's env file (env-file.mjs), not from
 * here.
 */
import { fileURLToPath } from 'node:url';

import { GITHUB_API, revokeInstallationToken } from './app-token.mjs';
import { mintCheckedToken, revokeQuietly } from './checked-token.mjs';

/** What builder-app holds, and the only thing its token may hold; Issues waits for stage 4.5. */
export const BUILDER_PERMISSIONS = Object.freeze({ contents: 'write', metadata: 'read', pull_requests: 'write' });
/** The one repository builder-app's token reaches. */
export const BUILDER_REPOSITORY = Object.freeze({ owner: 'profitbuild', repo: 'incident-platform' });
/** Where builder-app pushes: an explicit URL, never a remote's name, which the repository's config could redefine. */
export const PUSH_URL = 'https://github.com/profitbuild/incident-platform.git';
/** A token is minted again once it has this long left: a push started with it must not outlive it. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
/** The script git runs to ask for a credential (libexec/git-askpass.sh). */
export const GIT_ASKPASS = fileURLToPath(new URL('../../libexec/git-askpass.sh', import.meta.url));

/**
 * One of builder-app's tokens, after every check; revoked and refused when it already expires within
 * REFRESH_BEFORE_EXPIRY_MS, or its expiry cannot be read, since the cache could not hold it.
 *
 * @param {{ env: { appId: number, installationId: number, keyPath: string }, baseUrl?: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number, uid?: number, now?: () => number,
 *   report?: (line: string) => void }} options
 * @returns {Promise<{ token: string, expiresAt: string, expiresAtMs: number }>}
 */
export async function mintBuilderToken({
  env, baseUrl = GITHUB_API, fetchImpl, timeoutMs, uid, now = Date.now, report,
}) {
  const minted = await mintCheckedToken({
    appId: env.appId, installationId: env.installationId, keyPath: env.keyPath, ...BUILDER_REPOSITORY,
    permissions: BUILDER_PERMISSIONS, baseUrl, fetchImpl, timeoutMs, uid, report,
  });
  const expiresAtMs = Date.parse(minted.expiresAt);
  if (!(expiresAtMs - now() > REFRESH_BEFORE_EXPIRY_MS)) {
    await revokeQuietly({ baseUrl, token: minted.token, fetchImpl, timeoutMs });
    throw new Error(`GitHub's token expires at ${JSON.stringify(minted.expiresAt)}, less than `
      + `${REFRESH_BEFORE_EXPIRY_MS / 60000} minutes from now: refused`);
  }
  return { ...minted, expiresAtMs };
}

/**
 * builder-app's token, kept in memory: `getToken()` returns the token held while it has more than 5 minutes left, and
 * mints a new one (mintBuilderToken) otherwise. Calls made while one is being minted share it: one request to GitHub.
 * A failure, of GitHub or of a check, is thrown to every caller waiting and leaves nothing held, so the next call mints
 * again; a token in its last 5 minutes is never returned. A token replaced is not revoked: a push started with it may
 * still be running, and it expires within 5 minutes. `revoke()`, at the dispatcher's stop, revokes the token held and
 * ends the source.
 *
 * @param {Parameters<typeof mintBuilderToken>[0]} options
 * @returns {{ getToken: () => Promise<string>, revoke: () => Promise<void> }}
 */
export function createBuilderTokenSource(options) {
  const { baseUrl = GITHUB_API, fetchImpl, timeoutMs, now = Date.now } = options;
  let held = null;
  let inFlight = null;
  let closed = false;
  const getToken = async () => {
    if (closed) {
      throw new Error('the token source is closed');
    }
    if (held && held.expiresAtMs - now() > REFRESH_BEFORE_EXPIRY_MS) {
      return held.token;
    }
    held = null;
    if (!inFlight) {
      inFlight = mintBuilderToken({ ...options, baseUrl, now })
        .then((minted) => {
          held = { token: minted.token, expiresAtMs: minted.expiresAtMs };
          return minted.token;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
  const revoke = async () => {
    closed = true;
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    if (held) {
      const { token } = held;
      held = null;
      await revokeInstallationToken({ baseUrl, token, fetchImpl, timeoutMs });
    }
  };
  return { getToken, revoke };
}

/** An explicit https:// URL, or http:// to a loopback address (the tests' fake GitHub), with no user or password. */
function checkPushUrl(url) {
  const parsed = new URL(url);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))) {
    throw new Error(`a push URL must be https://, not ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('a push URL must carry no user or password');
  }
  return parsed;
}

/**
 * The command that pushes `refspecs` to `url` with builder-app's `token`: what to pass to `spawn(command, args,
 * { env, cwd })`. The token is in `env` alone, as FACTORY_PUSH_TOKEN, which libexec/git-askpass.sh prints when git
 * asks for the password of `url`'s origin (FACTORY_PUSH_ORIGIN) and of no other; it is in no URL, no argument, no
 * file, and not in process.env, so no other child of the dispatcher inherits it.
 *
 * The rule: **the token goes only to a git run in a repository whose configuration the dispatcher trusts.** A
 * repository whose .git/config an agent wrote is not one: its config can still run code or redirect the push that the
 * overrides below do not reach (`http.<url>.sslVerify`, `http.proxy`, a filter, an alias). Pushing from the
 * dispatcher's own clone, with the agent's work fetched into it, is stage 4.3/4.5's. The overrides are a second layer:
 * no hook (`core.hooksPath`, `--no-verify`), no fsmonitor command, no credential helper (one would be handed the token
 * on `store`), no system or global config, no inherited GIT_* variable, no terminal prompt; a URL rewritten by
 * `insteadOf` to another host gets no credential from the askpass script.
 *
 * @param {{ token: string, refspecs: string[], url?: string, baseEnv?: Record<string, string | undefined> }} options
 *   `url` is PUSH_URL but in tests; `baseEnv` the environment to start from, process.env by default, not changed.
 * @returns {{ command: 'git', args: string[], env: Record<string, string> }}
 */
export function gitPushCommand({ token, refspecs, url = PUSH_URL, baseEnv = process.env }) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('gitPushCommand: a token is required');
  }
  const parsed = checkPushUrl(url);
  if (!Array.isArray(refspecs) || refspecs.length === 0
    || refspecs.some((refspec) => typeof refspec !== 'string' || refspec === '' || refspec.startsWith('-'))) {
    throw new Error('gitPushCommand: refspecs must be one or more, none starting with "-"');
  }
  const env = Object.fromEntries(Object.entries(baseEnv)
    .filter(([name, value]) => value !== undefined && !name.startsWith('GIT_') && !name.startsWith('FACTORY_PUSH_')
      && name !== 'SSH_ASKPASS'));
  Object.assign(env, {
    GIT_ASKPASS,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    FACTORY_PUSH_ORIGIN: parsed.origin,
    FACTORY_PUSH_TOKEN: token,
  });
  return {
    command: 'git',
    args: [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=',
      '-c', 'credential.helper=',
      'push', '--no-verify', '--porcelain', url, ...refspecs,
    ],
    env,
  };
}
