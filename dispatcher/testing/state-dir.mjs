// Not a test file: node --test runs every file under test/, so the helpers live here.
// A fresh $FACTORY_STATE_DIR for a test (incident-platform backlog #0-275): a temporary directory, 700, removed after.
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @returns {Promise<{ dir: string, remove: () => Promise<void> }>} */
export async function makeStateDir() {
  const dir = await mkdtemp(join(tmpdir(), 'factory-state-'));
  await chmod(dir, 0o700);
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** Every setting `run` needs, valid, for `stateDir` and `repoDir`. */
export function validEnv(stateDir, repoDir) {
  return {
    FACTORY_STATE_DIR: stateDir, FACTORY_REPO_DIR: repoDir, FACTORY_MAX_BLOCKED: '3', FACTORY_AUDIT_EVERY: '10',
    FACTORY_MAX_MERGES_PER_DAY: '5', BUILDER_APP_ID: '12', BUILDER_APP_INSTALLATION_ID: '34',
  };
}
