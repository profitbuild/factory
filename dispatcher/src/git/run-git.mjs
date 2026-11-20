/**
 * The one way the dispatcher runs git (incident-platform backlog #0-276; stage-4.md "Decided for 4.3b"): `init`, the
 * read of a bundle, `config --list`, the push, and 4.4's calls after it. test/child-process-static.test.mjs holds that
 * no other module of src/ starts git.
 *
 * The rule it serves: **no git with the dispatcher's rights runs in a repository an agent wrote.** A config,
 * .gitattributes or hook of such a repository can make git run a program (core.fsmonitor, a filter's driver,
 * diff.external, core.pager, a hook) as the uid that reads builder-app's key. So:
 * - git is /usr/bin/git (GIT), by its full path as flock(1) is: PATH does not choose the program that is handed the
 *   token. Only a test passes another;
 * - `cwd` is always a directory of the dispatcher's own: a repository it made, or the directory it makes one in;
 * - GIT_DIR names the repository for every command run in one, so git never discovers one from where it stands. The
 *   one command run in none is `git init --bare <path>` (config-allowlist.mjs, initBare), which makes the repository
 *   at the path it is given: there is no repository yet for GIT_DIR to name;
 * - every call carries `-c core.hooksPath=/dev/null -c core.fsmonitor= -c credential.helper=`, `-c
 *   protocol.allow=never` (a push allows its own protocol with GIT_ALLOW_PROTOCOL, which wins over it), and `-c
 *   core.commitGraph=false`: a commit-graph is read from the alternates too, and one there would answer
 *   `merge-base --is-ancestor` (bundle.mjs) from its own records instead of the commits themselves;
 * - no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null), no replace objects, no terminal
 *   prompt, LC_ALL=C (git's messages in English, for the callers that read them);
 * - the environment is childEnv's: PATH and HOME of the dispatcher's (a push adds the proxy variables), and what is
 *   set here and by the caller.
 * Its output and its time are bounded; a failure to start, a call cut short or one that writes too much is a
 * GitRunError; an exit code is the caller's to read.
 */
import { spawn } from 'node:child_process';

import { childEnv } from '../process/child-env.mjs';

/** git, by its full path. */
export const GIT = '/usr/bin/git';
/** What of the dispatcher's environment any git inherits. */
export const GIT_ENV_ALLOWED = Object.freeze(['PATH', 'HOME']);
/** The options every call carries, ahead of its own arguments. */
export const GIT_OVERRIDES = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=',
  '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'core.commitGraph=false']);
/** The longest a call may run, unless the caller says otherwise. */
export const GIT_TIMEOUT_MS = 2 * 60 * 1000;
/** The most of stdout, and of stderr, kept; a call that writes more is ended and fails. */
export const GIT_MAX_OUTPUT = 4 * 1024 * 1024;
/** The bound of a call that writes a bundle to its stdout (`large`): a product's whole history (#0-277). */
export const GIT_MAX_LARGE_OUTPUT = 256 * 1024 * 1024;

/** git could not be run, ran too long, or wrote too much. */
export class GitRunError extends Error {}

/**
 * @param {{ cwd: string, gitDir?: string, args: string[], input?: Buffer | string, allow?: readonly string[],
 *   set?: Record<string, string>, baseEnv?: Record<string, string | undefined>, timeoutMs?: number, large?: boolean,
 *   git?: string, maxOutput?: number }} options `allow` replaces GIT_ENV_ALLOWED (a push passes its own list); `set`
 *   adds to what is set here; `large` bounds the output by GIT_MAX_LARGE_OUTPUT, for a bundle written to stdout
 *   (base-bundle.mjs), a choice between two bounds and never a number; `git` and `maxOutput` for the tests only
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
export function runGit({
  cwd, gitDir, args, input, allow = GIT_ENV_ALLOWED, set = {}, baseEnv = process.env, timeoutMs = GIT_TIMEOUT_MS,
  large = false, git = GIT, maxOutput = large === true ? GIT_MAX_LARGE_OUTPUT : GIT_MAX_OUTPUT,
}) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new TypeError('runGit: cwd, a directory of the dispatcher\'s own, is required');
  }
  const what = `git ${args[0] ?? ''}`.trim();
  return new Promise((resolve, reject) => {
    const child = spawn(git, [...GIT_OVERRIDES, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
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
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    const keep = (stream) => (chunk) => {
      sizes[stream] += chunk.length;
      if (sizes[stream] > maxOutput) {
        failure ??= new GitRunError(`${what} wrote more than ${maxOutput} bytes to its ${stream}: stopped`);
        child.kill('SIGKILL');
        return;
      }
      chunks[stream].push(chunk);
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    child.on('error', (error) => { failure ??= new GitRunError(`${git} could not be run: ${error.code ?? error.message}`); });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      if (failure) {
        reject(failure);
      } else if (signal) {
        reject(new GitRunError(`${what} was ended by ${signal}, after at most ${timeoutMs} ms`));
      } else {
        resolve({ code, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
      }
    });
    child.stdin.end(input);
  });
}

/** The first lines of git's stderr, for a refusal: git's own words, never a remote's (callers of a push drop them). */
export const firstLines = (text, count = 3) => text.split('\n').filter(Boolean).slice(0, count).join(' / ');
