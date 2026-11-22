/**
 * A run's credential, from the fresh VM to the sweep (incident-platform backlog #0-313, M2.7), around the task's
 * container and its phases:
 *
 *   1. (cli.mjs, before the slot section) the key read (key.mjs) and /etc/factory-proxy.conf (conf.mjs): either off
 *      its form refuses the run before the daemon;
 *   2. the fresh-VM marker consumed for this run (fresh-vm.mjs), right before `devcontainer up` runs the product's
 *      code;
 *   3. the task's container set up and checked (environment.mjs's setUpTaskContainer), its token's directory mounted
 *      read-only on /run/factory;
 *   4. the proxy started on ADDR and the first free port (server.mjs), its token made;
 *   5. the token written into the directory by a helper (work-dir.mjs's writeTokenFile: stdin, 444, noclobber);
 *   6. the token activated, and the phases run with the proxy's address (flow/call.mjs's ANTHROPIC_BASE_URL);
 *   7. in a finally, whatever the phases did: the token revoked and the proxy closed, its record written;
 *   8. (cli.mjs) the sweep at the end removes the work directory, the token's file with it.
 * A stop in 2, 4 or 5 ends the task BLOCKED through stopItem (the breaker counts it), stage `fresh-vm` or `proxy`,
 * with the dispatcher's own reason; no token is issued, and none is valid.
 */
import { stopItem } from '../state/tasks.mjs';
import { WorkDirError, writeTokenFile } from '../container/work-dir.mjs';
import { FreshVmError, consumeFreshVm } from './fresh-vm.mjs';
import { ProxyError, startProxy } from './server.mjs';

/**
 * @param {{ stateDir: string, task: object, conf: { addr: string, ports: number[] }, key: string,
 *   helperImage: string, err: { write: (line: string) => void }, sudo?: string, proxyTesting?: object }} options
 * @param {{ setUp: () => Promise<{ task: object, container: object | null }>,
 *   run: (ready: object, baseUrl: string) => Promise<object> }} steps `setUp` the task's container (step 3), `run`
 *   its phases (step 6)
 * @returns {Promise<object>} the task as it was left
 */
export async function runTaskWithProxy({ stateDir, task, conf, key, helperImage, err, sudo, proxyTesting }, { setUp,
  run }) {
  const { runId } = task;
  try {
    await consumeFreshVm({ stateDir, runId, proxyTesting });
  } catch (error) {
    if (error instanceof FreshVmError) {
      return stopItem(stateDir, task, { stage: 'fresh-vm', reason: error.message });
    }
    throw error;
  }
  const ready = await setUp();
  if (ready.container === null) {
    return ready.task;
  }
  let proxy;
  try {
    proxy = await startProxy({ addr: conf.addr, ports: conf.ports, key, runId, stateDir, err, proxyTesting });
  } catch (error) {
    if (error instanceof ProxyError) {
      return stopItem(stateDir, ready.task, { stage: 'proxy', reason: error.message });
    }
    throw error;
  }
  try {
    try {
      await writeTokenFile({ runId, token: proxy.token, image: helperImage, sudo, stateDir });
    } catch (error) {
      if (error instanceof WorkDirError) {
        return await stopItem(stateDir, ready.task, { stage: 'proxy', reason: error.message });
      }
      throw error;
    }
    proxy.activate();
    return await run(ready, proxy.baseUrl);
  } finally {
    // The token valid no longer, and no one listening, whatever the phases did (#0-313 AC1).
    proxy.revoke();
    await proxy.close();
  }
}
