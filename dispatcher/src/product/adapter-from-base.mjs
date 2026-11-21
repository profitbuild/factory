/**
 * The product's adapter, `.factory/adapter.json`, read from a base commit of the dispatcher's own clone of main
 * (FACTORY_REPO_DIR), as a blob of the git tree, never from a checkout nor from a task's branch (incident-platform
 * ADR-0060 D6 as amended, backlog #0-278 AC3, AC5). It is checked against schemas/adapter.schema.json (the spelling of
 * its fields: adapter.mjs), then against the base's tree (checkAdapterPaths):
 *  - every path it names is in the base, reached through directories alone, no symlink and no submodule on the way or
 *    at it (product/base-tree.mjs): `trustedPaths` entries ending with / directories with none under them either,
 *    every other path a file;
 *  - the script of each command (`gate`, `changedPaths`) is executable in the base and lies under an entry of
 *    `trustedPaths`, so a task cannot change it (product/trusted-paths.mjs);
 *  - the adapter itself lies under an entry of `trustedPaths`: a task can no more change the adapter that names the
 *    scripts than the scripts (AC4).
 * A refusal names the field (`gate.command[0]`, `trustedPaths[1]`) and the segment, never a value read from the base.
 */
import { AdapterError, checkAdapter } from '../adapter.mjs';
import { BaseTreeError, MODES, readBlobs, resolveInBase, subtreeFiles } from './base-tree.mjs';
import { isUnder } from './trusted-paths.mjs';

/** Where a product holds its adapter: the one path of a product the factory names. */
export const ADAPTER_PATH = '.factory/adapter.json';

/** The adapter's paths: [field, path, kind], in the order they are checked. */
function pathsOf(adapter) {
  return [
    ['gate.command[0]', adapter.gate.command[0], 'file'],
    ['changedPaths.command[0]', adapter.changedPaths.command[0], 'file'],
    ...adapter.queue.files.map((path, i) => [`queue.files[${i}]`, path, 'file']),
    ['protectedPaths.file', adapter.protectedPaths.file, 'file'],
    ...adapter.trustedPaths.map((path, i) => [`trustedPaths[${i}]`, path.endsWith('/') ? path.slice(0, -1) : path,
      path.endsWith('/') ? 'tree' : 'file']),
    ['taskImage', adapter.taskImage, 'file'],
  ];
}

/**
 * Refuses `adapter` (checked against its schema) unless it holds in the base's tree.
 *
 * @param {{ repoDir: string, base: string, adapter: object, git?: string }} options `git` for the tests only
 */
export async function checkAdapterPaths({ repoDir, base, adapter, git }) {
  const modes = new Map();
  for (const [field, path, kind] of pathsOf(adapter)) {
    const what = `the adapter's ${field}`;
    const { mode } = await resolveInBase({ repoDir, base, path, kind, what, git });
    modes.set(field, mode);
    if (kind === 'tree') {
      // What the task container is given of it (product/commands.mjs), refused here already: no symlink inside.
      await subtreeFiles({ repoDir, base, dir: path, what, git });
    }
  }
  for (const field of ['gate.command[0]', 'changedPaths.command[0]']) {
    const script = field === 'gate.command[0]' ? adapter.gate.command[0] : adapter.changedPaths.command[0];
    if (!adapter.trustedPaths.some((entry) => isUnder(entry, script))) {
      throw new AdapterError(`the adapter's ${field} is not under any of its trustedPaths: a task could change it`);
    }
    if (modes.get(field) !== MODES.executable) {
      throw new AdapterError(`the adapter's ${field} is not executable in the base (mode ${MODES.executable})`);
    }
  }
  if (!adapter.trustedPaths.some((entry) => isUnder(entry, ADAPTER_PATH))) {
    throw new AdapterError(`the adapter ${ADAPTER_PATH} is not under any of its trustedPaths: a task could change it`);
  }
}

/**
 * The adapter at the commit `base` of FACTORY_REPO_DIR: read as a blob, parsed, checked against its schema and the
 * base's tree. A base that holds none is an AdapterError whose `missing` is true, for the caller's remedy.
 *
 * @param {{ repoDir: string, base: string, git?: string }} options `git` for the tests only
 * @returns {Promise<object>} a deep frozen copy
 */
export async function readAdapter({ repoDir, base, git }) {
  const what = `the adapter ${ADAPTER_PATH}`;
  let entry;
  try {
    entry = await resolveInBase({ repoDir, base, path: ADAPTER_PATH, kind: 'file', what, git });
  } catch (error) {
    if (error instanceof BaseTreeError && error.missing === true) {
      throw Object.assign(new AdapterError(`the base holds no ${ADAPTER_PATH}`), { missing: true });
    }
    throw error;
  }
  const [blob] = await readBlobs({ repoDir, oids: [entry.oid], git, what });
  let value;
  try {
    value = JSON.parse(blob.toString('utf8'));
  } catch {
    throw new AdapterError(`${what} of the base is not JSON`);
  }
  const adapter = checkAdapter(value);
  await checkAdapterPaths({ repoDir, base, adapter, git });
  return adapter;
}
