// The app-token module (incident-platform backlog #0-269): the JWT GitHub accepts, and the REST calls against a fake
// GitHub. A key pair is generated per run; no real key or token is involved.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';

import {
  createAppJwt, createInstallationToken, findRepositoryInstallation, listInstallationRepositories,
  revokeInstallationToken,
} from '../src/github/app-token.mjs';
import { appKeyPair, decodeJwt, startFakeGitHub } from '../testing/fake-github.mjs';

const { publicKey, privateKey } = appKeyPair();
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

const verifies = (jwt) => {
  const { signed, signature } = decodeJwt(jwt);
  return createVerify('RSA-SHA256').update(signed).verify(publicKey, signature);
};

test('the JWT is RS256, signed by the key, iat 60 s back, exp 9 min ahead, iss the app id', () => {
  const jwt = createAppJwt({ appId: 5822112, privateKey, now: NOW });
  const { header, payload } = decodeJwt(jwt);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(payload, { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: 5822112 });
  assert.ok(payload.exp - payload.iat <= 600, 'GitHub refuses a JWT living more than 10 minutes');
  assert.ok(verifies(jwt));
});

test('a JWT signed by another key does not verify (the check above can fail)', () => {
  const other = appKeyPair().privateKey;
  assert.equal(verifies(createAppJwt({ appId: 1, privateKey: other, now: NOW })), false);
});

test('a key that is not RSA, or no app id, is refused', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  assert.throws(() => createAppJwt({ appId: 1, privateKey: ec }), /RSA/);
  assert.throws(() => createAppJwt({ privateKey }), /appId is required/);
});

const fake = await startFakeGitHub({
  'GET /repos/profitbuild/factory/installation': () => ({
    status: 200, body: { id: 42, repository_selection: 'selected', permissions: { contents: 'write' } },
  }),
  'POST /app/installations/42/access_tokens': () => ({
    status: 201, body: { token: 'ghs_fake', expires_at: '2026-11-19T13:00:00Z', permissions: { contents: 'write' } },
  }),
  'POST /app/installations/7/access_tokens': () => ({
    status: 422, body: { message: 'The permissions requested are not granted to this installation.' },
  }),
  'GET /installation/repositories': ({ query }) => ({
    status: 200,
    body: query.get('page') === '1'
      ? { total_count: 2, repositories: [{ full_name: 'profitbuild/factory' }] }
      : { total_count: 2, repositories: [{ full_name: 'profitbuild/other' }] },
  }),
  'DELETE /installation/token': () => ({ status: 204 }),
  'GET /repos/x/broken/installation': () => ({ status: 200, body: undefined }),
  'GET /repos/x/slow/installation': () => ({ status: 200, body: { id: 1 }, delayMs: 1000 }),
});
after(() => fake.close());

test('the installation is looked up as the app, with the JWT as bearer and the API version', async () => {
  const answer = await findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'jwt.x.y', owner: 'profitbuild',
    repo: 'factory' });
  assert.equal(answer.id, 42);
  const request = fake.requests.at(-1);
  assert.equal(request.headers.authorization, 'Bearer jwt.x.y');
  assert.equal(request.headers.accept, 'application/vnd.github+json');
  assert.equal(request.headers['x-github-api-version'], '2022-11-28');
});

test('the token request carries the permissions, and the repositories only when given', async () => {
  const answer = await createInstallationToken({ baseUrl: fake.baseUrl, jwt: 'j', installationId: 42,
    permissions: { contents: 'write' } });
  assert.equal(answer.token, 'ghs_fake');
  assert.deepEqual(fake.requests.at(-1).body, { permissions: { contents: 'write' } });
  await createInstallationToken({ baseUrl: fake.baseUrl, jwt: 'j', installationId: 42,
    permissions: { contents: 'write' }, repositories: ['factory'] });
  assert.deepEqual(fake.requests.at(-1).body, { permissions: { contents: 'write' }, repositories: ['factory'] });
  await assert.rejects(createInstallationToken({ baseUrl: fake.baseUrl, jwt: 'j', installationId: '42',
    permissions: {} }), /integer/);
});

test('a refusal throws with the status and GitHub\'s message, never the credential sent', async () => {
  await assert.rejects(
    createInstallationToken({ baseUrl: fake.baseUrl, jwt: 'secret-jwt', installationId: 7, permissions: {} }),
    (error) => {
      assert.match(error.message, /POST \/app\/installations\/7\/access_tokens: 422 The permissions requested/);
      assert.doesNotMatch(error.message, /secret-jwt/);
      return true;
    },
  );
  await assert.rejects(findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'j', owner: 'x', repo: 'y' }),
    /404 Not Found/);
});

test('a refusal carries GitHub\'s status as error.status (check-app expects 404, #0-271)', async () => {
  await assert.rejects(findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'j', owner: 'x', repo: 'y' }),
    { status: 404 });
  await assert.rejects(createInstallationToken({ baseUrl: fake.baseUrl, jwt: 'j', installationId: 7, permissions: {} }),
    { status: 422 });
});

test('the repositories of a token are read from every page', async () => {
  assert.deepEqual(await listInstallationRepositories({ baseUrl: fake.baseUrl, token: 't' }),
    ['profitbuild/factory', 'profitbuild/other']);
});

test('a token is revoked with DELETE /installation/token, as itself', async () => {
  await revokeInstallationToken({ baseUrl: fake.baseUrl, token: 'ghs_fake' });
  const request = fake.requests.at(-1);
  assert.equal(`${request.method} ${request.path}`, 'DELETE /installation/token');
  assert.equal(request.headers.authorization, 'Bearer ghs_fake');
});

test('an answer that is not JSON throws without quoting it', async () => {
  await assert.rejects(findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'j', owner: 'x', repo: 'broken' }),
    /GET \/repos\/x\/broken\/installation: 200, the answer is not JSON$/);
});

test('a timeout and a network failure carry kind and cause, their messages unchanged, no credential (#0-261)',
  async () => {
    await assert.rejects(findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'secret-jwt', owner: 'x',
      repo: 'slow', timeoutMs: 100 }), (error) => {
      assert.equal(error.message, 'GitHub GET /repos/x/slow/installation: no answer in 0.1 s');
      assert.equal(error.kind, 'timeout');
      assert.equal(error.cause?.name, 'TimeoutError');
      assert.equal(error.status, undefined);
      assert.doesNotMatch(inspect(error, { depth: 10 }), /secret-jwt/);
      return true;
    });
    // A port that was listening and is closed: the connection is refused.
    const closed = await startFakeGitHub({});
    await closed.close();
    await assert.rejects(findRepositoryInstallation({ baseUrl: closed.baseUrl, jwt: 'secret-jwt', owner: 'x',
      repo: 'y' }), (error) => {
      assert.equal(error.message, 'GitHub GET /repos/x/y/installation: fetch failed');
      assert.equal(error.kind, 'network');
      assert.ok(error.cause instanceof Error);
      assert.doesNotMatch(inspect(error, { depth: 10 }), /secret-jwt/);
      return true;
    });
    await assert.rejects(findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'j', owner: 'x', repo: 'y' }),
      (error) => error.status === 404 && error.kind === undefined, 'an answer of GitHub\'s has a status, no kind');
  });

test('a call GitHub does not answer in time throws, naming the call and the wait', async () => {
  const started = Date.now();
  await assert.rejects(findRepositoryInstallation({ baseUrl: fake.baseUrl, jwt: 'secret-jwt', owner: 'x', repo: 'slow',
    timeoutMs: 100 }), (error) => {
    assert.equal(error.message, 'GitHub GET /repos/x/slow/installation: no answer in 0.1 s');
    return true;
  });
  assert.ok(Date.now() - started < 900, 'it gave up at the timeout, not at the answer');
});
