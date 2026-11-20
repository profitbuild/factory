/**
 * The dispatcher's settings, from its environment only (incident-platform ADR-0055): one mechanism for every group of
 * them (BUILDER_APP_*, builder-env.mjs; FACTORY_*, factory-env.mjs; incident-platform backlog #0-271, #0-275).
 *
 * A group is a prefix and its known variables. A variable with the prefix that is not known is refused, since it is
 * most likely a known one misspelt; a known one that is missing or malformed is refused too. Every refusal names the
 * variable, never its value: should a secret be set there by mistake, it reaches no log.
 *
 * Nothing here touches the disk: the settings are read from an env object, which Node's own `--env-file` fills from
 * the dispatcher's env file (README, "Layout").
 */

/** A setting is missing, malformed, unknown, or holds a value shaped like a secret. */
export class ConfigError extends Error {}

/** A positive integer, written as one: no sign, no leading zero, no space, no exponent, safe in a double. */
export const positiveInteger = (value) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

/**
 * The settings of one group, from `env`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ prefix: string, settings: Record<string, { field: string, valid: (value: string) => boolean,
 *   parse: (value: string) => unknown, expected: string }>, required: string[], defaults?: Record<string, unknown>,
 *   missingHint?: string }} group `defaults` holds a field's value when its variable is not set (BUILDER_APP_KEY
 *   alone, from 4.2a; a FACTORY_* setting has none, ADR-0052 point 5); `missingHint` ends a "not set" refusal.
 * @returns {Record<string, unknown>}
 * @throws {ConfigError}
 */
export function readSettings(env, { prefix, settings, required, defaults = {}, missingHint = '' }) {
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith(prefix) && !Object.hasOwn(settings, name)) {
      throw new ConfigError(`unknown variable ${name} (known: ${Object.keys(settings).join(', ')})`);
    }
  }
  const config = { ...defaults };
  for (const [name, spec] of Object.entries(settings)) {
    const value = env[name];
    if (value === undefined) {
      if (required.includes(name)) {
        throw new ConfigError(`${name} is not set${missingHint}`);
      }
      continue;
    }
    if (!spec.valid(value)) {
      throw new ConfigError(`${name} must be ${spec.expected}`);
    }
    config[spec.field] = spec.parse(value);
  }
  return config;
}

/**
 * What a secret looks like (incident-platform backlog #0-275 AC7): a PEM block anywhere in the value; a GitHub token
 * (installation `ghs_`, personal `ghp_`, OAuth `gho_`, user-to-server `ghu_`, refresh `ghr_`: 36 characters after
 * the prefix; fine-grained `github_pat_`, longer); or an Anthropic key (`sk-ant-`, which reaches the dispatcher with
 * step 4.6). A token counts at the start of the value or after any character that cannot be part of it
 * ("Bearer ghs_…", "https://ghp_…@host", "a,ghs_…"), and only at its length, so that a word such as /srv/ghs_cache
 * is not one.
 *
 * The boundary has a cost: a token glued to a letter, a digit or `_` ("abcghs_…", "x_ghs_…") is not caught. This is
 * a second layer, against a secret written in the env file by mistake; the main control is that no secret is ever
 * given to the dispatcher through its environment (builder-app's key is a file, 4.6's key the proxy's).
 */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z0-9 ]+-----/,
  /(?:^|[^A-Za-z0-9_])(?:gh[psour]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})/,
  /(?:^|[^A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{32,}/,
];

/**
 * Refuses an environment in which any variable, of any name, holds a value shaped like a secret: the dispatcher's
 * env file never holds one (stage-4.md "4.3"), since Node loads it into process.env with the rest, where every child
 * would inherit it. The refusal names the variables, never a value nor which shape matched.
 *
 * @param {Record<string, string | undefined>} env
 * @throws {ConfigError}
 */
export function refuseSecretShaped(env) {
  const names = Object.keys(env).sort()
    .filter((name) => typeof env[name] === 'string' && SECRET_SHAPES.some((shape) => shape.test(env[name])));
  if (names.length > 0) {
    throw new ConfigError(`${names.join(', ')} ${names.length === 1 ? 'holds a value' : 'hold values'} shaped like `
      + 'a secret: the dispatcher\'s environment and its env file hold no secret, ever; remove '
      + `${names.length === 1 ? 'it' : 'them'}`);
  }
}
