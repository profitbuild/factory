// Not a test file. A product whose main holds an adapter, `.factory/adapter.json`, and every path it names (incident-
// platform backlog #0-278): the fixture's adapter (testing/fixtures/incident-platform.adapter.json), its scripts
// executable, each printing where it ran from and its arguments, with the task configuration of task-product.mjs.
// Made by the test's git, as FACTORY_REPO_DIR holds it: a bare clone; `commit` adds a commit to the work tree's main
// (and to the bare clone with `push`), as a merged pull request would.
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git } from './git-fixtures.mjs';
import { makeTaskProduct } from './task-product.mjs';

/** The fixture's adapter, as incident-platform's will be. */
export const ADAPTER = Object.freeze(JSON.parse(readFileSync(new URL('./fixtures/incident-platform.adapter.json',
  import.meta.url), 'utf8')));

/** A script of the product: prints its name, the directory it ran in, where it was read from, and its arguments. */
export const script = (name) => `#!/bin/sh\necho "${name} from the base"\necho "cwd=$(pwd)"\necho "dir=$(dirname "$0")"\n`
  + 'echo "args=$*"\n';

/** The files of the product's main that the adapter names, `adapter` written as its .factory/adapter.json. */
export function adapterFiles(adapter = ADAPTER) {
  return {
    '.factory/adapter.json': `${JSON.stringify(adapter, null, 2)}\n`,
    'scripts/factory/run-tests.sh': script('run-tests'),
    'scripts/factory/changed-paths.sh': script('changed-paths'),
    'scripts/factory/lib/common.sh': 'common=1\n',
    'BACKLOG.md': '# Backlog\n',
    '.ai/plan/queue.md': '# Queue\n',
    '.ai/rules/protected-paths.md': '# Protected paths\n',
  };
}

export const SCRIPTS = Object.freeze(['scripts/factory/run-tests.sh', 'scripts/factory/changed-paths.sh']);

/**
 * @param {string} root
 * @param {{ adapter?: object, files?: Record<string, string | null>, links?: Record<string, string>,
 *   executable?: string[] }} [options] `files` added to, or (null) taken from, the adapter's
 * @returns {Promise<{ work: string, repoDir: string, base: string }>}
 */
export async function makeAdapterProduct(root, { adapter = ADAPTER, files = {}, links = {}, executable = SCRIPTS } = {}) {
  return makeTaskProduct(root, { files: { ...adapterFiles(adapter), ...files }, links, executable });
}

/**
 * A commit on the work tree's main: `files` written (null removes one), `links` made; returns its sha.
 *
 * @param {string} work
 * @param {{ files?: Record<string, string | null>, links?: Record<string, string>, executable?: string[],
 *   message?: string }} change
 */
export async function commit(work, { files = {}, links = {}, executable = [], message = 'a change' }) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      await rm(join(work, path), { recursive: true, force: true });
      continue;
    }
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), text);
    if (executable.includes(path)) {
      await chmod(join(work, path), 0o755);
    }
  }
  for (const [path, target] of Object.entries(links)) {
    await rm(join(work, path), { recursive: true, force: true });
    await mkdir(join(work, path, '..'), { recursive: true });
    await symlink(target, join(work, path));
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', message]);
  return git(work, ['rev-parse', 'HEAD']);
}
