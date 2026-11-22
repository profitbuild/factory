// Not a test file. What a test's run needs of the credential proxy (incident-platform backlog #0-313), in a directory
// of the test's own: Claude's key (a marker, made at run time so no key-shaped literal is in the repository), the
// proxy's configuration as provision.sh writes it (ADDR a non-loopback IPv4 of this host, PORTS a few random ports
// below the ephemeral range, so tests side by side seldom meet), and the fresh-VM marker as create.sh writes it. Each
// file is the test's user's, 600 or 644; `proxyTesting` names them and that owner for the run (a test's only, kept
// from src/ by test-only-options-scan.mjs).
import { randomBytes, randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/** A non-loopback IPv4 of this host: where the test's proxy listens, as the VM's address would be. */
export function localAddress() {
  const found = Object.values(networkInterfaces()).flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'));
  if (!found) {
    throw new Error('the tests of the proxy need a non-loopback IPv4 address on this host');
  }
  return found.address;
}

/** A key of Anthropic's form that no one holds: what AC2's tests look for everywhere. */
export const keyMarker = () => `sk-ant-api03-${randomBytes(24).toString('hex')}-MARKER`;

/** A few ports between 20000 and 32767, none twice. */
export function testPorts(count = 6) {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(randomInt(20000, 32768));
  }
  return [...ports];
}

/**
 * @param {string} dir the test's own directory
 * @param {{ upstream?: object, ports?: number[], addr?: string }} [options] `upstream` a fake one's
 *   (fake-anthropic.mjs)
 */
export async function makeProxyFiles(dir, { upstream, ports = testPorts(), addr = localAddress() } = {}) {
  const key = keyMarker();
  const keyPath = join(dir, 'claude.key');
  const conf = join(dir, 'factory-proxy.conf');
  const freshVm = join(dir, 'factory-fresh-vm');
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  await writeFile(conf, `ADDR=${addr}\nPORTS=${ports.join(',')}\n`, { mode: 0o644 });
  await writeFile(freshVm, `${randomBytes(16).toString('hex')}\n`, { mode: 0o644 });
  return {
    key, keyPath, conf, freshVm, addr, ports,
    proxyTesting: { conf, freshVm, owner: process.getuid(), upstream },
  };
}
