/**
 * An installation token minted only after GitHub's answers pass the checks a token must pass before it is used
 * (incident-platform backlog #0-271, ADR-0060 D5 as amended): the app's key is the process user's own and readable by
 * no one else; the installation is the one expected, of the app expected, and holds exactly the permissions expected;
 * the token is narrowed to one repository, reaches exactly it, and holds the same permissions.
 *
 * Parametrized by the app, the installation, the repository and the permissions, for two callers:
 * - builder-token.mjs (builder-app), through mintCheckedToken, whose token is narrowed to one repository;
 * - dispatcher/bin/dev-token.mjs (the dev app, on the owner's host), through readAppKey and the check* functions one by
 *   one, since its token is not narrowed, on purpose: that the token reaches only profitbuild/factory proves the
 *   installation's scope on every token. Its permissions are not builder-app's either.
 *
 * Nothing here writes to the disk or prints; a refusal's message names what GitHub answered (permissions, repository
 * names, ids), never a token, the JWT or the key.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  createAppJwt, createInstallationToken, findRepositoryInstallation, listInstallationRepositories,
  revokeInstallationToken,
} from './app-token.mjs';
import { readOwnFile } from '../config/own-file.mjs';
import { requireHttpsOrLoopback } from './url-policy.mjs';

/** A check against GitHub's answers, or of the key's file, failed: no token may stand on it. */
export class RefusedError extends Error {}

const sortedEntries = (permissions) => Object.fromEntries(Object.entries(permissions ?? {}).sort());
const show = (permissions) => JSON.stringify(sortedEntries(permissions));

/** HTTPS, or plain HTTP to a loopback address (a test's fake GitHub); anything else would get the app's JWT. */
export function checkApiUrl(api) {
  requireHttpsOrLoopback(api, 'the API');
  return api;
}

/**
 * The app's private key, refused unless it is a regular file of the process's user that no one else can read.
 *
 * @param {string} path
 * @param {{ uid?: number, afterLstat?: () => Promise<void> }} [options] the owner required, the process's user by
 *   default, and readOwnFile's afterLstat (for tests)
 */
export async function readAppKey(path, { uid, afterLstat } = {}) {
  return readOwnFile(path, {
    what: 'the key', forbiddenMode: 0o077, uid, afterLstat, refuse: (message) => new RefusedError(message),
  });
}

/**
 * `installationIdFrom` names where the caller's expected installation id comes from, for the refusal; it has no
 * default, so that a new caller must say it (a programming error, thrown as a TypeError, otherwise).
 */
function requireInstallationIdFrom(installationIdFrom) {
  if (typeof installationIdFrom !== 'string' || installationIdFrom === '') {
    throw new TypeError('installationIdFrom must name where the expected installation id comes from');
  }
}

/**
 * The installation GitHub names for the repository is the one expected, of the app expected, holding `permissions`.
 * `installationIdFrom` names the source of `installationId` in a refusal: builder-token's
 * 'BUILDER_APP_INSTALLATION_ID', dev-token's 'INSTALLATION_ID / --installation-id'.
 */
export function checkInstallation(installation, { appId, installationId, installationIdFrom, permissions, repository }) {
  requireInstallationIdFrom(installationIdFrom);
  if (installation.id !== installationId) {
    throw new RefusedError(`the installation on ${repository} is ${installation.id}, not ${installationId} `
      + `as ${installationIdFrom} says`);
  }
  if (installation.app_id !== appId) {
    throw new RefusedError(`the installation on ${repository} is the app ${installation.app_id}'s, not ${appId}'s`);
  }
  if (!isDeepStrictEqual(sortedEntries(installation.permissions), sortedEntries(permissions))) {
    throw new RefusedError(`the installation on ${repository} holds ${show(installation.permissions)}, `
      + `not exactly ${show(permissions)}`);
  }
}

/** The token reaches exactly `repository` (`owner/name`). */
export function checkTokenRepositories(repositories, repository) {
  if (!isDeepStrictEqual(repositories, [repository])) {
    throw new RefusedError(`the token reaches ${JSON.stringify(repositories)}, not exactly ["${repository}"]`);
  }
}

/** The token holds exactly `permissions`. */
export function checkTokenPermissions(tokenPermissions, permissions) {
  if (!isDeepStrictEqual(sortedEntries(tokenPermissions), sortedEntries(permissions))) {
    throw new RefusedError(`the token holds ${show(tokenPermissions)}, not exactly ${show(permissions)}`);
  }
}

/**
 * Mints a token of `installationId`, narrowed to `owner/repo` and to `permissions`, after the checks above; a token
 * that fails one is revoked before the refusal is thrown, so none is returned.
 *
 * @param {{ appId: number, installationId: number, installationIdFrom: string, keyPath: string, owner: string,
 *   repo: string,
 *   permissions: Record<string, string>, baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   uid?: number, report?: (line: string) => void }} options `report` is told each check that passed (check-app)
 * @returns {Promise<{ token: string, expiresAt: string }>}
 * @throws {RefusedError} a check failed; {Error} `baseUrl` is neither HTTPS nor loopback (checked before the key is
 *   read and the JWT made), or GitHub was not reached or answered an error
 */
export async function mintCheckedToken({
  appId, installationId, installationIdFrom, keyPath, owner, repo, permissions, baseUrl, fetchImpl, timeoutMs, uid,
  report = () => {},
}) {
  requireInstallationIdFrom(installationIdFrom);
  checkApiUrl(baseUrl);
  const repository = `${owner}/${repo}`;
  const privateKey = await readAppKey(keyPath, { uid });
  report(`key ${keyPath}: a regular file of uid ${uid ?? process.getuid()}, readable by no one else: ok`);
  const jwt = createAppJwt({ appId, privateKey });
  const call = { baseUrl, fetchImpl, timeoutMs };
  const installation = await findRepositoryInstallation({ ...call, jwt, owner, repo });
  checkInstallation(installation, { appId, installationId, installationIdFrom, permissions, repository });
  report(`installation ${installationId} of app ${appId} on ${repository} holds ${show(permissions)}: ok`);
  const answer = await createInstallationToken({
    ...call, jwt, installationId, permissions: { ...permissions }, repositories: [repo],
  });
  const { token } = answer;
  try {
    checkTokenRepositories(await listInstallationRepositories({ ...call, token }), repository);
    report(`token narrowed to ${repository}, and reaches only it: ok`);
    checkTokenPermissions(answer.permissions, permissions);
    report(`token holds ${show(permissions)}: ok (expires ${answer.expires_at})`);
  } catch (error) {
    await revokeQuietly({ ...call, token });
    throw error;
  }
  return { token, expiresAt: answer.expires_at };
}

/**
 * Revokes a token; a failure is swallowed (the refusal or error that called it is what the caller must see, and the
 * token expires within the hour).
 */
export async function revokeQuietly({ baseUrl, token, fetchImpl, timeoutMs }) {
  try {
    await revokeInstallationToken({ baseUrl, token, fetchImpl, timeoutMs });
  } catch {
    // Its message names only the call and GitHub's status; the caller's error matters more.
  }
}
