// Not a test file. A fake GitHub as builder-app sees it (incident-platform backlog #0-271), on fake-github.mjs: its
// installation on incident-platform, its tokens, the repositories they reach, their revoke, and its installation on
// factory. `state` says what the fake answers; each test resets it. The ids are a test's, not builder-app's.
import { createVerify } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appKeyPair, decodeJwt, startFakeGitHub } from './fake-github.mjs';

export const APP_ID = 1001;
export const INSTALLATION_ID = 2002;
export const PERMISSIONS = Object.freeze({ contents: 'write', metadata: 'read', pull_requests: 'write' });
/** A token the fake mints: short of the 36 characters of GitHub's format, so the secret scan sees no token. */
export const tokenNumber = (n) => `ghs_BuilderFakeToken_${n}_end`;

/** Starts the fake; `clock.now` is the time its tokens' expiry counts from (a test's own clock, or Date.now). */
export async function startBuilderGitHub({ clock = { get now() { return Date.now(); } } } = {}) {
  const { publicKey, privateKey } = appKeyPair();
  const state = {};
  const reset = () => Object.assign(state, {
    installation: { id: INSTALLATION_ID, app_id: APP_ID, permissions: { ...PERMISSIONS } },
    tokenPermissions: { ...PERMISSIONS },
    repositories: ['profitbuild/incident-platform'],
    expiresInMs: 60 * 60 * 1000,
    failNextTokenRequest: false,
    tokenDelayMs: 0,
    factory: () => ({ status: 404, body: { message: 'Not Found' } }),
    minted: [],
    revoked: [],
  });
  reset();
  const jwtValid = (authorization = '') => {
    try {
      const { signed, signature, payload } = decodeJwt(authorization.replace(/^Bearer /, ''));
      return payload.iss === APP_ID && createVerify('RSA-SHA256').update(signed).verify(publicKey, signature);
    } catch {
      return false;
    }
  };
  const tokenValid = (authorization = '') => state.minted.includes(authorization.replace(/^Bearer /, ''))
    && !state.revoked.includes(authorization.replace(/^Bearer /, ''));
  const unauthorized = { status: 401, body: { message: 'Bad credentials' } };
  const fake = await startFakeGitHub({
    'GET /repos/profitbuild/incident-platform/installation': ({ headers }) => (jwtValid(headers.authorization)
      ? { status: 200, body: { repository_selection: 'selected', ...state.installation } } : unauthorized),
    'GET /repos/profitbuild/factory/installation': ({ headers }) => (jwtValid(headers.authorization)
      ? state.factory() : unauthorized),
    [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: ({ headers }) => {
      if (!jwtValid(headers.authorization)) {
        return unauthorized;
      }
      if (state.failNextTokenRequest) {
        state.failNextTokenRequest = false;
        return { status: 503, body: { message: 'Service Unavailable' } };
      }
      const token = tokenNumber(state.minted.length + 1);
      state.minted.push(token);
      return {
        status: 201,
        body: { token, expires_at: new Date(clock.now + state.expiresInMs).toISOString(),
          permissions: state.tokenPermissions, repository_selection: 'selected' },
        delayMs: state.tokenDelayMs,
      };
    },
    'GET /installation/repositories': ({ headers }) => (tokenValid(headers.authorization)
      ? { status: 200, body: { total_count: state.repositories.length,
        repositories: state.repositories.map((full_name) => ({ full_name })) } }
      : unauthorized),
    'DELETE /installation/token': ({ headers }) => {
      if (!tokenValid(headers.authorization)) {
        return unauthorized;
      }
      state.revoked.push(headers.authorization.replace(/^Bearer /, ''));
      return { status: 204 };
    },
  });
  return { ...fake, state, reset, privateKey, publicKey };
}

/**
 * A fresh directory holding the key (mode `keyMode`) and an env file naming it; returns their paths and the env.
 */
export async function writeAppFiles(root, privateKey, { keyMode = 0o600, envMode = 0o600, envText } = {}) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'app-'));
  const keyPath = join(dir, 'builder-app.pem');
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  await chmod(keyPath, keyMode);
  const envPath = join(dir, 'env');
  await writeFile(envPath, envText ?? `# a test's\nBUILDER_APP_ID=${APP_ID}\n`
    + `BUILDER_APP_INSTALLATION_ID=${INSTALLATION_ID}\nBUILDER_APP_KEY=${keyPath}\n`, { mode: 0o600 });
  await chmod(envPath, envMode);
  return { dir, keyPath, envPath, env: { appId: APP_ID, installationId: INSTALLATION_ID, keyPath } };
}

export const makeRoot = (name) => mkdtemp(join(tmpdir(), `${name}-`));

/** Every file under `dir` whose bytes contain `needle`. */
export async function filesContaining(dir, needle) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      if ((await readFile(path)).includes(needle)) {
        found.push(path);
      }
    }
  }
  return found;
}
