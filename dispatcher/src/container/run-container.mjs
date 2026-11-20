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
 * - its output bounded; its time bounded by a timer of its own: past it, `onTimeout` runs (the caller's kill of the
 *   task's containers, through this starter), the child is signalled (sudo runs as root, so the signal may be refused:
 *   that is ignored), and the call is refused at once, its streams dropped, without waiting for them to close: an
 *   orphaned CLI can hold them open (ADR-0062 point 7).
 * test/child-process-static.test.mjs holds that no other module of src/ starts a process but run-git.mjs (git) and
 * lock.mjs (flock); docker and devcontainer are never started but here.
 */
import { spawn } from 'node:child_process';

import { ConfigError, refuseSecretShaped } from '../config/settings.mjs';
import { childEnv } from '../process/child-env.mjs';

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

/** docker's management commands, named with their subcommand: `docker volume rm`. */
const MANAGEMENT = new Set(['container', 'image', 'network', 'volume']);

/** How a refusal names a call: the program, its command and, for a management command, its subcommand. */
export const commandName = (program, args) => [program, args[0], ...(MANAGEMENT.has(args[0]) ? [args[1]] : [])]
  .join(' ');

/** A container command could not be run, wrote too much, or was refused before it ran. */
export class ContainerRunError extends Error {}
/** A container command ran past its time. */
export class ContainerTimeoutError extends ContainerRunError {}

/**
 * @param {{ program: 'docker' | 'devcontainer', args: string[], input?: Buffer | string, timeoutMs?: number,
 *   outputLimit?: number, onTimeout?: () => Promise<void>, baseEnv?: Record<string, string | undefined>,
 *   sudo?: string }} options `sudo` for the tests only (a fake that checks the rest of the command line)
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
export function runContainerCommand({
  program, args, input, timeoutMs = CONTAINER_TIMEOUT_MS, outputLimit = CONTAINER_MAX_OUTPUT, onTimeout,
  baseEnv = process.env, sudo = SUDO,
}) {
  if (!Object.hasOwn(PROGRAMS, program)) {
    throw new TypeError(`runContainerCommand: ${JSON.stringify(program)} is not docker nor devcontainer`);
  }
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
    throw new TypeError('runContainerCommand: args must be a non-empty array of strings');
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
  return new Promise((resolve, reject) => {
    const child = spawn(sudo, [...SUDO_OPTIONS, PROGRAMS[program], ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ allow: [], baseEnv }),
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    let settled = false;
    let timedOut = false;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
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
    const keep = (stream) => (chunk) => {
      sizes[stream] += chunk.length;
      if (sizes[stream] > outputLimit) {
        failure ??= new ContainerRunError(`${what} wrote more than ${outputLimit} bytes to its ${stream}: stopped`);
        try {
          child.kill('SIGKILL');
        } catch {
          // as above
        }
        drop();
        finish(failure);
        return;
      }
      chunks[stream].push(chunk);
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    child.on('error', (error) => finish(new ContainerRunError(`${sudo} could not be run: ${error.code ?? error.message}`)));
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      if (timedOut) {
        return;
      }
      if (signal) {
        finish(failure ?? new ContainerRunError(`${what} was ended by ${signal}`));
      } else {
        finish(failure, { code, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
      }
    });
    child.stdin.end(input);
  });
}

/**
 * A call that must succeed: its exit code 0, or a ContainerRunError naming the command (the program and its
 * subcommand, never an argument, which can carry data) and the exit code. What the call wrote to stderr is the agent's
 * side's (docker, devcontainer and the task container all run as factory), so it is never quoted, in a refusal nor in
 * a task's reason (review round 1 N1, SEC-31): from 4.6 on, the container holds a token its code could print there.
 * run-git.mjs keeps a remote's words out of a push's refusal the same way.
 */
export async function mustRun(options) {
  const result = await runContainerCommand(options);
  if (result.code !== 0) {
    throw new ContainerRunError(`${commandName(options.program, options.args)} failed (exit ${result.code}); its `
      + 'stderr, the agent\'s side\'s, is not quoted');
  }
  return result;
}
