// The credential proxy's files (incident-platform backlog #0-313): /etc/factory-proxy.conf as provision.sh writes it
// (review of #0-313's plan, A), Claude's key (K), and the fresh-VM marker create.sh writes and a run consumes (AC6,
// I). Each off its form is refused naming the file and the field, never a value; the marker's consumption is compare
// and set in the dispatcher's state, so a second run on the same VM is stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EPHEMERAL, ProxyConfError, defaultRouteInterfaces, parseProxyConf, readProxyConf,
} from '../src/proxy/conf.mjs';
import { ClaudeKeyError, DEFAULT_CLAUDE_KEY, readClaudeEnv, readClaudeKey } from '../src/proxy/key.mjs';
import { FreshVmError, consumeFreshVm, consumedPath, readFreshVmMarker } from '../src/proxy/fresh-vm.mjs';
import { keyMarker, localAddress, routeTable } from '../testing/proxy-files.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const ADDR = localAddress();
const local = () => [ADDR, '127.0.0.1'];
const parse = (text, routed = ['10.0.2.15']) => parseProxyConf(text, { path: '/etc/factory-proxy.conf', local,
  routed });

test('#0-313 (A): the proxy\'s configuration is ADDR and PORTS: a local, non-loopback IPv4 and ports outside the '
  + 'ephemeral range; anything else is refused by file and field, never by value', () => {
  assert.deepEqual(parse(`ADDR=${ADDR}\nPORTS=8770\n`), { addr: ADDR, ports: [8770] });
  assert.deepEqual(parse(`PORTS=8770,8771\nADDR=${ADDR}`), { addr: ADDR, ports: [8770, 8771] });
  assert.deepEqual(EPHEMERAL, { low: 32768, high: 60999 });
  const cases = [
    ['ADDR=0.0.0.0\nPORTS=8770\n', /ADDR is a wildcard or a loopback address/],
    ['ADDR=127.0.0.1\nPORTS=8770\n', /ADDR is a wildcard or a loopback address/],
    ['ADDR=127.9.9.9\nPORTS=8770\n', /ADDR is a wildcard or a loopback address/],
    ['ADDR=203.0.113.77\nPORTS=8770\n', /ADDR is the address of no interface of this host/],
    ['ADDR=10.0.0.256\nPORTS=8770\n', /ADDR is not an IPv4 literal/],
    ['ADDR=fe80::1\nPORTS=8770\n', /ADDR is not an IPv4 literal/],
    ['ADDR=::\nPORTS=8770\n', /ADDR is not an IPv4 literal/],
    ['ADDR=proxy.invalid\nPORTS=8770\n', /ADDR is not an IPv4 literal/],
    [`ADDR=${ADDR} \nPORTS=8770\n`, /ADDR is not an IPv4 literal/],
    [`ADDR=${ADDR}\n`, /PORTS is missing/],
    ['PORTS=8770\n', /ADDR is missing/],
    [`ADDR=${ADDR}\nADDR=${ADDR}\nPORTS=8770\n`, /ADDR is given twice/],
    [`ADDR=${ADDR}\nPORTS=8770\nEXTRA=1\n`, /a line is neither ADDR=/],
    [`ADDR=${ADDR}\nPORTS=8770\n\n`, /a line is neither ADDR=/],
    [`ADDR=${ADDR}\nPORTS=80\n`, /PORTS is not a comma-separated list of ports/],
    [`ADDR=${ADDR}\nPORTS=1023\n`, /PORTS is not a comma-separated list of ports|PORTS holds a port outside/],
    [`ADDR=${ADDR}\nPORTS=32768\n`, /PORTS holds a port outside 1024 to 65535, or in the ephemeral range/],
    [`ADDR=${ADDR}\nPORTS=60999\n`, /in the ephemeral range/],
    [`ADDR=${ADDR}\nPORTS=65536\n`, /PORTS holds a port outside/],
    [`ADDR=${ADDR}\nPORTS=8770,8770\n`, /PORTS holds a port twice/],
    [`ADDR=${ADDR}\nPORTS=8770,\n`, /PORTS is not a comma-separated list/],
    [`ADDR=${ADDR}\nPORTS= 8770\n`, /PORTS is not a comma-separated list/],
  ];
  for (const [text, pattern] of cases) {
    assert.throws(() => parse(text), (error) => {
      assert.ok(error instanceof ProxyConfError, text);
      assert.match(error.message, pattern, text);
      assert.match(error.message, /^\/etc\/factory-proxy\.conf: /);
      // The range's bounds are the dispatcher's own constants; no value of the file's is named.
      for (const value of ['203.0.113.77', '10.0.0.256', 'proxy.invalid', 'fe80', '8770', '65536', 'EXTRA']) {
        assert.ok(!error.message.includes(value), `${error.message} names no value`);
      }
      return true;
    });
  }
  assert.deepEqual(parse(`ADDR=${ADDR}\nPORTS=60001\n`.replace('60001', '61000')), { addr: ADDR, ports: [61000] });
  // The VM's own address, a default route's interface's (the owner's answer, 2026-11-23); and a table not read.
  for (const routed of [[ADDR], ['10.0.2.15', ADDR], null]) {
    assert.throws(() => parse(`ADDR=${ADDR}\nPORTS=8770\n`, routed), (error) => error instanceof ProxyConfError
      && /^\/etc\/factory-proxy\.conf: ADDR is the address of an interface a default route leaves by, not one of the /
        .test(error.message) && !error.message.includes(ADDR));
  }
});

test('#0-313 (the owner\'s answer, 2026-11-23): the interfaces a default route leaves by come from /proc/net/route; '
  + 'ADDR on one of them, or a table that cannot be read, refuses the run', async (t) => {
  assert.deepEqual(defaultRouteInterfaces(routeTable('eth0')), ['eth0']);
  assert.deepEqual(defaultRouteInterfaces(`${routeTable('eth0')}${routeTable('wg0').split('\n').slice(1).join('\n')}`),
    ['eth0', 'wg0']);
  assert.deepEqual(defaultRouteInterfaces(routeTable('eth0').split('\n').filter((l) => !l.includes('\t00000000\t0'))
    .join('\n')), [], 'no default route');
  assert.equal(defaultRouteInterfaces('eth0\t00000000\n'), null, 'no header of the kernel\'s');
  assert.equal(defaultRouteInterfaces(''), null);
  const state = await makeStateDir();
  t.after(state.remove);
  const conf = join(state.dir, 'proxy.conf');
  const routes = join(state.dir, 'route');
  await writeFile(conf, `ADDR=${ADDR}\nPORTS=8770\n`, { mode: 0o644 });
  const owner = process.getuid();
  const iface = Object.entries((await import('node:os')).networkInterfaces())
    .find(([, entries]) => entries.some((e) => e.address === ADDR))[0];
  await writeFile(routes, routeTable(iface));
  await assert.rejects(readProxyConf({ proxyTesting: { conf, owner, routes } }),
    /ADDR is the address of an interface a default route leaves by/);
  // This host's own table, as the VM's would be read: ADDR (the host's address) is its default route's.
  await assert.rejects(readProxyConf({ proxyTesting: { conf, owner } }),
    /ADDR is the address of an interface a default route leaves by|ADDR is the address of no interface/);
  await writeFile(routes, routeTable('nonexistent0'));
  assert.deepEqual(await readProxyConf({ proxyTesting: { conf, owner, routes } }), { addr: ADDR, ports: [8770] });
  for (const bad of [join(state.dir, 'none'), conf]) {
    await assert.rejects(readProxyConf({ proxyTesting: { conf, owner, routes: bad } }),
      /^Error: \S+: ADDR cannot be checked: the route table \/proc\/net\/route cannot be read/);
  }
});

test('#0-313 (A): the file must be root\'s and writable by no one else, no link; missing, it refuses the run',
  async (t) => {
    const state = await makeStateDir();
    t.after(state.remove);
    const conf = join(state.dir, 'proxy.conf');
    await writeFile(conf, `ADDR=${ADDR}\nPORTS=8770\n`, { mode: 0o644 });
    const owner = process.getuid();
    const routes = join(state.dir, 'route');
    await writeFile(routes, routeTable('nonexistent0'));
    assert.deepEqual(await readProxyConf({ proxyTesting: { conf, owner, routes } }), { addr: ADDR, ports: [8770] });
    await assert.rejects(readProxyConf({ proxyTesting: { conf, owner: owner + 1 } }),
      /is owned by uid \d+, not by this process's/);
    await assert.rejects(readProxyConf({ proxyTesting: { conf } }), /is owned by uid \d+, not by this process's \(0\)/,
      'root\'s by default');
    for (const mode of [0o664, 0o646]) {
      await chmod(conf, mode);
      await assert.rejects(readProxyConf({ proxyTesting: { conf, owner } }), (error) => error instanceof ProxyConfError
        && /has mode/.test(error.message));
    }
    await chmod(conf, 0o644);
    const link = join(state.dir, 'link.conf');
    await symlink(conf, link);
    await assert.rejects(readProxyConf({ proxyTesting: { conf: link, owner } }), /not a regular file/);
    await assert.rejects(readProxyConf({ proxyTesting: { conf: join(state.dir, 'none'), owner } }),
      /cannot be read \(ENOENT\): provision\.sh writes it/);
  });

test('#0-313 (K): Claude\'s key is CLAUDE_KEY\'s file or the default, 600, one line of an Anthropic key; refused by '
  + 'its path, never its text', async (t) => {
  assert.deepEqual(readClaudeEnv({}), { keyPath: DEFAULT_CLAUDE_KEY });
  assert.equal(DEFAULT_CLAUDE_KEY, '/home/dispatcher/.config/factory/claude.key');
  assert.deepEqual(readClaudeEnv({ CLAUDE_KEY: '/x/k' }), { keyPath: '/x/k' });
  assert.throws(() => readClaudeEnv({ CLAUDE_KEY: 'relative' }), /CLAUDE_KEY/);
  assert.throws(() => readClaudeEnv({ CLAUDE_KEYS: '/x' }), /CLAUDE_KEYS/);
  const state = await makeStateDir();
  t.after(state.remove);
  const key = keyMarker();
  const path = join(state.dir, 'claude.key');
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  assert.equal(await readClaudeKey(path), key);
  const refused = async (pattern) => assert.rejects(readClaudeKey(path), (error) => {
    assert.ok(error instanceof ClaudeKeyError, error.message);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(key.slice(7, 30)), 'the key is in no refusal');
    return true;
  });
  await chmod(path, 0o640);
  await refused(/has mode 640/);
  await chmod(path, 0o600);
  for (const text of [`${key}\n${key}\n`, `${key.slice(0, 15)}\n`, `Bearer ${key}`, `${key} `, '']) {
    await writeFile(path, text);
    await refused(/is not one line holding an Anthropic key/);
  }
  await writeFile(path, 'x'.repeat(513));
  await refused(/more than 512/);
  await assert.rejects(readClaudeKey(join(state.dir, 'none')), /cannot be read \(ENOENT\)/);
});

test('#0-313 AC6: the fresh-VM marker is root\'s, 644 at most, 32 hex; the first run consumes it, compare and set, '
  + 'and every later run on the VM is stopped, naming the run that consumed it', async (t) => {
  const state = await makeStateDir();
  t.after(state.remove);
  const freshVm = join(state.dir, 'fresh-vm');
  const owner = process.getuid();
  const proxyTesting = { freshVm, owner };
  const marker = 'a3'.repeat(16);
  await writeFile(freshVm, `${marker}\n`, { mode: 0o644 });
  assert.equal(await readFreshVmMarker({ proxyTesting }), marker);
  const refused = async (promise, pattern) => assert.rejects(promise, (error) => {
    assert.ok(error instanceof FreshVmError, error.message);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(marker), 'the marker is in no refusal');
    return true;
  });
  await refused(readFreshVmMarker({ proxyTesting: { freshVm } }), /is owned by uid \d+, not by this process's \(0\)/);
  await chmod(freshVm, 0o664);
  await refused(readFreshVmMarker({ proxyTesting }), /has mode 664/);
  await chmod(freshVm, 0o644);
  for (const text of ['A3'.repeat(16), `${marker}0`, `${marker}\n${marker}\n`, '']) {
    await writeFile(freshVm, text);
    await refused(readFreshVmMarker({ proxyTesting }), /is not one line of 32 hex|is 66 bytes, more than 64/);
  }
  await refused(readFreshVmMarker({ proxyTesting: { freshVm: join(state.dir, 'none'), owner } }),
    /cannot be read \(ENOENT\): a run that holds a token runs only on a VM made anew by create\.sh/);
  await writeFile(freshVm, `${marker}\n`);
  const first = '20261122T180000Z-0e0313';
  await consumeFreshVm({ stateDir: state.dir, runId: first, proxyTesting });
  assert.deepEqual(JSON.parse(await readFile(consumedPath(state.dir), 'utf8')), { marker, runId: first });
  await refused(consumeFreshVm({ stateDir: state.dir, runId: '20261122T180001Z-0e0313', proxyTesting }),
    new RegExp(`^this VM has run a task before \\(by the run ${first}\\): a run that holds a token runs only on a VM `
      + 'made anew by create\\.sh, until #0-285$'));
  await writeFile(consumedPath(state.dir), '{', { mode: 0o600 });
  await refused(consumeFreshVm({ stateDir: state.dir, runId: '20261122T180002Z-0e0313', proxyTesting }),
    /^the record of the fresh-VM marker cannot be read: /);
  await writeFile(consumedPath(state.dir), JSON.stringify({ marker, runId: '../x' }), { mode: 0o600 });
  await refused(consumeFreshVm({ stateDir: state.dir, runId: '20261122T180003Z-0e0313', proxyTesting }),
    /^this VM has run a task before: /);
});
