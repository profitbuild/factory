/**
 * The one reader of git bundles (incident-platform backlog #0-276 AC6; stage-4.md "Decided for 4.3b"): the bundle of
 * a push, made by the dispatcher from its task repository, and, from 4.4 on, the bundle of each agent call, which the
 * container hands over on `docker exec`'s stdout (4.3c). A bundle is data: its bytes are read by Node, and only bytes
 * reach git, on stdin, in a repository of the dispatcher's own; no git ever runs where the bundle came from.
 *
 * loadBundle, in order, each step refusing before the next:
 * 1. the header, parsed here, strictly: `# v2 git bundle`, or `# v3 git bundle` with no capability but
 *    `@object-format=sha1`; exactly one prerequisite, the commit the caller names (the task's base for a push, the
 *    recorded head for a call); exactly one ref, the name and the commit the caller names; then the pack;
 * 2. the prerequisite is a commit of the repository (through its alternates: the base of the dispatcher's main);
 * 3. the pack's own objects, and only those, checked strictly: `git index-pack --strict --stdin --fix-thin`. A plain
 *    `fsck --strict` is `--full` by default and walks the alternates, all of main's history, and git's fsckObjects
 *    settings are not read when a bundle is fetched (git 2.39 and 2.43 both let a commit with no author email through
 *    `fetch <bundle>` with transfer.fsckObjects and fetch.fsckObjects; index-pack --strict refuses it). The repository's
 *    config, which index-pack's `fsck.<id>` severities come from, is held to a reference `git init --bare`'s by the
 *    push (config-allowlist.mjs), with no system or global config;
 * 4. index-pack's stdout is exactly its `pack\t<hash>` line: it copies bytes after the pack's end to stdout, so
 *    anything more is data the bundle should not hold;
 * 5. the ref's commit is a commit, and descends from the prerequisite (`merge-base --is-ancestor`): a header naming
 *    the base does not make the pack's history grow from it, since a pack can carry a history of its own, whole.
 * No ref is ever written: a push sends `<sha>:<ref>` from the SHA itself.
 */
import { firstLines, runGit } from './run-git.mjs';
import { readOwnFile } from '../config/own-file.mjs';

/** The largest bundle read. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
/** The largest header: a bundle of the dispatcher's has two lines and a signature. */
export const MAX_HEADER_BYTES = 64 * 1024;

/** A bundle is not what the caller expects, or its objects fail the strict check. */
export class BundleError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
const PREREQUISITE = /^-([0-9a-f]{40})(?: [\x20-\x7e]*)?$/;
const REF = /^([0-9a-f]{40}) (refs\/[\x21-\x7e]+)$/;

/**
 * The parts of a bundle's bytes; refuses a header out of the format.
 *
 * @param {Buffer} bytes
 * @returns {{ version: 2 | 3, prerequisites: string[], refs: { sha: string, name: string }[], pack: Buffer }}
 */
export function parseBundle(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError('parseBundle: a Buffer is required');
  }
  const end = bytes.subarray(0, MAX_HEADER_BYTES).indexOf('\n\n');
  if (end < 0) {
    throw new BundleError(`the bundle has no header that ends within ${MAX_HEADER_BYTES} bytes`);
  }
  const header = bytes.subarray(0, end + 1);
  if (!header.every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e))) {
    throw new BundleError('the bundle\'s header holds a byte that is not printable ASCII');
  }
  const [signature, ...lines] = header.toString('ascii').split('\n').slice(0, -1);
  let version;
  if (signature === '# v2 git bundle') {
    version = 2;
  } else if (signature === '# v3 git bundle') {
    version = 3;
  } else {
    throw new BundleError('the bundle\'s signature is neither "# v2 git bundle" nor "# v3 git bundle"');
  }
  const prerequisites = [];
  const refs = [];
  for (const [i, line] of lines.entries()) {
    let match;
    if (line.startsWith('@')) {
      // v3's capabilities come first; sha1 is the only object format the dispatcher reads, and a filter (a partial
      // bundle) or any other capability is refused.
      if (version !== 3 || line !== '@object-format=sha1' || prerequisites.length + refs.length > 0) {
        throw new BundleError('the bundle holds a capability other than v3\'s @object-format=sha1, or out of place');
      }
    } else if ((match = PREREQUISITE.exec(line))) {
      prerequisites.push(match[1]);
    } else if ((match = REF.exec(line))) {
      refs.push({ sha: match[1], name: match[2] });
    } else {
      throw new BundleError(`the bundle's header line ${i + 2} is neither a prerequisite nor a ref`);
    }
  }
  const pack = bytes.subarray(end + 2);
  if (pack.length < 32 || pack.subarray(0, 4).toString('latin1') !== 'PACK') {
    throw new BundleError('the bundle holds no pack after its header');
  }
  return { version, prerequisites, refs, pack };
}

/**
 * A bundle file's bytes, read as every file of the dispatcher's is (config/own-file.mjs): a regular file, not a
 * symlink, of this user, readable by no one else, opened once and checked on its handle, at most MAX_BUNDLE_BYTES.
 *
 * @param {string} path
 * @param {{ uid?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export function readBundleFile(path, { uid } = {}) {
  return readOwnFile(path, {
    what: 'the bundle', forbiddenMode: 0o077, uid, encoding: null, maxBytes: MAX_BUNDLE_BYTES,
    refuse: (message) => new BundleError(message),
  });
}

async function objectType(gitDir, sha) {
  const { code, stdout } = await runGit({ cwd: gitDir, gitDir, args: ['cat-file', '-t', sha] });
  return code === 0 ? stdout.toString('ascii').trim() : null;
}

/**
 * Reads `bundle` into the repository `gitDir`, refused unless its prerequisite is exactly `prerequisite`, its one ref
 * exactly `ref`, its objects pass the strict check and the ref descends from the prerequisite.
 *
 * @param {{ gitDir: string, bundle: Buffer, prerequisite: string, ref: { sha: string, name: string } }} options
 * @returns {Promise<{ sha: string, name: string }>} the ref, as read
 */
export async function loadBundle({ gitDir, bundle, prerequisite, ref }) {
  if (!SHA.test(prerequisite ?? '') || !SHA.test(ref?.sha ?? '') || typeof ref?.name !== 'string') {
    throw new TypeError('loadBundle: a prerequisite, and a ref with a sha and a name, are required');
  }
  const parsed = parseBundle(bundle);
  if (parsed.prerequisites.length !== 1 || parsed.prerequisites[0] !== prerequisite) {
    throw new BundleError(`the bundle's prerequisites must be exactly ${prerequisite}; it has `
      + `${parsed.prerequisites.length === 0 ? 'none' : parsed.prerequisites.join(', ')}`);
  }
  if (parsed.refs.length !== 1) {
    throw new BundleError(`the bundle must hold exactly one ref, ${ref.name}; it holds ${parsed.refs.length}`);
  }
  const [only] = parsed.refs;
  if (only.name !== ref.name || only.sha !== ref.sha) {
    throw new BundleError(`the bundle's ref must be ${ref.name} at ${ref.sha}; it is ${only.name} at ${only.sha}`);
  }
  if (only.sha === prerequisite) {
    throw new BundleError('the bundle\'s ref is its prerequisite: it brings no commit');
  }
  if (await objectType(gitDir, prerequisite) !== 'commit') {
    throw new BundleError(`the bundle's prerequisite ${prerequisite} is not a commit of the repository`);
  }
  const indexed = await runGit({
    cwd: gitDir, gitDir, args: ['index-pack', '--strict', '--stdin', '--fix-thin'], input: parsed.pack,
    timeoutMs: 10 * 60 * 1000,
  });
  if (indexed.code !== 0) {
    throw new BundleError(`the bundle's objects fail git's strict check: ${firstLines(indexed.stderr)}`);
  }
  if (!/^pack\t[0-9a-f]{40}\n$/.test(indexed.stdout.toString('latin1'))) {
    throw new BundleError('the bundle holds data after its pack');
  }
  if (await objectType(gitDir, only.sha) !== 'commit') {
    throw new BundleError(`the bundle's ref ${only.sha} is not a commit`);
  }
  const ancestry = await runGit({ cwd: gitDir, gitDir, args: ['merge-base', '--is-ancestor', prerequisite, only.sha] });
  if (ancestry.code === 1) {
    throw new BundleError(`the bundle's ref ${only.sha} does not descend from its prerequisite ${prerequisite}`);
  }
  if (ancestry.code !== 0) {
    throw new BundleError(`the bundle's ancestry could not be read: ${firstLines(ancestry.stderr)}`);
  }
  return { sha: only.sha, name: only.name };
}
