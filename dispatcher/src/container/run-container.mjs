/**
 * The one starter of every container command of the dispatcher's (incident-platform ADR-0062 point 1; backlog #0-277
 * AC9): no `docker`, `devcontainer` or command in a container runs as `dispatcher`, the uid that reads builder-app's
 * key. Each runs as `factory`, the agent's side (ADR-0057), through the one sudoers rule the build VM's provisioning
 * writes (`/etc/sudoers.d/factory-dispatcher`: these two programs by their full paths, as `factory`, no prompt;
 * `Defaults:dispatcher env_reset, !setenv, secure_path="/usr/local/bin:/usr/bin:/bin", runcwd="/",
 * env_file=/etc/factory-dispatcher.env`):
 *
 *   /usr/bin/sudo -n -H -u factory -- /usr/bin/docker|/usr/local/bin/devcontainer <args>
 *
 * - sudo by its full path, `-n` (no prompt: a missing rule fails, never waits), `-H` (HOME is factory's, so the
 *   CLIs read and write factory's own ~/.docker and caches), `--` before the program;
 * - the program by its full path (PATH does not choose it), one of the two the rule names;
 * - the environment childEnv's, holding nothing of the dispatcher's, and sudo resets it anyway. What the programs get
 *   is the rule's: DOCKER_HOST (unix:///run/docker.sock, factory's daemon, ADR-0057) from the rule's env_file, PATH
 *   from its secure_path (so the devcontainer CLI's `#!/usr/bin/env node` finds /usr/local/bin/node), and its
 *   runcwd, /. The starter passes no variable, no directory and no -D: the rule decides all three;
 * - no argument shaped like a secret: sudo logs a command's arguments (4.6's token goes on stdin or the like). The
 *   refusal names the argument's position, never its value;
 * - its stdout bounded; its time bounded by a timer of its own: past it, `onTimeout` runs (the caller's kill of the
 *   task's containers, through this starter), the child is signalled (sudo runs as root, so the signal may be refused:
 *   that is ignored), and the call is refused at once, its streams dropped, without waiting for them to close: an
 *   orphaned CLI can hold them open (ADR-0062 point 7);
 * - its stderr never returned (incident-platform backlog #0-284, ADR-0062 point 6): docker, devcontainer and the task
 *   container all run as `factory`, the agent's side, so what they write there is the agent's, and from 4.6 on the
 *   container holds a token its code could print. The starter keeps it, up to STDERR_KEPT bytes, in a file of its own,
 *   `$FACTORY_STATE_DIR/stderr/<time>-<command>-<random>.log` (the directory 700, the file 600, made with O_EXCL and
 *   O_NOFOLLOW), for the owner to read on the VM, and gives the caller only that file's path (`stderrFile`, null
 *   when the call wrote nothing there). A refusal names the command, the exit code and the path; no module of src/
 *   but this one holds the text (test/starter-stderr-static.test.mjs).
 * test/child-process-static.test.mjs holds that no other module of src/ starts a process but run-git.mjs (git) and
 * lock.mjs (flock); docker and devcontainer are never started but here.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { ConfigError, refuseSecretShaped } from '../config/settings.mjs';
import { childEnv } from '../process/child-env.mjs';
import { ensureOwnDirectory } from '../state/files.mjs';

/** sudo, docker and the devcontainer CLI, by their full paths (the VM's provisioning installs them there). */
export const SUDO = '/usr/bin/sudo';
export const PROGRAMS = Object.freeze({ docker: '/usr/bin/docker', devcontainer: '/usr/local/bin/devcontainer' });
/** The user every container command runs as. */
export const AS_USER = 'factory';
/** sudo's options, ahead of the program. */
export const SUDO_OPTIONS = Object.freeze(['-n', '-H', '-u', AS_USER, '--']);
/** The longest a call may run, and the most of stdout and of stderr kept, unless the caller says otherwise. */
export const CONTAINER_TIMEOUT_MS = 5 * 60 * 1000;
export const CONTAINER_MAX_OUTPUT = 4 * 1024 * 1024;
/** The most of a call's stderr its file keeps (#0-284): the rest is counted, not kept, and the call is not stopped. */
export const STDERR_KEPT = 1024 * 1024;
/** The directory of the stderr files, under $FACTORY_STATE_DIR. */
export const STDERR_DIR = 'stderr';

/** docker's management commands, named with their subcommand: `docker volume rm`. */
const MANAGEMENT = new Set(['container', 'image', 'network', 'volume']);

/** How a refusal names a call: the program, its command and, for a management command, its subcommand. */
export const commandName = (program, args) => [program, args[0], ...(MANAGEMENT.has(args[0]) ? [args[1]] : [])]
  .join(' ');

/**
 * How a refusal points at a call's stderr: the file's path, never its text (#0-284). For a template literal: the path
 * is the starter's result's `stderrFile`.
 *
 * @param {string | null} file
 */
export const stderrNote = (file) => (file === null ? 'it wrote nothing to stderr'
  : `its stderr, the agent's side's, is not quoted: it is kept in ${file}`);

/** The file name's part that says which call it was: the command's words, letters and digits only. */
const fileWord = (what) => what.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

/**
 * Writes `kept` (the first STDERR_KEPT bytes) and a line for the `dropped` rest to a new file of the stderr
 * directory, 600, never over another file nor through a link.
 *
 * @returns {Promise<string | null>} its path, or null when there was nothing
 */
async function keepStderr({ stateDir, what, kept, dropped }) {
  if (kept.length === 0 && dropped === 0) {
    return null;
  }
  const dir = join(stateDir, STDERR_DIR);
  await ensureOwnDirectory(dir);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = join(dir, `${stamp}-${fileWord(what)}-${randomBytes(4).toString('hex')}.log`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600);
  try {
    await handle.writeFile(kept);
    if (dropped > 0) {
      await handle.writeFile(`\n[the call wrote ${dropped} more bytes to stderr, not kept: the file keeps `
        + `${STDERR_KEPT}]\n`);
    }
  } finally {
    await handle.close();
  }
  return path;
}

/** A container command could not be run, wrote too much, or was refused before it ran. */
export class ContainerRunError extends Error {}
/** A container command ran past its time. */
export class ContainerTimeoutError extends ContainerRunError {}
/** A call ended, but its stderr could not be kept: none of its result is taken (fail closed, factory#22 GEN-31). */
export class StderrKeepError extends ContainerRunError {}

/**
 * @param {{ program: 'docker' | 'devcontainer', args: string[], stateDir: string, input?: Buffer | string,
 *   timeoutMs?: number, outputLimit?: number, onTimeout?: () => Promise<void>,
 *   baseEnv?: Record<string, string | undefined>, sudo?: string, stdoutFile?: string }} options `stateDir`
 *   $FACTORY_STATE_DIR, where the call's stderr is kept; `outputLimit` stdout's; `stdoutFile` a new file (600,
 *   O_EXCL, O_NOFOLLOW) stdout is written to as it comes, held to `outputLimit` but never in memory, so that a long
 *   agent call's stream fits (incident-platform backlog #0-301): `stdout` is then empty; `sudo` for the tests only
 *   (a fake that checks the rest of the command line)
 * @returns {Promise<{ code: number, stdout: Buffer, stderrFile: string | null }>} never the stderr's text (#0-284)
 */
export function runContainerCommand({
  program, args, stateDir, input, timeoutMs = CONTAINER_TIMEOUT_MS, outputLimit = CONTAINER_MAX_OUTPUT, onTimeout,
  baseEnv = process.env, sudo = SUDO, stdoutFile,
}) {
  if (!Object.hasOwn(PROGRAMS, program)) {
    throw new TypeError(`runContainerCommand: ${JSON.stringify(program)} is not docker nor devcontainer`);
  }
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
    throw new TypeError('runContainerCommand: args must be a non-empty array of strings');
  }
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) {
    throw new TypeError('runContainerCommand: stateDir must be $FACTORY_STATE_DIR, an absolute path');
  }
  try {
    refuseSecretShaped(Object.fromEntries(args.map((a, i) => [`argument ${i + 1}`, a])));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ContainerRunError(`${commandName(program, args)}: ${error.message.replace(/: the dispatcher.*$/,
        ': sudo logs the arguments, and a secret is never one')}`);
    }
    throw error;
  }
  const what = commandName(program, args);
  if (stdoutFile !== undefined && (typeof stdoutFile !== 'string' || !isAbsolute(stdoutFile))) {
    throw new TypeError('runContainerCommand: stdoutFile must be an absolute path');
  }
  const stdoutFd = stdoutFile === undefined ? null
    : openSync(stdoutFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const closeStdout = () => {
    if (stdoutFd !== null) {
      try {
        closeSync(stdoutFd);
      } catch {
        // closed already
      }
    }
  };
  return new Promise((resolveCall, rejectCall) => {
    const resolve = (value) => { closeStdout(); resolveCall(value); };
    const reject = (error) => { closeStdout(); rejectCall(error); };
    const child = spawn(sudo, [...SUDO_OPTIONS, PROGRAMS[program], ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ allow: [], baseEnv }),
    });
    const stdout = [];
    let stdoutSize = 0;
    const stderr = [];
    let stderrSize = 0;
    let failure = null;
    let settled = false;
    let timedOut = false;
    // Every end of the call keeps its stderr first, then settles: the refusal or the result names the file.
    //
    // A stderr that cannot be kept (a full disk, a stderr/ that is not the dispatcher's 700 directory) fails closed
    // (review round 1 of factory#22, GEN-31, the owner's rule (b)): the VM's state is not certain, so no result of the
    // call is taken, even an exit of 0, which comes back as a ContainerRunError and so ends a task BLOCKED. A call
    // that had failed already keeps its own class (a ContainerTimeoutError stays one, which execInTask turns into a
    // CallTimeoutError), with the original error as `cause`. Either refusal names the original's class and why the
    // file could not be written (an errno or the state's own refusal), never the stderr's text.
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const kept = Buffer.concat(stderr);
      keepStderr({ stateDir, what, kept, dropped: stderrSize - kept.length }).then((stderrFile) => {
        if (error) {
          if (stderrFile !== null) {
            error.message = `${error.message}; ${stderrNote(stderrFile)}`;
          }
          reject(error);
        } else {
          resolve({ ...result, stderrFile });
        }
      }, (keeping) => {
        const why = `its stderr could not be kept in ${STDERR_DIR}/ of the state (${keeping.code
          ?? keeping.constructor.name})`;
        if (error) {
          const Kind = error.constructor;
          reject(new Kind(`${error.message}; and ${why} (the call ended in ${Kind.name})`, { cause: error }));
        } else {
          reject(new StderrKeepError(`${what} ended (exit ${result.code}), but ${why}: the call is refused `
            + 'whatever it did, the state of the VM not certain', { cause: keeping }));
        }
      });
    };
    const drop = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.unref();
    };
    const timer = setTimeout(async () => {
      if (settled) {
        return;
      }
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // sudo is root's: the signal may be refused; onTimeout is what ends the work.
      }
      drop();
      let killed = '';
      try {
        await onTimeout?.();
      } catch (error) {
        killed = `; and the kill after it failed: ${error.message}`;
      }
      finish(new ContainerTimeoutError(`${what} ran past ${timeoutMs} ms: stopped, its output no longer read${killed}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > outputLimit) {
        failure ??= new ContainerRunError(`${what} wrote more than ${outputLimit} bytes to its stdout: stopped`);
        try {
          child.kill('SIGKILL');
        } catch {
          // as above
        }
        drop();
        finish(failure);
        return;
      }
      if (stdoutFd === null) {
        stdout.push(chunk);
      } else {
        writeSync(stdoutFd, chunk);
      }
    });
    // Up to STDERR_KEPT bytes kept, the rest counted: a call is never stopped for what it writes there.
    child.stderr.on('data', (chunk) => {
      const room = STDERR_KEPT - stderrSize;
      if (room > 0) {
        stderr.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      }
      stderrSize += chunk.length;
    });
    child.on('error', (error) => finish(new ContainerRunError(`${sudo} could not be run: ${error.code ?? error.message}`)));
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      if (timedOut) {
        return;
      }
      if (signal) {
        finish(failure ?? new ContainerRunError(`${what} was ended by ${signal}`));
      } else {
        finish(failure, { code, stdout: Buffer.concat(stdout) });
      }
    });
    child.stdin.end(input);
  });
}

/**
 * A call that must succeed: its exit code 0, or a ContainerRunError naming the command (the program and its
 * subcommand, never an argument, which can carry data), the exit code and the file its stderr is kept in. What the
 * call wrote to stderr is the agent's side's (docker, devcontainer and the task container all run as factory), so it
 * is never quoted, in a refusal nor in a task's reason (review round 1 N1, SEC-31; #0-284: the starter never returns
 * it). run-git.mjs keeps a remote's words out of a push's refusal the same way.
 */
export async function mustRun(options) {
  const result = await runContainerCommand(options);
  if (result.code !== 0) {
    throw new ContainerRunError(`${commandName(options.program, options.args)} failed (exit ${result.code}); `
      + `${stderrNote(result.stderrFile)}`);
  }
  return result;
}
