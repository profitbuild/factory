// Not a test file. A fake of `factory`'s side of the build VM for the task container's tests (incident-platform backlog
// #0-277): sudo, docker and the devcontainer CLI, as one program a test hands the starter as its `sudo`. CI has no
// factory daemon and no sudo rule, so:
//  - the fake sudo checks the command line the rule allows (`-n -H -u factory --`, then /usr/bin/docker or
//    /usr/local/bin/devcontainer by its full path), records each call (argv, the size of stdin, the names of the
//    environment it was given) to calls.jsonl, and runs the fake program;
//  - the fake docker is a small daemon kept in state.json: containers (running or not, with labels, mounts, the
//    volumes they use), networks, volumes, images and their labels. `volume rm` refuses a volume a container, even a
//    stopped one, still uses, as docker does (probed, ADR-0062 point 7), so a sweep out of order fails here too;
//  - a helper (`docker run ... --entrypoint /bin/sh <image> -c <script> helper /tasks <runId>`) runs its script for
//    real, with /home/factory/tasks mapped to the test's tasks/ and a `chown` that records its arguments (a test is
//    not root): the clone is a real git's, the removal a real rm's;
//  - `docker exec ... <id> <command>` runs the command for real (`timeout` included), in the container's workspace
//    as mapped (an argument that is /workspace mapped too, and /tmp/ to the test's own directory, mapped back in what
//    it prints), with the -e variables it was given;
//  - `docker info` answers as the VM's rootless Docker 29.9.3 (docker-hostconfig.mjs), unless the scenario says
//    otherwise (scenario.info: fields replaced);
//  - `devcontainer build` (#0-284) reads its configuration (`--config`), writes the features' lockfile beside it as
//    up does, and makes an image tagged with `--image-name` whose devcontainer.metadata label is what the real CLI
//    would write (the features' entries, then the configuration's own), unless the scenario says otherwise;
//    `docker image inspect --format {{.Id}} <name>` gives its ID;
//  - `docker container inspect` gives a HostConfig as Docker 29.9.3 does (docker-hostconfig.mjs) with what the run
//    set (capabilities, security options, extra hosts, mounts), and what scenario.hostConfig changes;
//  - `devcontainer up` reads the override (`--config`) and, as the real CLI does, writes the features' lockfile
//    beside the configuration file it was given, failing when that is in the clone or cannot be written; it makes a
//    container from the override (mounts from workspaceMount, the `--mount=` run arguments and those of the image's
//    label) and an image whose devcontainer.metadata label is what the real CLI would write, the features' entries from their artifacts (feature-artifact.mjs), unless the scenario says
//    otherwise.
// A scenario (state.scenario) changes one thing: an image's labels, extra mounts, a container that appears after a
// command (a rollback starting while the run builds), an rm that removes nothing, an exec that hangs with an orphan
// holding its output.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VM_DOCKER_INFO, dockerDefaultHostConfig } from './docker-hostconfig.mjs';
import { labelEntry } from './feature-artifact.mjs';
import { checkShellSafe } from './state-dir.mjs';

const PROGRAMS = { '/usr/bin/docker': 'docker', '/usr/local/bin/devcontainer': 'devcontainer' };
const TASKS_ROOT = '/home/factory/tasks';
const SELF = fileURLToPath(import.meta.url);

/**
 * A fake for a test: its own directory under `root`, an empty daemon, and the path of its sudo.
 *
 * @param {string} root
 * @param {{ scenario?: object, containers?: object[], networks?: object[], volumes?: object[] }} [initial]
 */
export function makeFakeDaemon(root, initial = {}) {
  const dir = join(root, 'fake');
  const tasks = join(root, 'tasks');
  const shims = join(dir, 'shims');
  const tmp = join(dir, 'tmp');
  // Refused before anything is made or run: the container's /tmp/ goes unquoted into the unpacking script's text.
  checkShellSafe(tmp, 'the fake daemon\'s /tmp/ (config.tmp)');
  mkdirSync(shims, { recursive: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  mkdirSync(tasks, { recursive: true, mode: 0o700 });
  // $FACTORY_STATE_DIR as the starter is given it (#0-284: where it keeps each call's stderr): the test's own state
  // directory when it is made under the same root, 700.
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const config = { dir, tasks, shims, tmp, state: join(dir, 'state.json'), calls: join(dir, 'calls.jsonl') };
  writeFileSync(join(shims, 'chown'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'chown.log'))}\n`);
  chmodSync(join(shims, 'chown'), 0o755);
  const sudo = join(dir, 'sudo.mjs');
  writeFileSync(sudo, `#!${process.execPath}\nimport { fakeSudo } from ${JSON.stringify(SELF)};\n`
    + `await fakeSudo(${JSON.stringify(config)});\n`);
  chmodSync(sudo, 0o755);
  const state = {
    containers: [], networks: [{ id: hex(), name: 'bridge', labels: {} }, { id: hex(), name: 'host', labels: {} },
      { id: hex(), name: 'none', labels: {} }],
    volumes: [], images: {}, tags: {}, scenario: {}, ...initial,
  };
  writeFileSync(config.state, JSON.stringify(state));
  const read = () => JSON.parse(readFileSync(config.state, 'utf8'));
  return {
    sudo,
    stateDir,
    /** What every starter call of a test is given: the fake's sudo and the state directory. */
    runner: { sudo, stateDir },
    tasks,
    tmp,
    /** A path of the container's /tmp/ as the host holds it, under the test's own directory. */
    hostTmp: (path) => path.replace(/^\/tmp\//, `${tmp}/`),
    read,
    write: (next) => writeFileSync(config.state, JSON.stringify(next)),
    update(change) {
      const next = read();
      change(next);
      writeFileSync(config.state, JSON.stringify(next));
    },
    calls: () => {
      try {
        return readFileSync(config.calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    chowns: () => {
      try {
        return readFileSync(join(dir, 'chown.log'), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/** A container of the fake daemon, as a test plants it. */
export function plantedContainer({ name, labels = {}, running = true, volumes = [], anonymous = [] }) {
  return { id: hex(), name, labels, running, image: `sha256:${hex()}`, mounts: [], volumes, anonymous,
    privileged: false, capAdd: [], workspace: null };
}

function hex() {
  return randomBytes(32).toString('hex');
}

const out = (text) => process.stdout.write(text);
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The fake sudo: the rule's command line, or a refusal as sudo's own. */
export async function fakeSudo(config) {
  const argv = process.argv.slice(2);
  const [n, h, u, user, dashes, program, ...args] = argv;
  const entry = { argv, env: Object.keys(process.env).sort() };
  if (n !== '-n' || h !== '-H' || u !== '-u' || user !== 'factory' || dashes !== '--' || !PROGRAMS[program]) {
    appendFileSync(config.calls, `${JSON.stringify({ ...entry, refused: true })}\n`);
    fail('sudo: a password is required');
    return;
  }
  const kind = PROGRAMS[program];
  const takesInput = (kind === 'docker' && (args[0] === 'run' || args[0] === 'exec'));
  if (!takesInput) {
    appendFileSync(config.calls, `${JSON.stringify({ ...entry, program: kind, args })}\n`);
  }
  const context = { config, state: JSON.parse(readFileSync(config.state, 'utf8')), args, entry };
  const save = () => writeFileSync(config.state, JSON.stringify(context.state));
  context.save = save;
  if (kind === 'devcontainer') {
    return devcontainer(context);
  }
  return docker(context, takesInput);
}

const host = (config, path) => (path === TASKS_ROOT || path.startsWith(`${TASKS_ROOT}/`)
  ? config.tasks + path.slice(TASKS_ROOT.length) : path);

/** --filter values of a list command, and the rest. */
function filters(args) {
  const found = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--filter') {
      found.push(args[i + 1]);
    }
  }
  return found;
}

function matches(item, list) {
  return list.every((f) => {
    if (f === 'type=custom') {
      return !['bridge', 'host', 'none'].includes(item.name);
    }
    const label = /^label=([^=]+)(?:=(.*))?$/.exec(f);
    if (!label) {
      throw new Error(`the fake docker has no filter ${f}`);
    }
    return Object.hasOwn(item.labels ?? {}, label[1]) && (label[2] === undefined || item.labels[label[1]] === label[2]);
  });
}

function after(context, key) {
  const added = context.state.scenario.after?.[key];
  if (added) {
    context.state.containers.push(...added);
    delete context.state.scenario.after[key];
  }
  const volumes = context.state.scenario.afterVolumes?.[key];
  if (volumes) {
    context.state.volumes.push(...volumes);
    delete context.state.scenario.afterVolumes[key];
  }
}

async function docker(context, takesInput) {
  const { state, args, save, config } = context;
  const [command, ...rest] = args;
  const sub = `${command} ${rest[0] ?? ''}`;
  if (command === 'ps') {
    const all = rest.includes('-a');
    const list = state.containers.filter((c) => (all || c.running) && matches(c, filters(rest)));
    out(list.map((c) => `${c.id} ${c.name}\n`).join(''));
    return;
  }
  if (command === 'rm') {
    const ids = rest.filter((a) => !a.startsWith('-'));
    if (!state.scenario.ignoreRm) {
      const gone = state.containers.filter((c) => ids.includes(c.id));
      state.containers = state.containers.filter((c) => !ids.includes(c.id));
      const anonymous = gone.flatMap((c) => c.anonymous ?? []);
      state.volumes = state.volumes.filter((v) => !anonymous.includes(v.name));
    }
    save();
    return;
  }
  if (command === 'kill') {
    const ids = rest.filter((a) => !a.startsWith('-'));
    for (const c of state.containers.filter((x) => ids.includes(x.id))) {
      c.running = false;
      for (const pid of c.pids ?? []) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // gone already
        }
      }
      c.pids = [];
    }
    save();
    return;
  }
  if (sub.startsWith('network ls')) {
    const list = state.networks.filter((n) => matches(n, filters(rest)));
    out(list.map((n) => `${n.id} ${n.name}\n`).join(''));
    return;
  }
  if (sub.startsWith('network rm')) {
    if (state.scenario.networkRmFails) {
      fail('Error response from daemon: error while removing network: failed by the scenario');
      return;
    }
    const ids = rest.slice(1);
    state.networks = state.networks.filter((n) => !ids.includes(n.id));
    save();
    return;
  }
  if (sub.startsWith('network create')) {
    const label = /^([^=]+)=(.*)$/.exec(rest[rest.indexOf('--label') + 1]);
    state.networks.push({ id: hex(), name: rest.at(-1), labels: { [label[1]]: label[2] } });
    after(context, 'network create');
    save();
    return;
  }
  if (sub.startsWith('volume ls')) {
    out(state.volumes.filter((v) => matches(v, filters(rest))).map((v) => `${v.name}\n`).join(''));
    return;
  }
  if (sub.startsWith('volume rm')) {
    const names = rest.slice(1);
    const used = names.filter((name) => state.containers.some((c) => (c.volumes ?? []).includes(name)
      || (c.anonymous ?? []).includes(name)));
    state.volumes = state.volumes.filter((v) => !names.includes(v.name) || used.includes(v.name));
    save();
    if (used.length > 0) {
      fail(`Error response from daemon: remove ${used[0]}: volume is in use`);
    }
    return;
  }
  if (sub.startsWith('volume create')) {
    const i = rest.indexOf('--label');
    const label = i < 0 ? null : /^([^=]+)=(.*)$/.exec(rest[i + 1]);
    const name = rest.at(-1);
    if (!state.volumes.some((v) => v.name === name)) {
      state.volumes.push({ name, labels: label ? { [label[1]]: label[2] } : {} });
    }
    save();
    out(`${name}\n`);
    return;
  }
  if (command === 'info') {
    out(`${JSON.stringify({ ...VM_DOCKER_INFO, ...state.scenario.info })}\n`);
    return;
  }
  if (sub.startsWith('container inspect')) {
    const c = state.containers.find((x) => x.id === rest.at(-1));
    if (!c) {
      fail('Error: No such container');
      return;
    }
    out(`${JSON.stringify({
      Id: c.id, Image: c.image, Config: { Labels: c.labels }, HostConfig: c.hostConfig ?? { Privileged: c.privileged,
        CapAdd: c.capAdd },
      Mounts: c.mounts,
    })}\n`);
    return;
  }
  if (sub.startsWith('image inspect')) {
    const ref = rest.at(-1);
    const id = state.images[ref] ? ref : state.tags?.[ref];
    const image = id === undefined ? undefined : state.images[id];
    if (!image) {
      fail('Error: No such image');
      return;
    }
    const format = rest[rest.indexOf('--format') + 1];
    out(format === '{{.Id}}' ? `${id}\n` : `${JSON.stringify(image.labels)}\n`);
    return;
  }
  if (command === 'run' || command === 'exec') {
    const input = await readStdin();
    appendFileSync(config.calls, `${JSON.stringify({ ...context.entry, program: 'docker', args,
      stdinBytes: input.length, stdinSha: createHash('sha256').update(input).digest('hex') })}\n`);
    return command === 'run' ? helperRun(context, input) : exec(context, input);
  }
  fail(`the fake docker has no command ${args.join(' ')}`);
}

function helperRun(context, input) {
  const { args, config, state } = context;
  const c = args.indexOf('-c');
  const failsOn = state.scenario.helperFails;
  if (failsOn === true || (typeof failsOn === 'string' && args[c + 1].includes(failsOn))) {
    fail('helper: failed by the scenario');
    return undefined;
  }
  const mount = args[args.indexOf('--mount') + 1];
  const source = /source=([^,]+)/.exec(mount)[1];
  const target = /target=([^,]+)/.exec(mount)[1];
  const [script, name, ...positionals] = args.slice(c + 1);
  const mapped = positionals.map((p) => (p === target ? host(config, source) : p));
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script, name, ...mapped], {
      stdio: ['pipe', 'inherit', 'inherit'], env: { PATH: `${config.shims}:/usr/bin:/bin` },
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

function exec(context, input) {
  const { args, state, config, save } = context;
  let i = 1;
  const env = { PATH: '/usr/bin:/bin' };
  while (args[i]?.startsWith('-')) {
    if (args[i] === '-e') {
      const [name, ...value] = args[i + 1].split('=');
      env[name] = value.join('=');
      i += 2;
    } else if (args[i] === '--user' || args[i] === '-w') {
      i += 2;
    } else {
      i += 1;
    }
  }
  const container = state.containers.find((x) => x.id === args[i]);
  if (!container?.running) {
    fail(`Error response from daemon: container ${args[i]} is not running`);
    return undefined;
  }
  // An argument naming the container's /workspace is the workspace as mapped, as its -w is (#0-278: the product's
  // command is run with the clone as its directory). The container's /tmp/ is the test's own directory (review
  // round 1 of factory#20, f): every /tmp/ in an argument, a script's text included, is mapped there, and mapped
  // back in what the call prints, so the call sees /tmp/ and the host's /tmp is never touched.
  const mapsTmp = args.slice(i + 1).some((a) => a.includes('/tmp/'));
  if (mapsTmp) {
    // Again where it is used: a config written by hand could hold another (review round 2 of factory#20, 1).
    checkShellSafe(config.tmp, 'the fake daemon\'s /tmp/ (config.tmp)');
  }
  const command = args.slice(i + 1).map((a) => (a === '/workspace' ? host(config, container.workspace)
    : a.replaceAll('/tmp/', `${config.tmp}/`)));
  if (state.scenario.execFails && (state.scenario.execFails.when === undefined
    || command.some((a) => a.includes(state.scenario.execFails.when)))) {
    // The call ran and failed, writing what the scenario gives to stderr: the agent's side's words (`when`: only a
    // call with an argument holding it).
    fail(state.scenario.execFails.stderr, state.scenario.execFails.code);
    return undefined;
  }
  if (state.scenario.execHangs) {
    // The CLI is gone, but an orphan of its holds its stdout open: the dispatcher must stop reading by itself.
    const orphan = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    container.pids = [...(container.pids ?? []), orphan.pid];
    save();
    orphan.unref();
    return new Promise(() => {});
  }
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: host(config, container.workspace), stdio: ['pipe', mapsTmp ? 'pipe' : 'inherit', 'inherit'], env,
      detached: true,
    });
    container.pids = [...(container.pids ?? []), child.pid];
    save();
    const out = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      if (mapsTmp) {
        process.stdout.write(Buffer.from(Buffer.concat(out).toString('latin1').split(`${config.tmp}/`).join('/tmp/'),
          'latin1'));
      }
      process.exitCode = code ?? (signal === 'SIGKILL' ? 137 : 1);
      resolve();
    });
  });
}

function parseMount(text) {
  const fields = Object.fromEntries(text.split(',').map((kv) => {
    const [k, ...v] = kv.split('=');
    return [k, v.length === 0 ? true : v.join('=')];
  }));
  return { Type: fields.type, Name: fields.type === 'volume' ? fields.source : undefined,
    Source: fields.type === 'volume' ? `/var/lib/docker/volumes/${fields.source}/_data` : fields.source,
    Destination: fields.target, RW: fields.readonly !== true };
}

function metadataMounts(label) {
  let entries = [];
  try {
    entries = [JSON.parse(label ?? '[]')].flat();
  } catch {
    return [];
  }
  return entries.flatMap((e) => (Array.isArray(e?.mounts) ? e.mounts : [])).filter((m) => typeof m === 'object')
    .map((m) => ({ Type: m.type, Source: m.source, Destination: m.target, RW: m.readonly !== true }));
}

/**
 * The label the real CLI writes: the features' entries, made from their artifacts at their digests (never from the
 * dispatcher's list, review round 1 arc-c7d1), then the configuration's own.
 */
function defaultMetadata(override) {
  const features = Object.keys(override.features ?? {}).map((ref) => labelEntry(ref.split('@')[1], ref));
  const own = {};
  for (const name of ['remoteUser', 'capAdd', 'containerEnv', 'updateRemoteUserUID', 'containerUser',
    'postCreateCommand', 'postStartCommand']) {
    if (override[name] !== undefined) {
      own[name] = override[name];
    }
  }
  return [...features, own];
}

/** The features' lockfile, written beside the configuration file as the real CLI (0.89.0) does; false if it failed. */
function writeLock(config, configFile, workspace, override) {
  // In the clone, `dev`'s (1000:1000, a subuid on the host), `factory` may not write, so the CLI fails there (EACCES,
  // the VM's run of 2026-11-20): the fake fails too, and when the directory cannot be written.
  const lockName = basename(configFile).startsWith('.') ? '.devcontainer-lock.json' : 'devcontainer-lock.json';
  const lockFile = join(dirname(configFile), lockName);
  if (lockFile.startsWith(`${workspace}/`)) {
    fail(`Error: EACCES: permission denied, open '${lockFile}'`);
    return false;
  }
  const lock = { features: Object.fromEntries(Object.keys(override.features ?? {})
    .map((ref) => [ref, { resolved: ref, integrity: ref.split('@')[1] }])) };
  try {
    writeFileSync(host(config, lockFile), `${JSON.stringify(lock, null, 2)}\n`);
  } catch (error) {
    fail(`Error: ${error.code}: could not write '${lockFile}'`);
    return false;
  }
  return true;
}

/** An image made from `override` (a build, or up given one to build), its label the real CLI's or the scenario's. */
function makeImage(state, override) {
  const image = state.scenario.imageId
    ?? `sha256:${createHash('sha256').update(JSON.stringify(override) + hex()).digest('hex')}`;
  state.images[image] = { labels: state.scenario.imageLabels
    ?? { 'devcontainer.metadata': JSON.stringify(defaultMetadata(override)) } };
  return image;
}

/** `devcontainer build --config <file> --workspace-folder <dir> --image-name <name>` (#0-284). */
function build(context) {
  const { args, config, state, save } = context;
  const option = (name) => args[args.indexOf(name) + 1];
  if (state.scenario.buildFails) {
    fail(typeof state.scenario.buildFails === 'string' ? state.scenario.buildFails : 'devcontainer build: failed');
    return;
  }
  const configFile = option('--config');
  const override = JSON.parse(readFileSync(host(config, configFile), 'utf8'));
  if (!writeLock(config, configFile, option('--workspace-folder'), override)) {
    return;
  }
  const image = makeImage(state, override);
  state.tags[option('--image-name')] = image;
  save();
  out(`${JSON.stringify({ outcome: 'success', imageName: [option('--image-name')] })}\n`);
}

/** HostConfig as Docker 29.9.3 gives it for the container up makes: its defaults, and what the run set. */
function hostConfigOf(override, metadata, mounts, scenario) {
  const entries = (() => {
    try {
      return [JSON.parse(metadata ?? '[]')].flat();
    } catch {
      return [];
    }
  })();
  const capAdd = [...new Set([...(override.capAdd ?? []), ...entries.flatMap((e) => e?.capAdd ?? [])])];
  const securityOpt = [...new Set(entries.flatMap((e) => (Array.isArray(e?.securityOpt) ? e.securityOpt : [])))];
  const extraHosts = (override.runArgs ?? []).filter((a) => a.startsWith('--add-host=')).map((a) => a.slice(11));
  return {
    ...dockerDefaultHostConfig(),
    CapAdd: capAdd.length > 0 ? capAdd.map((c) => `CAP_${c}`) : null,
    SecurityOpt: securityOpt.length > 0 ? securityOpt : null,
    ExtraHosts: extraHosts.length > 0 ? extraHosts : null,
    Privileged: scenario.privileged ?? false,
    Mounts: mounts.map((m) => ({ Type: m.Type, Source: m.Type === 'volume' ? m.Name : m.Source, Target: m.Destination,
      ...(m.RW ? {} : { ReadOnly: true }) })),
    ...scenario.hostConfig,
  };
}

function devcontainer(context) {
  const { args, config, state, save } = context;
  const option = (name) => args[args.indexOf(name) + 1];
  if (args[0] === 'build') {
    return build(context);
  }
  if (args[0] !== 'up') {
    fail(`the fake devcontainer has no command ${args[0]}`);
    return;
  }
  if (state.scenario.upFails) {
    fail(typeof state.scenario.upFails === 'string' ? state.scenario.upFails : 'devcontainer up: failed by the scenario');
    return;
  }
  // The configuration file, as the real CLI takes it: `--config`, or else the workspace's .devcontainer/devcontainer.json
  // (with `--override-config` too, which only replaces what is read from it).
  const workspace = option('--workspace-folder');
  const given = args.includes('--config') ? '--config' : '--override-config';
  const configFile = given === '--config' ? option('--config') : `${workspace}/.devcontainer/devcontainer.json`;
  const override = JSON.parse(readFileSync(host(config, option(given)), 'utf8'));
  if (!writeLock(config, configFile, workspace, override)) {
    return;
  }
  const [labelKey, labelValue] = option('--id-label').split('=');
  // As the real CLI: a configuration with a build or features is built again, into a new image; one with an image
  // alone runs it.
  const builds = override.build !== undefined || Object.keys(override.features ?? {}).length > 0;
  const image = !builds && override.image !== undefined ? override.image : makeImage(state, override);
  if (!state.images[image]) {
    fail(`Error: No such image: ${image}`);
    return;
  }
  const mounts = [
    parseMount(override.workspaceMount),
    ...override.runArgs.filter((a) => a.startsWith('--mount=')).map((a) => parseMount(a.slice('--mount='.length))),
    // What the image's label adds, as devcontainer up merges it: the features' mounts among them.
    ...metadataMounts(state.images[image].labels?.['devcontainer.metadata']),
    ...(state.scenario.extraMounts ?? []),
  ];
  const container = {
    id: hex(), name: `task-${labelValue}`, labels: { [labelKey]: labelValue }, running: true,
    image: state.scenario.runImage ?? image, mounts,
    volumes: mounts.filter((m) => m.Type === 'volume').map((m) => m.Name), anonymous: [],
    privileged: state.scenario.privileged ?? false, capAdd: override.capAdd ?? [],
    workspace: /source=([^,]+)/.exec(override.workspaceMount)[1],
    hostConfig: hostConfigOf(override, state.images[image].labels?.['devcontainer.metadata'], mounts, state.scenario),
  };
  state.containers.push(container);
  after(context, 'up');
  save();
  out(`${JSON.stringify({ outcome: 'success', containerId: container.id, remoteUser: override.remoteUser,
    remoteWorkspaceFolder: override.workspaceFolder })}\n`);
}
