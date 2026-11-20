/**
 * check-app (incident-platform backlog #0-271): proves builder-app against GitHub without using it. Mints a token
 * for the product's repository (`repository`, owner/name: #0-276 takes it from the caller, not from a constant)
 * after every check of mintBuilderToken, asks GitHub with the app's JWT for its installation on profitbuild/factory
 * and expects 404 (the app is never on factory, ADR-0060 D5), then revokes the token, whatever happened in between.
 * Each step that passed is told to `report`; the first that fails throws. No token, JWT or key is told or thrown.
 */
import { createAppJwt, findRepositoryInstallation, GITHUB_API, revokeInstallationToken } from './app-token.mjs';
import { readAppKey } from './checked-token.mjs';
import { mintBuilderToken } from './builder-token.mjs';

/** The repository builder-app must never be installed on. */
export const FORBIDDEN_REPOSITORY = Object.freeze({ owner: 'profitbuild', repo: 'factory' });

/** The app's installation on factory answered anything but 404. */
export class InstalledOnFactoryError extends Error {}

/**
 * @param {{ env: { appId: number, installationId: number, keyPath: string }, repository: string, baseUrl?: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number, uid?: number, report: (line: string) => void }} options
 */
export async function checkApp({ env, repository, baseUrl = GITHUB_API, fetchImpl, timeoutMs, uid, report }) {
  const call = { baseUrl, fetchImpl, timeoutMs };
  const { token } = await mintBuilderToken({ ...call, env, repository, uid, report });
  let failure = null;
  try {
    await expectNoInstallationOnFactory({ ...call, env, uid });
    report(`no installation on ${FORBIDDEN_REPOSITORY.owner}/${FORBIDDEN_REPOSITORY.repo} (404): ok`);
  } catch (error) {
    failure = error;
  }
  try {
    await revokeInstallationToken({ ...call, token });
    report('token revoked');
  } catch (error) {
    failure ??= new Error(`the token could not be revoked (it expires within the hour): ${error.message}`);
  }
  if (failure) {
    throw failure;
  }
}

async function expectNoInstallationOnFactory({ env, uid, ...call }) {
  const where = `${FORBIDDEN_REPOSITORY.owner}/${FORBIDDEN_REPOSITORY.repo}`;
  const jwt = createAppJwt({ appId: env.appId, privateKey: await readAppKey(env.keyPath, { uid }) });
  let installation;
  try {
    installation = await findRepositoryInstallation({ ...call, jwt, ...FORBIDDEN_REPOSITORY });
  } catch (error) {
    if (error.status === 404) {
      return;
    }
    throw new InstalledOnFactoryError(`the app's installation on ${where} must answer 404, not this: ${error.message}`);
  }
  throw new InstalledOnFactoryError(`the app is installed on ${where} (installation ${installation?.id}): `
    + 'it must never be (ADR-0060 D5)');
}
