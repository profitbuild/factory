/**
 * The push repository's config, held to an allowlist (incident-platform backlog #0-276 AC1; stage-4.md "Decided for
 * 4.3b"): exactly what a reference `git init --bare --template=`, made by the same git at the same moment, writes;
 * keys and values. The list is that git's own, never a constant (macOS's git adds core.ignorecase and
 * core.precomposeunicode); on git 2.39 and 2.43 it is core.repositoryformatversion=0, core.filemode=true and
 * core.bare=true. Every other key refuses the push: http.proxy, http.<url>.sslVerify, http.sslCAInfo,
 * http.curloptResolve, remote."<url>".pushurl, core.fsmonitor, include.path and any key no list names. A denylist is
 * never complete.
 *
 * The config is read as a file, `git config --file <gitDir>/config --list --null`, with no system or global config
 * (run-git.mjs): with --file, git follows no include.* (--includes is off for a file given), so include.path is a key
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
 * Makes a bare repository at `path`, in its parent `cwd` (a directory of the dispatcher's), with no template.
 *
 * @param {string} cwd
 * @param {string} path
 */
export async function initBare(cwd, path) {
  const { code, stderr } = await runGit({ cwd, args: ['init', '--quiet', '--bare', '--template=', path] });
  if (code !== 0) {
    throw new Error(`git init --bare failed: ${firstLines(stderr)}`);
  }
}

/**
 * The entries of a repository's config file, as git prints them: [key, value] pairs, value null for a key written
 * with no `=`.
 *
 * @param {string} gitDir
 * @returns {Promise<[string, string | null][]>}
 */
export async function readConfig(gitDir) {
  const { code, stdout, stderr } = await runGit({
    cwd: gitDir, args: ['config', '--file', join(gitDir, 'config'), '--list', '--null'],
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
 * Refuses the push repository `gitDir` unless its config is exactly the reference repository's.
 *
 * @param {string} gitDir
 * @param {string} referenceDir
 */
export async function checkPushConfig(gitDir, referenceDir) {
  const { unknown, changed } = configDifference(await readConfig(gitDir), await readConfig(referenceDir));
  if (unknown.length + changed.length > 0) {
    const parts = [
      ...(unknown.length ? [`keys a reference git init --bare does not write: ${unknown.join(', ')}`] : []),
      ...(changed.length ? [`keys whose value is not the reference's: ${changed.join(', ')}`] : []),
    ];
    throw new ConfigRefusedError(`the push repository's config is refused, before any token is asked for: ${parts.join('; ')}`);
  }
}
