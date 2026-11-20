// Not a test file. Child processes for the tests that kill a run (incident-platform backlog #0-275 AC2, AC3).
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Starts `node <script> <args>`, and resolves once its stdout has printed `line` (rejects if it exits first).
 *
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startUntil(script, args, line) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      out += chunk;
      if (out.split('\n').includes(line)) {
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}) before "${line}": ${err}`)));
  });
  return child;
}

/** SIGKILL, and wait for the exit. */
export async function kill(child) {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/** Runs `node <script> <args>` to its end. */
export async function run(script, args, { env } = {}) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}
