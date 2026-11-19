/**
 * A GitHub App's installation token, from the app's private key: the JWT that authenticates as the app, and the REST
 * calls that turn it into a token of one installation (incident-platform backlog #0-269, ADR-0060 D5 as amended).
 *
 * Written for the development app `profitbuild-factory-dev` (its token is the only GitHub credential of the session
 * that writes this repository's code); step 4.2 reuses it for builder-app, adding an in-memory cache. Nothing here
 * touches the disk or prints: a token is returned to the caller and appears in no error message, since an error ends
 * up in a terminal or a log. Node's built-in modules only (ADR-0060 D2): this code runs next to the private key.
 *
 * Every call takes `baseUrl` (GitHub's API, or a test's fake server) and an optional `fetchImpl`.
 */
import { createPrivateKey, createSign } from 'node:crypto';

/** GitHub's REST API. */
export const GITHUB_API = 'https://api.github.com';

/**
 * How long one call waits for GitHub's answer. fetch's own limits are minutes long, and a caller that stops (the
 * dev-token watch loop revoking its token on Ctrl-C) waits for a call in flight. 4.3's GitHub helper (#0-261) adds
 * the retries; this bound stays.
 */
export const REQUEST_TIMEOUT_MS = 30 * 1000;

/** GitHub refuses a JWT whose lifetime exceeds 10 minutes; 9 leaves room for a clock a little ahead of GitHub's. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** `iat` is backdated by a minute, as GitHub advises, against a clock a little behind GitHub's. */
const JWT_BACKDATE_SECONDS = 60;

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * The JWT that authenticates as the app: RS256, `iat` now - 60 s, `exp` now + 9 min, `iss` the app's id.
 *
 * @param {{ appId: number | string, privateKey: string, now?: number }} options `privateKey` in PEM (GitHub issues
 *   PKCS#1); `now` in milliseconds, for tests.
 * @returns {string}
 */
export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  if (appId === undefined || appId === null || appId === '') {
    throw new Error('createAppJwt: appId is required');
  }
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`createAppJwt: a GitHub App key is RSA, this one is ${key.asymmetricKeyType}`);
  }
  const nowSeconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
}

/**
 * One call to GitHub's REST API, bounded by `timeoutMs` (the answer's body included). A non-2xx answer throws with the
 * method, the path, the status and GitHub's own `message`; never with a header or a body sent, which carry the
 * credential, nor with the answer's text, which may.
 */
async function githubRequest({
  baseUrl, method, path, bearer, body, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${bearer}`,
        'User-Agent': 'profitbuild-factory-dispatcher',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new Error(`GitHub ${method} ${path}: no answer in ${timeoutMs / 1000} s`);
    }
    throw new Error(`GitHub ${method} ${path}: ${error.message}`);
  }
  if (response.status === 204) {
    return null;
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`GitHub ${method} ${path}: ${error.name === 'TimeoutError'
      ? `no answer in ${timeoutMs / 1000} s` : 'the answer could not be read'}`);
  }
  // Parsed here, so that an answer which is not JSON throws without quoting it: a token's answer carries the token,
  // and JSON.parse's own message quotes the text it failed on.
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  if (!response.ok) {
    const message = typeof answer?.message === 'string' ? answer.message : '(no JSON message in the answer)';
    throw new Error(`GitHub ${method} ${path}: ${response.status} ${message}`);
  }
  if (answer === undefined) {
    throw new Error(`GitHub ${method} ${path}: ${response.status}, the answer is not JSON`);
  }
  return answer;
}

/**
 * The app's installation on one repository (`GET /repos/{owner}/{repo}/installation`, as the app).
 *
 * @returns {Promise<{ id: number, repository_selection: string, permissions: Record<string, string> }>}
 */
export async function findRepositoryInstallation({ baseUrl = GITHUB_API, jwt, owner, repo, fetchImpl, timeoutMs }) {
  return githubRequest({
    baseUrl, method: 'GET', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    bearer: jwt, fetchImpl, timeoutMs,
  });
}

/**
 * A token of one installation (`POST /app/installations/{id}/access_tokens`, as the app), narrowed to `permissions`
 * and, when given, to `repositories` (names, without the owner). GitHub answers 422 when a permission asked for is one
 * the installation does not hold.
 *
 * @returns {Promise<{ token: string, expires_at: string, permissions: Record<string, string> }>}
 */
export async function createInstallationToken({
  baseUrl = GITHUB_API, jwt, installationId, permissions, repositories, fetchImpl, timeoutMs,
}) {
  if (!Number.isInteger(installationId)) {
    throw new Error('createInstallationToken: installationId must be an integer');
  }
  return githubRequest({
    baseUrl, method: 'POST', path: `/app/installations/${installationId}/access_tokens`, bearer: jwt, fetchImpl, timeoutMs,
    body: { permissions, ...(repositories === undefined ? {} : { repositories }) },
  });
}

/**
 * Every repository an installation token reaches (`GET /installation/repositories`, every page), as `owner/name`.
 *
 * @returns {Promise<string[]>}
 */
export async function listInstallationRepositories({ baseUrl = GITHUB_API, token, fetchImpl, timeoutMs }) {
  const names = [];
  for (let page = 1; ; page += 1) {
    const answer = await githubRequest({
      baseUrl, method: 'GET', path: `/installation/repositories?per_page=100&page=${page}`, bearer: token, fetchImpl,
      timeoutMs,
    });
    names.push(...answer.repositories.map((repository) => repository.full_name));
    if (answer.repositories.length === 0 || names.length >= answer.total_count) {
      return names;
    }
  }
}

/** Revokes an installation token before it expires (`DELETE /installation/token`). */
export async function revokeInstallationToken({ baseUrl = GITHUB_API, token, fetchImpl, timeoutMs }) {
  await githubRequest({ baseUrl, method: 'DELETE', path: '/installation/token', bearer: token, fetchImpl, timeoutMs });
}
