// Not a test file: node --test runs every file under test/, so the helpers live here.
// A fresh $FACTORY_STATE_DIR for a test (incident-platform backlog #0-275): a temporary directory, 700, removed after,
// under TEST_ROOT.
import { chmodSync, mkdirSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the tests make their directories: under the user's home, not /tmp (incident-platform backlog #0-278 AC7, as
 * in review round 1 of factory#20, g). FACTORY_REPO_DIR's every directory up to / must be its user's or root's and
 * writable by no group nor others, as sshd's StrictModes holds a key's, which /tmp (1777) is not; a home is (CI's
 * runner's, and Test (git 2.43)'s useradd'ed one, their parents root's 755). Made 700.
 */
export const TEST_ROOT = join(homedir(), '.cache', 'factory-dispatcher-tests');

/**
 * Refuses a test's directory that holds anything but letters, digits, '.', '_', '-' and '/' (review round 2 of
 * factory#20, 1): the fake daemon puts it, as the container's /tmp/, into the text of the unpacking script, where
 * `rm -rf /tmp/factory-trusted.*` and `mktemp -d` stand unquoted, so a space would split `rm -rf` over a prefix of
 * the developer's home, and a glob or shell character would widen it. An allowlist: whitespace, *?[]{}$"'`\ and the
 * rest of the shell's characters are all outside it.
 *
 * @param {string} path
 * @param {string} what what the path is, for the refusal
 */
export function checkShellSafe(path, what) {
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9._/-]*$/.test(path)) {
    throw new Error(`${what} must be an absolute path of letters, digits, '.', '_', '-' and '/' alone: it goes unquoted `
      + 'into a script the fake daemon runs');
  }
}

checkShellSafe(TEST_ROOT, 'TEST_ROOT (the tests\' directory, under the home)');
mkdirSync(TEST_ROOT, { recursive: true, mode: 0o700 });
chmodSync(TEST_ROOT, 0o700);

/** @returns {Promise<{ dir: string, remove: () => Promise<void> }>} */
export async function makeStateDir() {
  const dir = await mkdtemp(join(TEST_ROOT, 'factory-state-'));
  await chmod(dir, 0o700);
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** A helper image pinned by a digest, as the provisioning gives it (a test's: no daemon pulls it). */
export const HELPER_IMAGE = `buildpack-deps:noble-scm@sha256:${'a1'.repeat(32)}`;

/** Every setting `run` needs, valid, for `stateDir` and `repoDir`. */
export function validEnv(stateDir, repoDir) {
  return {
    FACTORY_STATE_DIR: stateDir, FACTORY_REPO_DIR: repoDir, FACTORY_MAX_BLOCKED: '3', FACTORY_AUDIT_EVERY: '10',
    FACTORY_MAX_MERGES_PER_DAY: '5', FACTORY_HELPER_IMAGE: HELPER_IMAGE, BUILDER_APP_ID: '12', BUILDER_APP_INSTALLATION_ID: '34',
  };
}
