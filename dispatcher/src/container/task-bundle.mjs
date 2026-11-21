/**
 * The task's commits leave the container only as `git bundle create -` on docker exec's stdout (incident-platform
 * backlog #0-277 AC6; stage-4.md "Decided for 4.3b"): the container's git writes the bundle to its stdout, never to a
 * file; the dispatcher writes those bytes into its own directory, $FACTORY_STATE_DIR/tasks/<runId>/bundles/ (700, a
 * file 600, O_EXCL and O_NOFOLLOW), never reads a file from a directory an agent writes, and hands them to the one
 * reader of bundles (git/bundle.mjs), with the commit it recorded as the prerequisite (4.4).
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_BUNDLE_BYTES } from '../git/bundle.mjs';
import { ensureOwnDirectory } from '../state/files.mjs';
import { ContainerRunError, stderrNote } from './run-container.mjs';
import { execInTask } from './task-container.mjs';

const SHA = /^[0-9a-f]{40}$/;

/**
 * The task's commits `<prerequisite>..<ref>` as a bundle made by the container's git on stdout, written into the
 * dispatcher's own directory.
 *
 * @param {{ stateDir: string, container: { runId: string, id: string, remoteUser: string }, prerequisite: string,
 *   ref: string, limitS?: number, sudo?: string }} options
 * @returns {Promise<{ path: string, bundle: Buffer }>}
 */
export async function bundleFromTask({ stateDir, container, prerequisite, ref, limitS = 600, sudo }) {
  if (!SHA.test(prerequisite ?? '')) {
    throw new TypeError('bundleFromTask: prerequisite must be 40 hex digits');
  }
  if (typeof ref !== 'string' || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) {
    throw new TypeError('bundleFromTask: ref must be a branch, refs/heads/<name>');
  }
  const result = await execInTask({ container, limitS, sudo, outputLimit: MAX_BUNDLE_BYTES,
    args: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'bundle', 'create', '-',
      `${prerequisite}..${ref}`] });
  if (result.code !== 0) {
    throw new ContainerRunError(`git bundle create in the task container failed (exit ${result.code}); `
      + `${stderrNote(result.stderrFile)}`);
  }
  const dir = join(stateDir, 'tasks', container.runId, 'bundles');
  await ensureOwnDirectory(join(stateDir, 'tasks'));
  await ensureOwnDirectory(join(stateDir, 'tasks', container.runId));
  await ensureOwnDirectory(dir);
  const path = join(dir, `${prerequisite.slice(0, 12)}-${randomBytes(6).toString('hex')}.bundle`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600);
  try {
    await handle.writeFile(result.stdout);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, bundle: result.stdout };
}
