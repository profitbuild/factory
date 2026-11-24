/**
 * Claude's key, the Console key of the factory's workspace with its monthly spend limit (incident-platform backlog
 * #0-313, ADR-0060 D4): the owner's, in `dispatcher`'s ~/.config/factory/ (mode 600), never on `factory`.
 *
 *   CLAUDE_KEY=<absolute path of the key's file>   (optional, DEFAULT_CLAUDE_KEY)
 *
 * Only its path is a setting: settings.mjs refuses an `sk-ant-` value in the environment, as before. The file is read
 * once, at the start of a run, before its slot section, as builder-app's key is (config/own-file.mjs): a regular file
 * of this process's user, no link, no access for group or others, at most 512 bytes, one line of the key's form. A
 * missing or off file refuses the run before the daemon, naming the file, never its text. The key then lives only in
 * the run's memory and in the upstream's x-api-key header (proxy/upstream.mjs): never in an argument, an environment,
 * a log line, a response or a task's file (#0-313 AC2).
 */
import { isAbsolute } from 'node:path';

import { readOwnFile } from '../config/own-file.mjs';
import { readSettings } from '../config/settings.mjs';

/** The key's file when CLAUDE_KEY is not set (#0-313). */
export const DEFAULT_CLAUDE_KEY = '/home/dispatcher/.config/factory/claude.key';

/** The key's form: one line, an Anthropic key. */
const KEY = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** Claude's key is missing or off its form: the run is refused before the daemon. */
export class ClaudeKeyError extends Error {}

/**
 * The key's path, from the environment: CLAUDE_KEY, or DEFAULT_CLAUDE_KEY. Any other CLAUDE_ variable is refused as
 * unknown (settings.mjs's rule for a group).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ keyPath: string }}
 */
export function readClaudeEnv(env) {
  return readSettings(env, {
    prefix: 'CLAUDE_',
    settings: { CLAUDE_KEY: { field: 'keyPath', valid: isAbsolute, parse: String, expected: 'an absolute path' } },
    required: [],
    defaults: { keyPath: DEFAULT_CLAUDE_KEY },
  });
}

/**
 * The key, read from `path` once (#0-313).
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readClaudeKey(path) {
  let text;
  try {
    text = await readOwnFile(path, { what: 'Claude\'s key', forbiddenMode: 0o077, maxBytes: 512,
      refuse: (message) => new ClaudeKeyError(message) });
  } catch (error) {
    if (error instanceof ClaudeKeyError) {
      throw error;
    }
    throw new ClaudeKeyError(`Claude's key ${path} cannot be read (${error.code ?? error.name}): the owner puts the `
      + 'factory workspace\'s key there, mode 600 (incident-platform backlog #0-313)');
  }
  const key = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!KEY.test(key)) {
    throw new ClaudeKeyError(`Claude's key ${path} is not one line holding an Anthropic key (sk-ant-…)`);
  }
  return key;
}
