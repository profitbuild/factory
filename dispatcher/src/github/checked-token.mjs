/**
 * An installation token minted only after GitHub's answers pass the checks a token must pass before it is used
 * (incident-platform backlog #0-271, ADR-0060 D5 as amended): the app's key is the process user's own and readable by
 * no one else; the installation is the one expected, of the app expected, and holds exactly the permissions expected;
 * the token is narrowed to one repository, reaches exactly it, and holds the same permissions.
 *
 * Parametrized by the repository and the permissions, for builder-app today (builder-token.mjs). dispatcher/bin/
 * dev-token.mjs keeps its own copy of these checks for now (#0-271 AC4): it does not narrow its token, on purpose, and
 * its permissions and builder-app's part at stage 4.5; moving it onto this module is a backlog item of its own.
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

/** A check against GitHub's answers, or of the key's file, failed: no token may stand on it. */
export class RefusedError extends Error {}

const sortedEntries = (permissions) => Object.fromEntries(Object.entries(permissions ?? {}).sort());
const show = (permissions) => JSON.stringify(sortedEntries(permissions));

/** HTTPS, or plain HTTP to a loopback address (a test's fake GitHub); anything else would get the app's JWT. */
export function checkApiUrl(api) {
  const url = new URL(api);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`the API must be an https:// URL, not ${url.protocol}//${url.host}`);
  }
  return api;
}

/**
 * The app's private key, refused unless it is a regular file of the process's user that no one else can read.
 *
 * @param {string} path
 * @param {{ uid?: number }} [options] the owner required, the process's user by default (for tests)
 */
export async function readAppKey(path, { uid } = {}) {
  return readOwnFile(path, {
    what: 'the key', forbiddenMode: 0o077, uid, refuse: (message) => new RefusedError(message),
  });
}

/** The installation GitHub names for the repository is the one expected, of the app expected, holding `permissions`. */
export function checkInstallation(installation, { appId, installationId, permissions, repository }) {
  if (installation.id !== installationId) {
    throw new RefusedError(`the installation on ${repository} is ${installation.id}, not ${installationId} `
      + 'as the env file says');
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
 * @param {{ appId: number, installationId: number, keyPath: string, owner: string, repo: string,
 *   permissions: Record<string, string>, baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   uid?: number, report?: (line: string) => void }} options `report` is told each check that passed (check-app)
 * @returns {Promise<{ token: string, expiresAt: string }>}
 * @throws {RefusedError} a check failed; {Error} GitHub was not reached or answered an error
 */
export async function mintCheckedToken({
  appId, installationId, keyPath, owner, repo, permissions, baseUrl, fetchImpl, timeoutMs, uid, report = () => {},
}) {
  const repository = `${owner}/${repo}`;
  const privateKey = await readAppKey(keyPath, { uid });
  report(`key ${keyPath}: a regular file of uid ${uid ?? process.getuid()}, readable by no one else: ok`);
  const jwt = createAppJwt({ appId, privateKey });
  const call = { baseUrl, fetchImpl, timeoutMs };
  const installation = await findRepositoryInstallation({ ...call, jwt, owner, repo });
  checkInstallation(installation, { appId, installationId, permissions, repository });
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
