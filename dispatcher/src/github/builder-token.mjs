/**
 * builder-app's token, for the dispatcher (incident-platform backlog #0-271, ADR-0060 D5 as amended, stage 4.2): the
 * first secret that writes to incident-platform with no one at the keyboard. Minted from the app's key after every
 * check of checked-token.mjs, narrowed to profitbuild/incident-platform, kept in memory until 5 minutes before it
 * expires, never on the disk, in process.env or in a log; handed to `git push` only, through GIT_ASKPASS.
 *
 * The app's id, its installation's id and its key's path come from the dispatcher's environment (builder-env.mjs), not
 * from here.
 */
import { fileURLToPath } from 'node:url';

import { GITHUB_API, revokeInstallationToken } from './app-token.mjs';
import permissions from './builder-permissions.json' with { type: 'json' };
import { checkApiUrl, mintCheckedToken, revokeQuietly } from './checked-token.mjs';
import { requireHttpsOrLoopback } from './url-policy.mjs';

/**
 * What builder-app holds, and the only thing its token may hold; Issues waits for stage 4.5. The list is a file,
 * builder-permissions.json, not a literal, as its one source (incident-platform backlog #0-272, G2): from #0-272's
 * second pull request on (its AC9), incident-platform's check-factory-copies.rb will compare it with the `permissions`
 * of its .github/repository-settings/apps/profitbuild-builder.json, the installation its repository-settings.rb checks
 * on GitHub, so that a change here, a change of what builder-app may hold, is checked on both sides. Until then, and
 * after it for a difference started here (which incident-platform only warns of, ADR-0061), widening the list fails
 * the test of builder-token.test.mjs that holds it to a literal. Copied and frozen, since the JSON module's own object
 * is shared and could be changed.
 */
export const BUILDER_PERMISSIONS = Object.freeze({ ...permissions });
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
    appId: env.appId, installationId: env.installationId, installationIdFrom: 'BUILDER_APP_INSTALLATION_ID',
    keyPath: env.keyPath, ...BUILDER_REPOSITORY,
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
  // Refused here, before any key is read or JWT made, as well as in every mint (mintCheckedToken).
  checkApiUrl(baseUrl);
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

/**
 * What of the dispatcher's environment a push inherits: the search path, HOME, and the proxy variables (a VM may
 * reach GitHub through one). Nothing else, so a variable the dispatcher holds (a secret of a later step included)
 * reaches neither git nor any child of git: an allowlist, not a denylist over process.env.
 */
export const PUSH_ENV_ALLOWED = Object.freeze(['PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy',
  'http_proxy', 'no_proxy']);

/** An explicit https:// URL, or http:// to a loopback address (the tests' fake GitHub), with no user or password. */
function checkPushUrl(url) {
  const parsed = requireHttpsOrLoopback(url, 'a push URL');
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
 * repository whose .git/config an agent wrote is not one. The overrides below are a second layer and cover part of
 * what such a config can do:
 * - a URL rewritten by `insteadOf` to another https:// host gets no credential: the askpass script answers only for
 *   the origin of `url`;
 * - a URL rewritten to another protocol (`ssh://`, whose `core.sshCommand` would run with this environment, token
 *   included; `ext::`, `file://`) is refused by git itself: GIT_ALLOW_PROTOCOL allows `allowProtocols` only, `https`,
 *   and it wins over any `protocol.<name>.allow` of the config;
 * - no hook (`core.hooksPath`, `--no-verify`), no fsmonitor command, no credential helper (one would be handed the
 *   token on `store`), no system or global config, no terminal prompt; the environment is PUSH_ENV_ALLOWED and what
 *   is set here (LC_ALL=C among it, so git's messages are English for 4.3/4.5 to parse), nothing else of the
 *   dispatcher's.
 * The rest of .git/config can still send the token elsewhere or let it be read on the way: `http.proxy`,
 * `http.<url>.sslVerify`, `http.sslCAInfo`, `http.curloptResolve`, `include.path` (which brings in any of them). Hence
 * the rule, which stage 4.3 turns into a check: pushing from the dispatcher's own clone, with the agent's work
 * fetched into it, is 4.3/4.5's.
 *
 * @param {{ token: string, refspecs: string[], url?: string, allowProtocols?: string,
 *   baseEnv?: Record<string, string | undefined> }} options `url` is PUSH_URL but in tests; `allowProtocols` the
 *   value of GIT_ALLOW_PROTOCOL, `https` but in tests (`http:https`, to a loopback server), and it must allow `url`'s
 *   own; `baseEnv` the environment the allowed variables are taken from, process.env by default, not changed.
 * @returns {{ command: 'git', args: string[], env: Record<string, string> }}
 */
export function gitPushCommand({ token, refspecs, url = PUSH_URL, allowProtocols = 'https', baseEnv = process.env }) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('gitPushCommand: a token is required');
  }
  const parsed = checkPushUrl(url);
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!/^[a-z]+(:[a-z]+)*$/.test(allowProtocols)
    || !allowProtocols.split(':').includes(scheme)) {
    throw new Error(`gitPushCommand: allowProtocols must be protocols joined by ":", ${scheme} among them`);
  }
  if (!Array.isArray(refspecs) || refspecs.length === 0
    || refspecs.some((refspec) => typeof refspec !== 'string' || refspec === '' || refspec.startsWith('-'))) {
    throw new Error('gitPushCommand: refspecs must be one or more, none starting with "-"');
  }
  const env = Object.fromEntries(PUSH_ENV_ALLOWED
    .filter((name) => typeof baseEnv[name] === 'string')
    .map((name) => [name, baseEnv[name]]));
  Object.assign(env, {
    GIT_ASKPASS,
    GIT_ALLOW_PROTOCOL: allowProtocols,
    // git's messages in English whatever the dispatcher's locale: 4.3/4.5 parse them. Set here, never inherited.
    LC_ALL: 'C',
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
