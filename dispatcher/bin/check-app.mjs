#!/usr/bin/env node
/**
 * Proves builder-app against GitHub, on the build VM as the dispatcher's user (incident-platform backlog #0-271):
 *
 *   node --env-file=/home/dispatcher/.config/factory/env dispatcher/bin/check-app.mjs --repository <owner/name> \
 *     [--api <url>]
 *
 * Its settings come from the environment only (ADR-0055): BUILDER_APP_ID, BUILDER_APP_INSTALLATION_ID and
 * BUILDER_APP_KEY (src/config/builder-env.mjs). Node's own --env-file loads them from the dispatcher's env file; no
 * parser of that file is the factory's, and none is in a shell. A variable already set in the environment wins over
 * the file's value. The file is trusted as code is (it can set NODE_OPTIONS): builder-env.mjs says why and who may
 * write it.
 *
 * `--repository` is the product's, as its adapter's `repository` has it (the shape is the adapter schema's), and is
 * required (incident-platform backlog #0-276): no product is named in the code. It mints a token after every check
 * (the key is a regular file of this user, readable by no one else; the installation on the repository is
 * BUILDER_APP_INSTALLATION_ID, of BUILDER_APP_ID, holding exactly
 * Contents write, Pull requests write and Metadata read; the token is narrowed to that repository, reaches only it
 * and holds the same three), expects 404 for the app's installation on profitbuild/factory, and revokes the token.
 * Each check passed is a line on stdout; the first that fails is a line on stderr, and the exit code 1. No token is
 * printed. `--api` is GitHub's API over HTTPS (or a loopback address, for the tests): the app's JWT goes to it.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readBuilderEnv } from '../src/config/builder-env.mjs';
import { GITHUB_API } from '../src/github/app-token.mjs';
import { checkApiUrl } from '../src/github/checked-token.mjs';
import { parseRepository } from '../src/github/builder-token.mjs';
import { checkApp } from '../src/github/check-app.mjs';

const say = (stream, line) => stream.write(`check-app: ${line}\n`);

export async function main(argv, env = process.env, fetchImpl = fetch) {
  const { values } = parseArgs({
    args: argv,
    options: { api: { type: 'string', default: GITHUB_API }, repository: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  checkApiUrl(values.api);
  if (values.repository === undefined) {
    throw new Error('--repository <owner/name> is required: the product\'s repository, as its adapter has it');
  }
  parseRepository(values.repository);
  const settings = readBuilderEnv(env);
  say(process.stdout, `settings: app ${settings.appId}, installation ${settings.installationId}`);
  await checkApp({ env: settings, repository: values.repository, baseUrl: values.api, fetchImpl,
    report: (line) => say(process.stdout, line) });
  say(process.stdout, 'all checks passed');
}

const isMain = import.meta.main
  ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    say(process.stderr, error.message);
    process.exitCode = 1;
  });
}
