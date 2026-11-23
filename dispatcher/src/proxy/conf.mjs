/**
 * Where the dispatcher's credential proxy listens (incident-platform backlog #0-313, M2.7; ADR-0060 D4, ADR-0064
 * point 5 as amended): one source, the VM's provisioning, never a second reading of the VM's network here (review of
 * #0-313's plan, A: two parsers of one fact could drift apart, ARC-02).
 *
 * incident-platform's provision.sh writes /etc/factory-proxy.conf at every boot, root:root, 0644, two lines:
 *
 *   ADDR=<the address of the dummy interface provision.sh sets up for the proxy>
 *   PORTS=8770[,<one more port per slot, in M5>]
 *
 * The proxy has an address of its own on the VM, on a dummy interface (the owner's measurement on the VM, 2026-11-23):
 * the dispatcher reads it from this file and from nowhere else, and works out no address of the VM's.
 *
 * and, for those ports, an INPUT rule that drops them from any device but lo (the VM's filter keeps the proxy
 * unreachable from outside the VM, #0-313 AC5) and a FACTORY-EGRESS rule that lets factory's containers reach them.
 * The dispatcher reads it once at the start of a run, before its slot section, and refuses the run before the daemon
 * when it is off its form: a regular file, no link, owned by uid 0, writable by no one else; ADDR an IPv4 literal of a
 * local interface (os.networkInterfaces()), neither a wildcard nor of 127.0.0.0/8, and no address of an interface a
 * default route leaves by (/proc/net/route): that is the VM's own address, which in a cloud its network sees (the
 * owner's answer, 2026-11-23). A route table that cannot be read refuses the run too. PORTS 1024 to 65535, outside
 * Linux's ephemeral range (32768 to 60999: rootlesskit publishes a container's ports there, and the VM's filter opens
 * that range to every container), none twice. A refusal names the file and the field, never a value.
 *
 * PORTS has a port per slot, for M5. Until #0-285 the fresh-VM marker allows one run per VM, whatever FACTORY_SLOTS
 * and however many ports (fresh-vm.mjs): a second port added early is no working second slot (review round 1 of
 * factory#29).
 */
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

import { readOwnFile } from '../config/own-file.mjs';

/** The file provision.sh writes (#0-313). */
export const PROXY_CONF = '/etc/factory-proxy.conf';
/** The kernel's IPv4 route table, read for the interfaces a default route leaves by. */
export const ROUTES = '/proc/net/route';
/** Linux's default ephemeral range (ip_local_port_range): no proxy port in it. */
export const EPHEMERAL = Object.freeze({ low: 32768, high: 60999 });

/** The proxy's configuration is missing or off its form: the run is refused before the daemon. */
export class ProxyConfError extends Error {}

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const PORT = /^[1-9][0-9]{3,4}$/;

/** The IPv4 addresses of this host's interfaces. */
const localAddresses = () => Object.values(networkInterfaces()).flat()
  .filter((entry) => entry?.family === 'IPv4').map((entry) => entry.address);

/** A route's Destination and Mask when they are zero, in /proc/net/route's hex. */
const ANY = '0'.repeat(8);

/**
 * The interfaces a default route leaves by, from /proc/net/route's text: a row whose Destination and Mask are both
 * zero (ANY, in the table's hex). A table off its form (no header of the kernel's) is null: the caller refuses.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
export function defaultRouteInterfaces(text) {
  const [header, ...rows] = text.split('\n');
  const columns = header?.trim().split(/\s+/) ?? [];
  const at = { iface: columns.indexOf('Iface'), dest: columns.indexOf('Destination'), mask: columns.indexOf('Mask') };
  if (at.iface !== 0 || at.dest < 0 || at.mask < 0) {
    return null;
  }
  return rows.map((row) => row.trim().split(/\s+/)).filter((cells) => cells.length > at.mask
    && cells[at.dest] === ANY && cells[at.mask] === ANY).map((cells) => cells[at.iface]);
}

/** The IPv4 addresses of the interfaces named. */
const addressesOf = (names) => names.flatMap((name) => networkInterfaces()[name] ?? [])
  .filter((entry) => entry?.family === 'IPv4').map((entry) => entry.address);

/**
 * The proxy's address and ports, from `text` (the file's), or a ProxyConfError naming `path` and the field.
 *
 * @param {string} text
 * @param {{ path: string, local?: () => string[], routed: string[] }} options `local` the host's IPv4 addresses
 *   (the tests'); `routed` the addresses of the interfaces a default route leaves by
 * @returns {{ addr: string, ports: number[] }}
 */
export function parseProxyConf(text, { path, local = localAddresses, routed }) {
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
  if (!Array.isArray(routed) || routed.includes(addr)) {
    // The VM's own address, which its network (a cloud's) reaches: the proxy listens on an address of its own.
    throw refuse('ADDR', 'is the address of an interface a default route leaves by, not one of the proxy\'s own');
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
 * @param {{ proxyTesting?: { conf?: string, owner?: number, routes?: string } }} [options] for the tests only: the
 *   file's path, the owner it must have (root's on the VM), and a route table of the test's
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
  let table = null;
  try {
    table = defaultRouteInterfaces(await readFile(proxyTesting.routes ?? ROUTES, 'utf8'));
  } catch {
    // unreadable: refused below
  }
  if (table === null) {
    throw new ProxyConfError(`${path}: ADDR cannot be checked: the route table ${ROUTES} cannot be read (#0-313)`);
  }
  return parseProxyConf(text, { path, routed: addressesOf(table) });
}
