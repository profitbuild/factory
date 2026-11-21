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
