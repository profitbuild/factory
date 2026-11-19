#!/usr/bin/env node
/**
 * Mints the token of the development app `profitbuild-factory-dev` on the owner's Mac and writes it where the
 * factory's devcontainer reads it (incident-platform backlog #0-269, ADR-0060 D5 as amended). Run on the host, from
 * the owner's clone on `main`, never inside the container: the key stays on the host, and the container, whose
 * workspace is a volume of its own, cannot change this file before the host runs it.
 *
 *   node dispatcher/bin/dev-token.mjs            one token, then exit
 *   node dispatcher/bin/dev-token.mjs --watch    a new token 10 minutes before the last one expires; Ctrl-C,
 *                                                SIGTERM or SIGHUP (the terminal closed) waits for a token being
 *                                                minted, then revokes the current one and deletes the file
 *
 * Before writing a token it checks what GitHub says, and refuses otherwise:
 * - the key file is readable by its owner only;
 * - the installation holds exactly Contents write, Pull requests write and Metadata read;
 * - the token reaches exactly one repository, profitbuild/factory (the installation's scope, proven on every token
 *   rather than once by eye: a token is not narrowed to the repository for that reason, since a narrowed one would
 *   always list one);
 * - the token's permissions are the same three.
 * The token goes to `<out>/token` (directory 700, file 600, written to a temporary file and renamed, so a reader never
 * sees half of one), never to argv, the environment, stdout or stderr. `<out>` must not hold the key, symlinks
 * resolved: it is mounted into the container. `--api` is GitHub's API over HTTPS (or a loopback address, for the tests):
 * the app's JWT goes to it.
 *
 * In `--watch`, a refusal (one of the checks above) revokes the last token and deletes the file, so the container is
 * left with none rather than with one GitHub's answers no longer back; a failure to reach GitHub keeps the last token,
 * still valid, and tries again. `--retry-seconds` (default 60) is the wait before another try and the shortest wait
 * before a refresh; the tests shorten it.
 */
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

import {
  GITHUB_API, createAppJwt, createInstallationToken, findRepositoryInstallation, listInstallationRepositories,
  revokeInstallationToken,
} from '../src/github/app-token.mjs';

/** The app `profitbuild-factory-dev` (an id, not a secret). */
const APP_ID = 5822112;
/** What the app holds, and the only thing its token may hold (ADR-0060 D5 as amended). */
export const EXPECTED_PERMISSIONS = Object.freeze({ contents: 'write', metadata: 'read', pull_requests: 'write' });

const REFRESH_BEFORE_EXPIRY_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_SECONDS = 60;

/** A check against GitHub's answers failed: no token may stand on it (as opposed to GitHub not being reached). */
export class RefusedError extends Error {}

const log = (message) => process.stderr.write(`dev-token: ${message}\n`);
// A terminal that hung up (SIGHUP) makes a write to stderr fail; unhandled, that error would end the process before
// the token is revoked (review round 4). The message is lost, the revoke is not.
process.stderr.on('error', () => {});

/** When the next token is minted: 10 minutes before `expiresAt`, and never sooner than `floorMs` from now. */
export function refreshDelayMs(expiresAt, now = Date.now(), floorMs = DEFAULT_RETRY_SECONDS * 1000) {
  return Math.max(new Date(expiresAt).getTime() - REFRESH_BEFORE_EXPIRY_MS - now, floorMs);
}

/** HTTPS, or plain HTTP to a loopback address (the tests' fake GitHub); anything else would get the app's JWT. */
function checkApi(api) {
  const url = new URL(api);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`--api must be an https:// URL, not ${url.protocol}//${url.host}`);
  }
  return api;
}

/** The real path of `path`, or of its nearest existing ancestor with the rest appended (a directory not made yet). */
async function realPathOf(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) {
      throw error;
    }
    return join(await realPathOf(dirname(path)), relative(dirname(path), path));
  }
}

const sortedEntries = (permissions) => Object.fromEntries(Object.entries(permissions ?? {}).sort());

async function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      watch: { type: 'boolean', default: false },
      'app-id': { type: 'string', default: String(APP_ID) },
      owner: { type: 'string', default: 'profitbuild' },
      repo: { type: 'string', default: 'factory' },
      key: { type: 'string', default: join(homedir(), '.config', 'profitbuild-factory-dev', 'app.pem') },
      out: { type: 'string', default: join(homedir(), '.local', 'state', 'profitbuild-factory-dev') },
      api: { type: 'string', default: GITHUB_API },
      'retry-seconds': { type: 'string', default: String(DEFAULT_RETRY_SECONDS) },
    },
    strict: true,
    allowPositionals: false,
  });
  const appId = Number(values['app-id']);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error(`--app-id must be a positive integer, not ${values['app-id']}`);
  }
  const retrySeconds = Number(values['retry-seconds']);
  if (!(retrySeconds > 0)) {
    throw new Error(`--retry-seconds must be a positive number, not ${values['retry-seconds']}`);
  }
  checkApi(values.api);
  const key = await realPathOf(resolve(values.key));
  const out = await realPathOf(resolve(values.out));
  const fromOut = relative(out, dirname(key));
  if (fromOut === '' || (!fromOut.startsWith('..') && !isAbsolute(fromOut))) {
    throw new Error(`--out ${out} holds the key ${key}, and it is mounted into the container: choose another directory`);
  }
  return { ...values, appId, key, out, retryMs: retrySeconds * 1000 };
}

async function readKey(path) {
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) {
    throw new RefusedError(`the key ${path} is readable by others (mode ${(mode & 0o777).toString(8)}): chmod 600 it`);
  }
  return readFile(path, 'utf8');
}

async function writeToken(out, token) {
  await mkdir(out, { recursive: true, mode: 0o700 });
  await chmod(out, 0o700);
  const temporary = join(out, `.token.${process.pid}.tmp`);
  await writeFile(temporary, token, { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(out, 'token'));
}

/** One token: checked against GitHub's answers as the header says, then written. Returns it for the watch loop. */
export async function mint(opts, fetchImpl) {
  const privateKey = await readKey(opts.key);
  const jwt = createAppJwt({ appId: opts.appId, privateKey });
  const installation = await findRepositoryInstallation({
    baseUrl: opts.api, jwt, owner: opts.owner, repo: opts.repo, fetchImpl,
  });
  if (!isDeepStrictEqual(sortedEntries(installation.permissions), EXPECTED_PERMISSIONS)) {
    throw new RefusedError(`the installation holds ${JSON.stringify(sortedEntries(installation.permissions))}, `
      + `not exactly ${JSON.stringify(EXPECTED_PERMISSIONS)}: no token written`);
  }
  const answer = await createInstallationToken({
    baseUrl: opts.api, jwt, installationId: installation.id, permissions: { ...EXPECTED_PERMISSIONS }, fetchImpl,
  });
  const { token } = answer;
  try {
    const repositories = await listInstallationRepositories({ baseUrl: opts.api, token, fetchImpl });
    const expected = [`${opts.owner}/${opts.repo}`];
    if (!isDeepStrictEqual(repositories, expected)) {
      throw new RefusedError(`the token reaches ${JSON.stringify(repositories)}, not only ${expected[0]}: `
        + 'the app is installed on more than this repository; no token written');
    }
    if (!isDeepStrictEqual(sortedEntries(answer.permissions), EXPECTED_PERMISSIONS)) {
      throw new RefusedError(`the token holds ${JSON.stringify(sortedEntries(answer.permissions))}: no token written`);
    }
    await writeToken(opts.out, token);
  } catch (error) {
    await revokeQuietly(opts, token, fetchImpl);
    throw error;
  }
  log(`a token for ${opts.owner}/${opts.repo} in ${join(opts.out, 'token')}, expires ${answer.expires_at}`);
  return { token, expiresAt: answer.expires_at };
}

/** Revokes a token; a failure is logged, not thrown (it expires within the hour anyway). */
async function revokeQuietly(opts, token, fetchImpl) {
  try {
    await revokeInstallationToken({ baseUrl: opts.api, token, fetchImpl });
  } catch (error) {
    log(`could not revoke a token (it expires within the hour): ${error.message}`);
  }
}

async function watch(opts, fetchImpl) {
  const tokenPath = join(opts.out, 'token');
  let current = null;
  let timer = null;
  let inFlight = Promise.resolve();
  let stopping = false;
  /** Revokes the current token and deletes its file; false when the file could not be deleted. */
  const dropCurrent = async () => {
    if (current) {
      await revokeQuietly(opts, current.token, fetchImpl);
      current = null;
    }
    try {
      await rm(tokenPath, { force: true });
      return true;
    } catch (error) {
      log(`could not delete ${tokenPath} (${error.code ?? error.message}): delete it by hand`);
      return false;
    }
  };
  const round = async () => {
    try {
      const previous = current;
      current = await mint(opts, fetchImpl);
      if (previous) {
        await revokeQuietly(opts, previous.token, fetchImpl);
      }
      if (!stopping) {
        timer = setTimeout(schedule, refreshDelayMs(current.expiresAt, Date.now(), opts.retryMs));
      }
    } catch (error) {
      if (error instanceof RefusedError) {
        log(`${error.message}; the last token is revoked and ${tokenPath} deleted`);
        await dropCurrent();
      } else {
        log(`${error.message}; the last token, if any, is kept`);
      }
      if (!stopping) {
        log(`next try in ${opts.retryMs / 1000} s`);
        timer = setTimeout(schedule, opts.retryMs);
      }
    }
  };
  function schedule() {
    inFlight = round();
  }
  const stop = async (signal) => {
    // A second Ctrl-C while the first waits is ignored, not left to Node's default exit, which would skip the revoke.
    if (stopping) {
      log(`${signal}: already stopping`);
      return;
    }
    stopping = true;
    clearTimeout(timer);
    log(`${signal}: revoking the current token and deleting ${tokenPath}`);
    // A token being minted is written after this point otherwise, and outlives the session.
    // Exit 1 when the file is left behind (its token revoked), so a wrapper can tell it from a clean stop.
    let deleted = false;
    try {
      await inFlight;
      deleted = await dropCurrent();
    } finally {
      process.exit(deleted ? 0 : 1);
    }
  };
  // SIGHUP too: closing the terminal window sends it, and Node's default would exit without the revoke (review round 3).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => stop(signal));
  }
  schedule();
  await inFlight;
}

export async function main(argv, fetchImpl = fetch) {
  const opts = await options(argv);
  if (opts.watch) {
    await watch(opts, fetchImpl);
  } else {
    await mint(opts, fetchImpl);
  }
}

// import.meta.main is Node 24.2's; the comparison is the same test for a Node without it, which would otherwise exit 0
// having written nothing.
const isMain = import.meta.main
  ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    log(error.message);
    process.exit(1);
  });
}
