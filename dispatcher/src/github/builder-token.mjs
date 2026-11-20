/**
 * builder-app's token, for the dispatcher (incident-platform backlog #0-271, ADR-0060 D5 as amended, stage 4.2): the
 * first secret that writes to a product with no one at the keyboard. Minted from the app's key after every check of
 * checked-token.mjs, narrowed to the product's repository, kept in memory until 5 minutes before it expires, never on
 * the disk, in process.env or in a log; handed to `git push` only, through GIT_ASKPASS, in a push repository the
 * dispatcher made (push.mjs).
 *
 * The app's id, its installation's id and its key's path come from the dispatcher's environment (builder-env.mjs);
 * the repository from the product's adapter, `repository` (incident-platform ADR-0060 D6, backlog #0-276 AC3): none
 * of them from here.
 */
import { fileURLToPath } from 'node:url';

import { GITHUB_API, revokeInstallationToken } from './app-token.mjs';
import adapterSchema from '../../../schemas/adapter.schema.json' with { type: 'json' };
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
/** owner/name, by the adapter schema's own pattern (schemas/adapter.schema.json): one source for the shape. */
const REPOSITORY = new RegExp(adapterSchema.properties.repository.pattern, 'u');

/**
 * The product's repository, `owner/name` from its adapter, as { owner, repo }; refused unless it has the adapter's
 * shape.
 *
 * @param {string} repository
 * @returns {{ owner: string, repo: string }}
 */
export function parseRepository(repository) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    throw new TypeError('a repository must be owner/name, as the adapter has it');
  }
  const [owner, repo] = repository.split('/');
  return Object.freeze({ owner, repo });
}

/**
 * Where builder-app pushes the product's branches: an explicit URL, never a remote's name, which a config could
 * redefine. `base` is GitHub but in tests.
 *
 * @param {string} repository owner/name
 */
export function pushUrl(repository, base = 'https://github.com') {
  const { owner, repo } = parseRepository(repository);
  return `${base}/${owner}/${repo}.git`;
}
/** A token is minted again once it has this long left: a push started with it must not outlive it. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
/** The script git runs to ask for a credential (libexec/git-askpass.sh). */
export const GIT_ASKPASS = fileURLToPath(new URL('../../libexec/git-askpass.sh', import.meta.url));

/**
 * One of builder-app's tokens, after every check; revoked and refused when it already expires within
 * REFRESH_BEFORE_EXPIRY_MS, or its expiry cannot be read, since the cache could not hold it.
 *
 * @param {{ env: { appId: number, installationId: number, keyPath: string }, repository: string, baseUrl?: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number, uid?: number, now?: () => number,
 *   report?: (line: string) => void }} options `repository` the product's, owner/name, from its adapter
 * @returns {Promise<{ token: string, expiresAt: string, expiresAtMs: number }>}
 */
export async function mintBuilderToken({
  env, repository, baseUrl = GITHUB_API, fetchImpl, timeoutMs, uid, now = Date.now, report,
}) {
  const minted = await mintCheckedToken({
    appId: env.appId, installationId: env.installationId, installationIdFrom: 'BUILDER_APP_INSTALLATION_ID',
    keyPath: env.keyPath, ...parseRepository(repository),
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
 * The source names its repository (`repository`), so that a push refuses a source minted for another (push.mjs).
 *
 * @param {Parameters<typeof mintBuilderToken>[0]} options
 * @returns {{ repository: string, getToken: () => Promise<string>, revoke: () => Promise<void> }}
 */
export function createBuilderTokenSource(options) {
  const { baseUrl = GITHUB_API, fetchImpl, timeoutMs, now = Date.now } = options;
  // Refused here, before any key is read or JWT made, as well as in every mint (mintCheckedToken).
  checkApiUrl(baseUrl);
  parseRepository(options.repository);
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
  return Object.freeze({ repository: options.repository, getToken, revoke });
}

/**
 * What of the dispatcher's environment a push inherits: the search path, HOME, and the proxy variables (a VM may
 * reach GitHub through one). Nothing else (process/child-env.mjs), so a variable the dispatcher holds (a secret of a
 * later step included) reaches neither git nor any child of git.
 */
export const PUSH_ENV_ALLOWED = Object.freeze(['PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy',
  'http_proxy', 'no_proxy']);

/** Where a task's branch is pushed: under refs/heads/factory/, the only refs the product's ruleset lets builder-app write. */
export const PUSH_REF_PREFIX = 'refs/heads/factory/';

/** A task's branch: <type>/<name>, as the CLI's --resume has it, each segment a valid ref segment. */
const TASK_BRANCH = /^[a-z]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Refuses a task's branch unless it is <type>/<name> of letters, digits, dots, dashes and underscores (so no +, :, a
 * space, ~, ^, ?, * or [), with no .. anywhere, and no segment starting with a dot or ending with a dot or .lock
 * (git check-ref-format's rules for these characters).
 *
 * @param {string} branch
 */
export function checkTaskBranch(branch) {
  if (typeof branch !== 'string' || !TASK_BRANCH.test(branch) || branch.includes('..')
    || branch.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock'))) {
    throw new TypeError('a task\'s branch must be <type>/<name>, a valid ref with no "+", ":" or ".."');
  }
  return branch;
}

/** An explicit https:// URL, or http:// to a loopback address (the tests' fake GitHub), with no user or password. */
function checkPushUrl(url) {
  const parsed = requireHttpsOrLoopback(url, 'a push URL');
  if (parsed.username || parsed.password) {
    throw new Error('a push URL must carry no user or password');
  }
  return parsed;
}

/**
 * The push of a task's commit `sha` to its branch, with builder-app's `token`: what to hand to run-git.mjs's runGit
 * (`args`, `allow`, `set`), in the push repository the dispatcher made (push.mjs), which is where the rule of the token
 * is kept: **the token goes only to a git run in a repository the dispatcher made, whose config is a reference
 * `git init --bare`'s** (config-allowlist.mjs). The refspec is built here, `<sha>:refs/heads/factory/<branch>`: no
 * `+` (no force push: a task's fix is a new commit), no `:<ref>` (no delete), and the caller names neither.
 *
 * The token is in the environment alone, as FACTORY_PUSH_TOKEN, which libexec/git-askpass.sh prints when git asks for
 * the password of `url`'s origin (FACTORY_PUSH_ORIGIN) and of no other; it is in no URL, no argument, no file, and not
 * in process.env, so no other child of the dispatcher inherits it. Behind the allowlist, a second layer: a URL
 * rewritten by `insteadOf` to another https:// host gets no credential (the askpass answers one origin), one rewritten
 * to another protocol is refused by git (GIT_ALLOW_PROTOCOL, `allowProtocols`, wins over any protocol.<name>.allow);
 * runGit adds no hook, no fsmonitor, no credential helper, no system or global config and no prompt.
 *
 * @param {{ token: string, sha: string, branch: string, url: string, allowProtocols?: string }} options `url` from
 *   pushUrl(repository); `allowProtocols` the value of GIT_ALLOW_PROTOCOL, `https` but in tests (`http:https`, to a
 *   loopback server), and it must allow `url`'s own
 * @returns {{ args: string[], allow: readonly string[], set: Record<string, string>, ref: string }}
 */
export function gitPushCommand({ token, sha, branch, url, allowProtocols = 'https' }) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('gitPushCommand: a token is required');
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new TypeError('gitPushCommand: sha must be a commit\'s 40 hex digits');
  }
  checkTaskBranch(branch);
  const parsed = checkPushUrl(url);
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!/^[a-z]+(:[a-z]+)*$/.test(allowProtocols)
    || !allowProtocols.split(':').includes(scheme)) {
    throw new Error(`gitPushCommand: allowProtocols must be protocols joined by ":", ${scheme} among them`);
  }
  const ref = `${PUSH_REF_PREFIX}${branch}`;
  return {
    args: ['push', '--no-verify', '--porcelain', url, `${sha}:${ref}`],
    allow: PUSH_ENV_ALLOWED,
    set: {
      GIT_ASKPASS,
      GIT_ALLOW_PROTOCOL: allowProtocols,
      FACTORY_PUSH_ORIGIN: parsed.origin,
      FACTORY_PUSH_TOKEN: token,
    },
    ref,
  };
}
