/**
 * The product's files as the dispatcher reads them: blobs of the git tree of a base commit in its own FACTORY_REPO_DIR,
 * through runGit, never a checkout and never a task's branch (incident-platform ADR-0060 D6 as amended, backlog #0-278
 * AC3, AC5; #0-277's readTaskConfig reads the task configuration this way).
 *
 * resolveInBase walks a path one segment at a time in the base's tree: every segment before the last must be a
 * directory (a tree), and the last a file (a blob of mode 644 or 755) or a directory, as the caller asks. A symlink
 * on the way or at the path is refused, and so is a submodule (a gitlink): a symlink would point the read, or a
 * run, outside what the tree holds, and the entries are read from the tree, so no symlink of a checkout is ever
 * followed. An empty segment (`a//b`), a `.` or a `..` segment is refused before git is asked. subtreeFiles lists
 * every entry under a directory of the tree and refuses the whole directory when one is a symlink or a submodule.
 *
 * A refusal names `what` (the caller's: the adapter's field, `trustedPaths[1]`) and the segment's position, never a
 * path or a name read from the tree: the base is the product's, fetched from GitHub. Pathspecs are literal
 * (GIT_LITERAL_PATHSPECS): a `*` in a path is a character, never a pattern.
 */
import { firstLines, runGit } from '../git/run-git.mjs';

/** The base's tree cannot be read, or a path is not what it must be there. */
export class BaseTreeError extends Error {}

/** A tree's entries by git's modes, written as octal numbers (a mode as text is six digits). */
export const MODES = Object.freeze({ file: (0o100644).toString(8), executable: (0o100755).toString(8),
  tree: (0o40000).toString(8).padStart(6, '0'), symlink: (0o120000).toString(8), gitlink: (0o160000).toString(8) });
const FILE_MODES = Object.freeze([MODES.file, MODES.executable]);

const SHA = /^[0-9a-f]{40}$/;
const ENTRY = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]*)$/;
/**
 * The most bytes of blobs read in one call, under runGit's bound of its output: the product's trusted scripts and its
 * adapter, never a build.
 */
export const MAX_BLOB_BYTES = 3 * 1024 * 1024;

const refuse = (message) => { throw new BaseTreeError(message); };

function checkBase(base) {
  if (typeof base !== 'string' || !SHA.test(base)) {
    throw new TypeError('the base must be a commit\'s 40 hex digits');
  }
}

/** The segments of `path`, refused when one is empty, `.` or `..`. */
export function segmentsOf(path, what) {
  if (typeof path !== 'string' || path === '') {
    refuse(`${what} is not a path`);
  }
  const segments = path.split('/');
  const bad = segments.findIndex((s) => s === '' || s === '.' || s === '..');
  if (bad >= 0) {
    refuse(`${what} has an empty, . or .. segment (segment ${bad + 1})`);
  }
  return segments;
}

async function lsTree({ repoDir, base, paths, git, recursive = false }) {
  checkBase(base);
  // -t: the trees on the way to a path are listed too, so one call answers for every segment (without it, git lists
  // only the deepest entry a path names). -r: every file under a directory, and no tree.
  const result = await runGit({ cwd: repoDir, gitDir: repoDir, git, set: { GIT_LITERAL_PATHSPECS: '1' },
    args: ['ls-tree', '-z', '--full-tree', recursive ? '-r' : '-t', base, '--', ...paths] });
  if (result.code !== 0) {
    refuse(`git ls-tree of the base failed (exit ${result.code}): ${firstLines(result.stderr) || 'no message'}`);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map((line) => {
    const match = ENTRY.exec(line);
    if (!match) {
      refuse('git ls-tree of the base printed an entry it does not print');
    }
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
  });
}

/** The entry of `path` in the base's tree: `{ mode, type, oid }`, or null when the tree holds no such path. */
export async function treeEntry({ repoDir, base, path, git }) {
  const entry = (await lsTree({ repoDir, base, paths: [path], git })).find((e) => e.path === path);
  return entry ? { mode: entry.mode, type: entry.type, oid: entry.oid } : null;
}

/**
 * The text of the file at `path` in the base, refused unless it is a file there (a symlink is refused); null when
 * `optional` and the tree holds no such path.
 */
export async function blobOf({ repoDir, base, path, git, what, optional = false }) {
  const entry = await treeEntry({ repoDir, base, path, git });
  if (entry === null && optional) {
    return null;
  }
  if (entry === null || entry.type !== 'blob' || !FILE_MODES.includes(entry.mode)) {
    refuse(`${what} is not a file of the base (a symlink is refused)`);
  }
  return (await readBlobs({ repoDir, oids: [entry.oid], git, what }))[0].toString('utf8');
}

/**
 * `path` resolved in the base's tree, segment by segment: `{ mode, oid }` of its entry, a file's (`kind` 'file') or
 * a directory's ('tree'); refused when a segment is missing, a segment before the last is not a directory, or any is
 * a symlink or a submodule.
 *
 * @param {{ repoDir: string, base: string, path: string, kind: 'file' | 'tree', what: string, git?: string }} options
 */
export async function resolveInBase({ repoDir, base, path, kind, what, git }) {
  const segments = segmentsOf(path, what);
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  const entries = await lsTree({ repoDir, base, paths: prefixes, git });
  let found = null;
  for (const [i, prefix] of prefixes.entries()) {
    const entry = entries.find((e) => e.path === prefix);
    const position = `segment ${i + 1} of ${segments.length}`;
    if (!entry) {
      throw Object.assign(new BaseTreeError(`${what} is not in the base (${position} is missing)`), { missing: true });
    }
    if (entry.mode === MODES.symlink) {
      refuse(`${what} reaches a symlink in the base (${position}): a symlink is refused`);
    }
    if (entry.mode === MODES.gitlink) {
      refuse(`${what} reaches a submodule in the base (${position}): a submodule is refused`);
    }
    const last = i === prefixes.length - 1;
    if (!last && entry.mode !== MODES.tree) {
      refuse(`${what} goes through a file of the base (${position} is not a directory)`);
    }
    found = entry;
  }
  const isTree = found.mode === MODES.tree;
  if (kind === 'tree' ? !isTree : !(found.type === 'blob' && FILE_MODES.includes(found.mode))) {
    refuse(`${what} is not a ${kind === 'tree' ? 'directory' : 'file'} of the base`);
  }
  return { mode: found.mode, oid: found.oid };
}

/**
 * Every file under the directory `dir` of the base's tree (resolved first): `{ path, mode, oid }`, sorted; the whole
 * directory refused when an entry under it is a symlink or a submodule.
 */
export async function subtreeFiles({ repoDir, base, dir, what, git }) {
  await resolveInBase({ repoDir, base, path: dir, kind: 'tree', what, git });
  const entries = await lsTree({ repoDir, base, paths: [`${dir}/`], git, recursive: true });
  const files = entries.filter((e) => e.path.startsWith(`${dir}/`));
  const bad = files.find((e) => !(e.type === 'blob' && FILE_MODES.includes(e.mode)));
  if (bad) {
    refuse(`${what} holds a ${bad.mode === MODES.symlink ? 'symlink' : 'submodule'} in the base: the directory is `
      + 'refused');
  }
  return files.map(({ path, mode, oid }) => ({ path, mode, oid })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The bytes of the blobs `oids`, in order, from one `git cat-file --batch`; at most MAX_BLOB_BYTES in all.
 *
 * @returns {Promise<Buffer[]>}
 */
export async function readBlobs({ repoDir, oids, git, what }) {
  if (oids.length === 0) {
    return [];
  }
  if (!oids.every((oid) => SHA.test(oid))) {
    throw new TypeError('readBlobs: every oid must be 40 hex digits');
  }
  const result = await runGit({ cwd: repoDir, gitDir: repoDir, git,
    args: ['cat-file', '--batch'], input: `${oids.join('\n')}\n` }).catch((error) => {
    refuse(`${what} cannot be read from the base: ${error.message}`);
  });
  if (result.code !== 0) {
    refuse(`${what} cannot be read from the base (git cat-file, exit ${result.code})`);
  }
  const out = result.stdout;
  const blobs = [];
  let at = 0;
  for (const oid of oids) {
    const end = out.indexOf(0x0a, at);
    const header = end < 0 ? '' : out.subarray(at, end).toString('utf8');
    const match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== oid) {
      refuse(`${what} cannot be read from the base (not a blob)`);
    }
    const size = Number(match[2]);
    if (end + 1 + size > out.length) {
      refuse(`${what} cannot be read from the base (its blob is cut short)`);
    }
    blobs.push(out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  if (blobs.reduce((sum, b) => sum + b.length, 0) > MAX_BLOB_BYTES) {
    refuse(`${what} is larger than ${MAX_BLOB_BYTES} bytes in the base`);
  }
  return blobs;
}
