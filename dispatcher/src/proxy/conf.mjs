/**
 * Where the dispatcher's credential proxy listens (incident-platform backlog #0-313, M2.7; ADR-0060 D4, ADR-0064
 * point 5 as amended): one source, the VM's provisioning, never a second reading of the VM's network here (review of
 * #0-313's plan, A: two parsers of one fact could drift apart, ARC-02).
 *
 * incident-platform's provision.sh writes /etc/factory-proxy.conf at every boot, root:root, 0644, two lines:
 *
 *   ADDR=<the VM's address: the same $vm_ip it gives the daemon as host-gateway-ip>
 *   PORTS=8770[,<one more port per slot, in M5>]
 *
 * and, for those ports, an INPUT rule that drops them from any device but lo (the VM's filter keeps the proxy
 * unreachable from outside the VM, #0-313 AC5) and a FACTORY-EGRESS rule that lets factory's containers reach them.
 * The dispatcher reads it once at the start of a run, before its slot section, and refuses the run before the daemon
 * when it is off its form: a regular file, no link, owned by uid 0, writable by no one else; ADDR an IPv4 literal of a
 * local interface (os.networkInterfaces()), neither 0.0.0.0 nor of 127.0.0.0/8; PORTS 1024 to 65535, outside Linux's
 * ephemeral range (32768 to 60999, where Docker publishes a container's ports), none twice. A refusal names the file
 * and the field, never a value.
 */
import { networkInterfaces } from 'node:os';

import { readOwnFile } from '../config/own-file.mjs';

/** The file provision.sh writes (#0-313). */
export const PROXY_CONF = '/etc/factory-proxy.conf';
/** Linux's default ephemeral range (ip_local_port_range): no proxy port in it. */
export const EPHEMERAL = Object.freeze({ low: 32768, high: 60999 });

/** The proxy's configuration is missing or off its form: the run is refused before the daemon. */
export class ProxyConfError extends Error {}

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const PORT = /^[1-9][0-9]{3,4}$/;

/** The IPv4 addresses of this host's interfaces. */
const localAddresses = () => Object.values(networkInterfaces()).flat()
  .filter((entry) => entry?.family === 'IPv4').map((entry) => entry.address);

/**
 * The proxy's address and ports, from `text` (the file's), or a ProxyConfError naming `path` and the field.
 *
 * @param {string} text
 * @param {{ path: string, local?: () => string[] }} options `local` the host's IPv4 addresses (the tests')
 * @returns {{ addr: string, ports: number[] }}
 */
export function parseProxyConf(text, { path, local = localAddresses }) {
  const refuse = (field, why) => new ProxyConfError(`${path}: ${field} ${why} (incident-platform backlog #0-313: `
    + 'provision.sh writes it)');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const fields = {};
  for (const line of lines) {
    const match = /^(ADDR|PORTS)=(.*)$/.exec(line);
    if (!match) {
      throw refuse('a line', 'is neither ADDR=<IPv4> nor PORTS=<port>[,<port>]');
    }
    if (Object.hasOwn(fields, match[1])) {
      throw refuse(match[1], 'is given twice');
    }
    fields[match[1]] = match[2];
  }
  for (const field of ['ADDR', 'PORTS']) {
    if (!Object.hasOwn(fields, field)) {
      throw refuse(field, 'is missing');
    }
  }
  const addr = fields.ADDR;
  if (!IPV4.test(addr)) {
    throw refuse('ADDR', 'is not an IPv4 literal');
  }
  if (addr === '0.0.0.0' || addr.startsWith('127.')) {
    // A wildcard or loopback would put the proxy where every process, or no container, reaches it.
    throw refuse('ADDR', 'is a wildcard or a loopback address');
  }
  if (!local().includes(addr)) {
    throw refuse('ADDR', 'is the address of no interface of this host');
  }
  const parts = fields.PORTS.split(',');
  if (!parts.every((p) => PORT.test(p))) {
    throw refuse('PORTS', 'is not a comma-separated list of ports');
  }
  const ports = parts.map(Number);
  if (!ports.every((p) => p >= 1024 && p <= 65535 && (p < EPHEMERAL.low || p > EPHEMERAL.high))) {
    throw refuse('PORTS', `holds a port outside 1024 to 65535, or in the ephemeral range ${EPHEMERAL.low} to `
      + `${EPHEMERAL.high}`);
  }
  if (new Set(ports).size !== ports.length) {
    throw refuse('PORTS', 'holds a port twice');
  }
  return { addr, ports };
}

/**
 * Reads the proxy's configuration (#0-313), checked as the file of uid 0 that provision.sh writes.
 *
 * @param {{ proxyTesting?: { conf?: string, owner?: number } }} [options] for the tests only: the file's path and the
 *   owner it must have (root's on the VM)
 * @returns {Promise<{ addr: string, ports: number[] }>}
 */
export async function readProxyConf({ proxyTesting = {} } = {}) {
  const path = proxyTesting.conf ?? PROXY_CONF;
  let text;
  try {
    text = await readOwnFile(path, { what: 'the proxy\'s configuration', forbiddenMode: 0o022,
      uid: proxyTesting.owner ?? 0, maxBytes: 256, refuse: (message) => new ProxyConfError(message) });
  } catch (error) {
    if (error instanceof ProxyConfError) {
      throw error;
    }
    throw new ProxyConfError(`the proxy's configuration ${path} cannot be read (${error.code ?? error.name}): `
      + 'provision.sh writes it (incident-platform backlog #0-313)');
  }
  return parseProxyConf(text, { path });
}
