/**
 * The one way the dispatcher runs git (incident-platform backlog #0-276; stage-4.md "Decided for 4.3b"): `init`, the
 * read of a bundle, `config --list`, the push, and 4.4's calls after it.
 *
 * The rule it serves: **no git with the dispatcher's rights runs in a repository an agent wrote.** A config,
 * .gitattributes or hook of such a repository can make git run a program (core.fsmonitor, a filter's driver,
 * diff.external, core.pager, a hook) as the uid that reads builder-app's key. So:
 * - `cwd` is always a directory of the dispatcher's own (a repository it made, or the parent it makes one in), and
 *   GIT_DIR names the repository explicitly: git never discovers one from where it stands;
 * - every call carries `-c core.hooksPath=/dev/null -c core.fsmonitor= -c credential.helper=` and
 *   `-c protocol.allow=never` (a push allows its own protocol with GIT_ALLOW_PROTOCOL, which wins over it);
 * - no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null), no replace objects, no terminal
 *   prompt, LC_ALL=C (git's messages in English, for the callers that read them);
 * - the environment is childEnv's: PATH and HOME of the dispatcher's (a push adds the proxy variables), and what is
 *   set here and by the caller.
 * Its output is bounded and its time too; a failure to start is thrown, an exit code is the caller's to read.
 */
import { spawn } from 'node:child_process';

import { childEnv } from '../process/child-env.mjs';

/** What of the dispatcher's environment any git inherits. */
export const GIT_ENV_ALLOWED = Object.freeze(['PATH', 'HOME']);
/** The options every call carries, ahead of its own arguments. */
export const GIT_OVERRIDES = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=',
  '-c', 'credential.helper=', '-c', 'protocol.allow=never']);
/** The longest a call may run, unless the caller says otherwise. */
export const GIT_TIMEOUT_MS = 2 * 60 * 1000;
/** The most of stdout and of stderr kept; a call that writes more is ended and fails. */
export const GIT_MAX_OUTPUT = 4 * 1024 * 1024;

/** git could not be run, ran too long, or wrote too much. */
export class GitRunError extends Error {}

/**
 * @param {{ cwd: string, gitDir?: string, args: string[], input?: Buffer | string, allow?: readonly string[],
 *   set?: Record<string, string>, baseEnv?: Record<string, string | undefined>, timeoutMs?: number }} options
 *   `allow` replaces GIT_ENV_ALLOWED (a push passes its own list); `set` adds to what is set here
 * @returns {Promise<{ code: number | null, stdout: Buffer, stderr: string }>}
 */
export function runGit({
  cwd, gitDir, args, input, allow = GIT_ENV_ALLOWED, set = {}, baseEnv = process.env, timeoutMs = GIT_TIMEOUT_MS,
}) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new TypeError('runGit: cwd, a directory of the dispatcher\'s own, is required');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_OVERRIDES, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: childEnv({
        allow,
        baseEnv,
        set: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
          ...(gitDir === undefined ? {} : { GIT_DIR: gitDir }),
          ...set,
        },
      }),
    });
    const out = [];
    const err = [];
    let sizes = [0, 0];
    let failure = null;
    const keep = (chunks, i) => (chunk) => {
      sizes[i] += chunk.length;
      if (sizes[i] > GIT_MAX_OUTPUT) {
        failure ??= new GitRunError(`git ${args[0]} wrote more than ${GIT_MAX_OUTPUT} bytes: stopped`);
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', keep(out, 0));
    child.stderr.on('data', keep(err, 1));
    child.on('error', (error) => { failure ??= new GitRunError(`git could not be run: ${error.message}`); });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      sizes = null;
      if (failure) {
        reject(failure);
      } else if (signal) {
        reject(new GitRunError(`git ${args[0]} ended by ${signal}${signal === 'SIGTERM' ? ` (over ${timeoutMs} ms)` : ''}`));
      } else {
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
      }
    });
    child.stdin.end(input);
  });
}

/** The first lines of git's stderr, for a refusal: git's own words, never a remote's (callers of a push drop them). */
export const firstLines = (text, count = 3) => text.split('\n').filter(Boolean).slice(0, count).join(' / ');
