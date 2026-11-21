/**
 * The product's commands, `gate` and `changedPaths`, run only in the task container, from the base's blobs of the
 * adapter's `trustedPaths`, never from the branch's copy nor from what the container holds (incident-platform ADR-0060
 * D6 as amended, backlog #0-278 AC2, AC6). No product code runs as `dispatcher`: the dispatcher reads the blobs from
 * its own clone (product/base-tree.mjs), packs them, and hands them over on stdin.
 *
 * Before each run, two calls through execInTask (the starter of #0-277, under `timeout`):
 *  1. the archive on stdin, unpacked by a constant script into a fresh directory, `mktemp -d
 *     /tmp/factory-trusted.XXXXXXXX`, outside the clone (any such directory a run before left is removed first); the
 *     script prints the directory, which the dispatcher holds to TRUSTED_DIR before it uses it;
 *  2. `cd -- <the clone> && exec <the directory>/<script> <arguments>`: the product's root as the working directory, the
 *     script and its arguments the base's adapter's.
 * The contract this gives a product's command (README, schemas/adapter.schema.json): only what its script reads
 * relative to itself ($(dirname "$0")) is the base's; a file it reads by a path relative to the clone is the copy in
 * the agent's working tree. The adapter is read here, from the base, never taken from the caller.
 * Two calls, not one with an exit code of its own for "could not unpack": `timeout` exits 125 when it fails itself,
 * and a product's script may exit with any code. What the second call prints is the agent's side: the caller (4.4)
 * reads it against its schema, and neither the review zone nor a refusal of the dispatcher rests on it.
 *
 * The archive is the dispatcher's own ustar, built here: directories (type 5) and regular files (type 0) only, each
 * file's mode its git mode (644 or 755), its path one of the base's tree, checked again (relative, no empty, . or ..
 * segment, no control character), so it holds no symlink, no hard link, no device and no absolute path by
 * construction. A symlink or a submodule under a trusted directory refuses the command (base-tree.mjs). What this
 * does not do: the commands run as the container's user, the agent's, so a process the agent left running there could
 * change the directory between the two calls; the copy it guards against is the branch's, and CI is the gate that
 * counts.
 */
import { WORKSPACE } from '../container/paths.mjs';
import { execInTask } from '../container/task-container.mjs';
import { readAdapter } from './adapter-from-base.mjs';
import { MODES, readBlobs, resolveInBase, segmentsOf, subtreeFiles } from './base-tree.mjs';

/** The product's command could not be put into the task container, or is not one the adapter may name. */
export class ProductCommandError extends Error {}

/** Where the trusted paths are unpacked: what mktemp makes of /tmp/factory-trusted.XXXXXXXX. */
export const TRUSTED_DIR = /^\/tmp\/factory-trusted\.[A-Za-z0-9]{8}$/;
/** The commands the adapter names, by their field. */
export const COMMANDS = Object.freeze(['gate', 'changedPaths']);
/** The longest the unpacking may run. */
export const UNPACK_LIMIT_S = 60;

const UNPACK = [
  'set -eu',
  'umask 077',
  'rm -rf /tmp/factory-trusted.*',
  'd=$(mktemp -d /tmp/factory-trusted.XXXXXXXX)',
  'tar -x -m --no-same-owner -f - -C "$d"',
  'printf \'%s\\n\' "$d"',
].join('\n');
const RUN = 'cd -- "$1" && d=$2 && s=$3 && shift 3 && exec "$d/$s" "$@"';

const BLOCK = 512;
const refuse = (message) => { throw new ProductCommandError(message); };

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** A ustar header of `path` (a file of `size` bytes, or a directory), its name split into prefix and name. */
function header(path, { type, mode, size = 0 }) {
  const bytes = Buffer.from(path, 'utf8');
  let name = bytes;
  let prefix = Buffer.alloc(0);
  if (bytes.length > 100) {
    // Split at a / with at most 155 bytes before it and 1 to 100 after it.
    const at = [...path.matchAll(/\//g)].map((m) => m.index).find((i) => Buffer.byteLength(path.slice(0, i)) <= 155
      && i < path.length - 1 && Buffer.byteLength(path.slice(i + 1)) <= 100);
    if (at === undefined) {
      refuse('a path of the trusted paths is too long for the archive (ustar: 255 bytes, split at a /)');
    }
    prefix = Buffer.from(path.slice(0, at), 'utf8');
    name = Buffer.from(path.slice(at + 1), 'utf8');
  }
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0);
  block.write(octal(mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  prefix.copy(block, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/**
 * The ustar archive of `files` ({ path, mode, bytes }): their directories first, then the files, then two empty
 * blocks.
 *
 * @param {{ path: string, mode: string, bytes: Buffer }[]} files
 * @returns {Buffer}
 */
export function ustar(files) {
  const dirs = new Set();
  for (const { path } of files) {
    const segments = segmentsOf(path, 'a path of the trusted paths');
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      refuse('a path of the trusted paths holds a control character');
    }
    segments.slice(0, -1).forEach((_, i) => dirs.add(segments.slice(0, i + 1).join('/')));
  }
  const parts = [...dirs].sort().map((dir) => header(`${dir}/`, { type: '5', mode: 0o755 }));
  for (const { path, mode, bytes } of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    parts.push(header(path, { type: '0', mode: mode === MODES.executable ? 0o755 : 0o644, size: bytes.length }), bytes,
      Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

/** The archive of `adapter`'s `trustedPaths` (the base's adapter, as readAdapter returns it), from the base's blobs. */
async function archiveOf({ repoDir, base, adapter, git }) {
  const byPath = new Map();
  for (const [i, entry] of adapter.trustedPaths.entries()) {
    const what = `the adapter's trustedPaths[${i}]`;
    const found = entry.endsWith('/')
      ? await subtreeFiles({ repoDir, base, dir: entry.slice(0, -1), what, git })
      : [{ path: entry, ...await resolveInBase({ repoDir, base, path: entry, kind: 'file', what, git }) }];
    found.forEach((file) => byPath.set(file.path, file));
  }
  const files = [...byPath.values()];
  const blobs = await readBlobs({ repoDir, oids: files.map((f) => f.oid), git, what: 'the adapter\'s trustedPaths' });
  return ustar(files.map((file, i) => ({ path: file.path, mode: file.mode, bytes: blobs[i] })));
}

/**
 * The archive of the trustedPaths of the base's adapter, from the base's blobs: what the first call is given.
 *
 * @param {{ repoDir: string, base: string, git?: string }} options
 */
export async function trustedArchive({ repoDir, base, git }) {
  return archiveOf({ repoDir, base, adapter: await readAdapter({ repoDir, base, git }), git });
}

/**
 * The directory the first call printed, refused unless the call exited 0 and printed one line of TRUSTED_DIR's shape.
 *
 * @param {{ code: number, stdout: Buffer }} result
 * @returns {string}
 */
export function unpackedDir({ code, stdout }) {
  const dir = stdout.toString('utf8').replace(/\n$/, '');
  if (code !== 0 || !TRUSTED_DIR.test(dir)) {
    refuse(`the trusted paths could not be put into the task container (exit ${code}${code === 0
      ? ', no directory of /tmp/factory-trusted.XXXXXXXX printed' : ''}); its stderr, the agent's side's, is not `
      + 'quoted');
  }
  return dir;
}

/**
 * The product's command `which` of the base's adapter, run in the task container from the base's blobs. The adapter is
 * read here, from `base` (readAdapter, with every check of its paths: a script's segments, under trustedPaths,
 * executable), so that no caller can hand it another, a branch's included (review round 1 of factory#20, e).
 *
 * @param {{ container: { runId: string, id: string, remoteUser: string }, repoDir: string, base: string,
 *   which: 'gate' | 'changedPaths', limitS: number, graceS?: number, env?: Record<string, string>,
 *   outputLimit?: number, sudo?: string, git?: string }} options `base` the task's; `sudo` and `git` for the tests
 *   only
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>} the command's, the agent's side
 */
export async function runProductCommand({
  container, repoDir, base, which, limitS, graceS, env, outputLimit, sudo, git,
}) {
  if (!COMMANDS.includes(which)) {
    throw new TypeError(`runProductCommand: which must be one of ${COMMANDS.join(', ')}`);
  }
  const adapter = await readAdapter({ repoDir, base, git });
  const [script, ...args] = adapter[which].command;
  const archive = await archiveOf({ repoDir, base, adapter, git });
  const unpacked = await execInTask({ container, sudo, limitS: UNPACK_LIMIT_S, input: archive, outputLimit: 4096,
    args: ['sh', '-c', UNPACK, 'factory-unpack'] });
  const dir = unpackedDir(unpacked);
  return execInTask({ container, sudo, limitS, graceS, env, outputLimit,
    args: ['sh', '-c', RUN, 'factory-run', WORKSPACE, dir, script, ...args] });
}
