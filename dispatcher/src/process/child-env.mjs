/**
 * The one builder of every child process's environment (incident-platform backlog #0-276 AC4, AC7; stage-4.md "4.3",
 * "Decided for 4.3b"): a new object holding the variables of `baseEnv` (process.env by default) that the caller names
 * in `allow`, and then what it sets. Nothing else of the dispatcher's environment reaches a child, so a variable the
 * dispatcher holds (a setting, or a secret of a later step) is never inherited: an allowlist, not a denylist.
 *
 * Each caller names its own list: git, PATH and HOME (and a push the proxy variables); flock(1), nothing. A static
 * test (test/child-process-static.test.mjs) refuses any function of node:child_process in src/ whose `env` is not
 * built here.
 *
 * A value taken from `baseEnv` that is shaped like a secret is refused by its name (config/settings.mjs): a second
 * layer behind the CLI's refusal of such an environment at its start. What the caller sets is not checked, since a
 * push sets the token itself (FACTORY_PUSH_TOKEN).
 */
import { refuseSecretShaped } from '../config/settings.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {{ allow?: readonly string[], set?: Record<string, string>, baseEnv?: Record<string, string | undefined> }}
 *   [options]
 * @returns {Record<string, string>}
 */
export function childEnv({ allow = [], set = {}, baseEnv = process.env } = {}) {
  for (const name of [...allow, ...Object.keys(set)]) {
    if (!NAME.test(name)) {
      throw new TypeError(`childEnv: ${JSON.stringify(name)} is not a variable's name`);
    }
  }
  for (const [name, value] of Object.entries(set)) {
    if (typeof value !== 'string') {
      throw new TypeError(`childEnv: ${name} must be set to a string`);
    }
  }
  const inherited = Object.fromEntries(allow
    .filter((name) => typeof baseEnv[name] === 'string')
    .map((name) => [name, baseEnv[name]]));
  refuseSecretShaped(inherited);
  return { ...inherited, ...set };
}
