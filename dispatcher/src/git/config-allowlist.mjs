/**
 * The push repository's config, held to an allowlist (incident-platform backlog #0-276 AC1; stage-4.md "Decided for
 * 4.3b"): exactly what a reference `git init --bare --template=`, made by the same git at the same moment, writes;
 * keys and values. The list is that git's own, never a constant (macOS's git adds core.ignorecase and
 * core.precomposeunicode); on git 2.39 and 2.43 it is core.repositoryformatversion=0, core.filemode=true and
 * core.bare=true. Every other key refuses the push: http.proxy, http.<url>.sslVerify, http.sslCAInfo,
 * http.curloptResolve, remote."<url>".pushurl, core.fsmonitor, include.path and any key no list names. A denylist is
 * never complete.
 *
 * The config is read as a file, `git config --file <gitDir>/config --list --null`, run with GIT_DIR naming that
 * repository and with no system or global config (run-git.mjs): with --file, git follows no include.* (--includes is off for a file given), so include.path is a key
 * like the others, refused; --null splits entries on NUL and a key from its value on its first newline, so a value
 * holding newlines is read whole. Reading a config runs nothing of it. git prints a key normalized (its section and
 * its name in lower case, a subsection as written), so `[CORE] FSMonitor` is core.fsmonitor here. The comparison is
 * of multisets: an allowed key written twice refuses the push too.
 *
 * `--template=` gives both repositories no template: no sample hooks, no info/exclude, no description, whatever the
 * system's template directory holds (init.templateDir of a global config is not read either).
 */
import { join } from 'node:path';

import { firstLines, runGit } from './run-git.mjs';

/** The push repository's config is not the reference's. */
export class ConfigRefusedError extends Error {}

/**
 * Makes a bare repository at `path`, in its parent `cwd` (a directory of the dispatcher's), with no template. The one
 * git the dispatcher runs with no GIT_DIR: the repository it would name does not exist yet; `init` is given its path.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {{ git?: string }} [options] git's path, for the tests only
 */
export async function initBare(cwd, path, { git } = {}) {
  const { code, stderr } = await runGit({ cwd, git, args: ['init', '--quiet', '--bare', '--template=', path] });
  if (code !== 0) {
    throw new Error(`git init --bare failed: ${firstLines(stderr)}`);
  }
}

/**
 * The entries of a repository's config file, as git prints them: [key, value] pairs, value null for a key written
 * with no `=`.
 *
 * @param {string} gitDir
 * @param {{ git?: string }} [options]
 * @returns {Promise<[string, string | null][]>}
 */
export async function readConfig(gitDir, { git } = {}) {
  const { code, stdout, stderr } = await runGit({
    cwd: gitDir, gitDir, git, args: ['config', '--file', join(gitDir, 'config'), '--list', '--null'],
  });
  if (code !== 0) {
    throw new ConfigRefusedError(`the config of ${gitDir} cannot be read: ${firstLines(stderr)}`);
  }
  return stdout.toString('utf8').split('\0').slice(0, -1).map((entry) => {
    const newline = entry.indexOf('\n');
    return newline < 0 ? [entry, null] : [entry.slice(0, newline), entry.slice(newline + 1)];
  });
}

const counts = (entries) => {
  const map = new Map();
  for (const [key, value] of entries) {
    const id = JSON.stringify([key, value]);
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
};

/**
 * What of `actual` is not exactly `reference`, by key name only, never a value: `unknown`, keys the reference does
 * not have; `changed`, keys it has, with another value or count. Both empty when the two are the same multiset.
 *
 * @param {[string, string | null][]} actual
 * @param {[string, string | null][]} reference
 * @returns {{ unknown: string[], changed: string[] }}
 */
export function configDifference(actual, reference) {
  const known = new Set(reference.map(([key]) => key));
  const want = counts(reference);
  const have = counts(actual);
  const differing = new Set();
  for (const id of new Set([...want.keys(), ...have.keys()])) {
    if (want.get(id) !== have.get(id)) {
      differing.add(JSON.parse(id)[0]);
    }
  }
  const sorted = (keys) => [...keys].sort();
  return {
    unknown: sorted([...differing].filter((key) => !known.has(key))),
    changed: sorted([...differing].filter((key) => known.has(key))),
  };
}

/**
 * Refuses the repository `gitDir` unless its config is exactly the reference repository's, but for the entries of
 * `allowed`, each of which it may hold once, with exactly that value (FACTORY_REPO_DIR's remote.origin.url, which
 * `git clone --bare` writes and no command of the dispatcher's reads: incident-platform backlog #0-278).
 *
 * @param {string} gitDir
 * @param {string} referenceDir
 * @param {{ git?: string, allowed?: [string, string][], what?: string }} [options]
 */
export async function checkRepoConfig(gitDir, referenceDir, { git, allowed = [], what = 'the push repository' } = {}) {
  const actual = await readConfig(gitDir, { git });
  const rest = [...actual];
  for (const [key, value] of allowed) {
    const at = rest.findIndex(([k, v]) => k === key && v === value);
    if (at >= 0) {
      rest.splice(at, 1);
    }
  }
  const { unknown, changed } = configDifference(rest, await readConfig(referenceDir, { git }));
  if (unknown.length + changed.length > 0) {
    const parts = [
      ...(unknown.length ? [`keys a reference git init --bare does not write: ${unknown.join(', ')}`] : []),
      ...(changed.length ? [`keys whose value is not the reference's: ${changed.join(', ')}`] : []),
    ];
    throw new ConfigRefusedError(`${what}'s config is refused, before any token is asked for: ${parts.join('; ')}`);
  }
}

/**
 * Refuses the push repository `gitDir` unless its config is exactly the reference repository's.
 *
 * @param {string} gitDir
 * @param {string} referenceDir
 * @param {{ git?: string }} [options]
 */
export async function checkPushConfig(gitDir, referenceDir, { git } = {}) {
  await checkRepoConfig(gitDir, referenceDir, { git });
}
