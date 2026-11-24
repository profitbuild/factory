/**
 * Until #0-285 (M3.4), a run that holds a token runs only on a VM made anew that has run nothing before it
 * (incident-platform backlog #0-313 AC6, ADR-0062 point 5 as amended): a task holds `factory`'s daemon socket, so what
 * an earlier task left on the VM could read the next one's token. The rule is checked, not only followed.
 *
 * The contract with incident-platform's create.sh (the owner's session writes it): once provision.sh has finished on a
 * VM made anew, create.sh writes, as root,
 *
 *   /etc/factory-fresh-vm   root:root, 0644, one line of 32 lowercase hex (random, the VM's own)
 *
 * and nothing else writes it (provision.sh never does: a VM provisioned again is no VM made anew).
 *
 * The dispatcher cannot remove a file of root's, and is given no directory of root's to write in (that would be the
 * same trust as its own state, with more rights on the VM: review of #0-313's plan, I). So a run consumes the marker
 * in its own state, $FACTORY_STATE_DIR/fresh-vm.json ({ marker, runId }, 600), under the state's lock, compare and
 * set: the first run writes it, every later one finds it there and is stopped. It is consumed right before the task's
 * container is set up, since `devcontainer up` already runs the product's code (its lifecycle commands), so a run that
 * stops after `up` and before its token still leaves the VM used. A marker missing or off its form (not root's,
 * writable by group or others, not one line of 32 hex), or one consumed already, stops the task with a fixed reason;
 * no token is issued. A resumed task on the same VM is stopped too (M2's rule).
 *
 * The limit, named in the README: removing the dispatcher's state on a live VM arms the marker again. Only someone
 * with access to the VM can, and a VM made anew has a new state anyway.
 */
import { join } from 'node:path';

import { readOwnFile } from '../config/own-file.mjs';
import { readJson, writeJsonAtomic } from '../state/files.mjs';
import { withStateLock } from '../state/lock.mjs';

/** The marker create.sh writes (#0-313 AC6). */
export const FRESH_VM_MARKER = '/etc/factory-fresh-vm';
/** Where a run records that it consumed the marker, in the dispatcher's state. */
export const consumedPath = (stateDir) => join(stateDir, 'fresh-vm.json');

/** The VM is not one made anew for this run: the task stops, and no token is issued. */
export class FreshVmError extends Error {}

const MARKER = /^[0-9a-f]{32}$/;

/**
 * The marker's value, or a FreshVmError.
 *
 * @param {{ proxyTesting?: { freshVm?: string, owner?: number } }} [options] for the tests only: its path and owner
 * @returns {Promise<string>}
 */
export async function readFreshVmMarker({ proxyTesting = {} } = {}) {
  const path = proxyTesting.freshVm ?? FRESH_VM_MARKER;
  let text;
  try {
    text = await readOwnFile(path, { what: 'the fresh-VM marker', forbiddenMode: 0o022, uid: proxyTesting.owner ?? 0,
      maxBytes: 64, refuse: (message) => new FreshVmError(message) });
  } catch (error) {
    if (error instanceof FreshVmError) {
      throw error;
    }
    throw new FreshVmError(`the fresh-VM marker ${path} cannot be read (${error.code ?? error.name}): a run that holds `
      + 'a token runs only on a VM made anew by create.sh');
  }
  const marker = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!MARKER.test(marker)) {
    throw new FreshVmError(`the fresh-VM marker ${path} is not one line of 32 hex`);
  }
  return marker;
}

/**
 * Consumes the marker for `runId` (#0-313 AC6), or a FreshVmError: compare and set, under the state's lock.
 *
 * @param {{ stateDir: string, runId: string, proxyTesting?: object }} options
 */
export async function consumeFreshVm({ stateDir, runId, proxyTesting }) {
  const marker = await readFreshVmMarker({ proxyTesting });
  await withStateLock(stateDir, async () => {
    let consumed;
    try {
      consumed = await readJson(consumedPath(stateDir));
    } catch (error) {
      // A record off its form (not the dispatcher's own, not JSON) is a VM whose history is not known: stopped.
      throw new FreshVmError(`the record of the fresh-VM marker cannot be read: ${error.message}`);
    }
    if (consumed !== undefined) {
      const by = typeof consumed?.runId === 'string' && /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/.test(consumed.runId)
        ? ` (by the run ${consumed.runId})` : '';
      throw new FreshVmError(`this VM has run a task before${by}: a run that holds a token runs only on a VM made `
        + 'anew by create.sh, until #0-285');
    }
    await writeJsonAtomic(consumedPath(stateDir), { marker, runId });
  });
}
