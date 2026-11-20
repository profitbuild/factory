// The closed list of a task configuration (incident-platform ADR-0062 point 4; backlog #0-277 AC9), on a generic
// fixture (testing/task-product.mjs): what the list carries is carried, and each field or value off it is refused on
// its own, naming the field and never the value; the override is the dispatcher's; the built image's
// devcontainer.metadata label is held to the same list, a feature's entry only when it is exactly what the feature
// declares at the digest the lockfile pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskConfigError, buildOverride, checkImageMetadata, checkList, checkTaskConfig, TASK_CONFIG_LIST,
} from '../src/container/task-config.mjs';
import { CONFIG, CONFIG_PATH, FEATURE, FEATURE_DIGEST, FEATURE_REF, LOCK } from '../testing/task-product.mjs';

const RUN_ID = '20261120T101500Z-3f9a1c';
const check = (config, options = {}) => checkTaskConfig(config, { configPath: CONFIG_PATH, lock: LOCK, ...options });
const refused = (config, pattern, options) => assert.throws(() => check(config, options), (error) => {
  assert.ok(error instanceof TaskConfigError, `${error.constructor.name}: ${error.message}`);
  assert.match(error.message, pattern);
  assert.ok(!error.message.includes('VALUE-OF-THE-PRODUCT'), `the refusal quotes a value: ${error.message}`);
  return true;
});
const withField = (name, value) => ({ ...structuredClone(CONFIG), [name]: value });
const without = (name) => {
  const config = structuredClone(CONFIG);
  delete config[name];
  return config;
};

const METADATA = TASK_CONFIG_LIST.features[FEATURE].digests[FEATURE_DIGEST].metadata;

test('what the list carries is carried: the build in the configuration\'s directory, the user, the commands, the sets, '
  + 'the feature at the lockfile\'s digest', () => {
  assert.deepEqual(check(CONFIG), {
    dockerfile: '.devcontainer/Dockerfile', context: '.devcontainer', remoteUser: 'dev',
    postCreateCommand: ['echo', 'created'], postStartCommand: CONFIG.postStartCommand,
    capAdd: ['NET_ADMIN', 'NET_RAW'], runArgs: ['--add-host=host.docker.internal:host-gateway'],
    containerEnv: CONFIG.containerEnv,
    features: [{ id: FEATURE, ref: FEATURE_REF, digest: FEATURE_DIGEST, options: { moby: false }, metadata: METADATA }],
  });
  const minimal = check({ build: { dockerfile: 'sub/Dockerfile' }, remoteUser: 'agent' }, { lock: null });
  assert.deepEqual(minimal, { dockerfile: '.devcontainer/sub/Dockerfile', context: '.devcontainer', remoteUser: 'agent',
    capAdd: [], runArgs: [], containerEnv: {}, features: [] });
  assert.equal(checkTaskConfig({ build: { dockerfile: 'Dockerfile' }, remoteUser: 'dev' },
    { configPath: '.devcontainer.json' }).dockerfile, 'Dockerfile', 'a configuration at the root');
  assert.equal(check(withField('build', { dockerfile: './x/../Dockerfile', context: './' })).dockerfile,
    '.devcontainer/Dockerfile');
});

test('every field off the list is refused on its own, initializeCommand and the dispatcher\'s own among them', () => {
  for (const name of ['initializeCommand', 'mounts', 'workspaceMount', 'workspaceFolder', 'containerUser',
    'updateRemoteUserUID', 'image', 'name', 'hostRequirements', 'dockerComposeFile', 'privileged', 'securityOpt',
    'onCreateCommand', 'updateContentCommand', 'postAttachCommand', 'forwardPorts', 'appPort', 'customizations',
    'overrideCommand', 'shutdownAction', 'init', 'remoteEnv', 'userEnvProbe', '$schema', 'otherPortsAttributes']) {
    refused(withField(name, 'VALUE-OF-THE-PRODUCT'),
      new RegExp(`^the field "${name.replaceAll('$', '\\$')}" is not carried`));
  }
});

test('the build: only dockerfile and context, both in the configuration\'s directory or under it', () => {
  for (const key of ['options', 'args', 'target', 'cacheFrom']) {
    refused(withField('build', { dockerfile: 'Dockerfile', [key]: 'VALUE-OF-THE-PRODUCT' }),
      new RegExp(`^build\\.${key} is not carried`));
  }
  for (const dockerfile of ['../Dockerfile', '../../etc/Dockerfile', 'x/../../Dockerfile']) {
    refused(withField('build', { dockerfile }), /^build\.dockerfile leaves the configuration's directory$/);
  }
  for (const dockerfile of ['/etc/Dockerfile', '-f', 'a\\b', 'a\nb', '', 42, undefined]) {
    refused(withField('build', { dockerfile }), /^build\.dockerfile must be a relative path/);
  }
  refused(withField('build', { dockerfile: 'Dockerfile', context: '..' }), /^build\.context leaves/);
  refused(without('build'), /^build must be an object/);
  refused(withField('build', 'Dockerfile'), /^build must be an object/);
});

test('remoteUser is a user\'s name, never root; the commands are strings or arrays of strings', () => {
  for (const value of ['root', 'Root', '0', '', 'a b', '-x', 7, undefined]) {
    refused(withField('remoteUser', value), /^remoteUser must be the agents' user/);
  }
  refused(without('remoteUser'), /^remoteUser must be the agents' user/);
  for (const name of ['postCreateCommand', 'postStartCommand']) {
    for (const value of [{ a: 'x' }, '', '  ', [], [''], ['a', 1], 7, null]) {
      refused(withField(name, value), new RegExp(`^${name} must be a command`));
    }
  }
});

test('capAdd, runArgs and containerEnv hold only the list\'s values; a containerEnv value is literal and no secret',
  () => {
    for (const value of [['SYS_ADMIN'], ['NET_ADMIN', 'NET_ADMIN'], 'NET_ADMIN', ['net_admin'], [1]]) {
      refused(withField('capAdd', value), /^capAdd/);
    }
    for (const value of [['--privileged'], ['--network=host'], ['--add-host=evil.example:1.2.3.4'],
      ['--add-host', 'host.docker.internal:host-gateway'], ['-v', '/:/host'], ['--cap-add=SYS_ADMIN'],
      ['--add-host=host.docker.internal:host-gateway --privileged']]) {
      refused(withField('runArgs', value), /^runArgs/);
    }
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'FACTORY_BOT_LOGIN', 'GH_TOKEN', 'PATH']) {
      refused(withField('containerEnv', { [key]: 'x' }), new RegExp(`^containerEnv\\.${key} is not a key of the list's`));
    }
    for (const value of ['${localEnv:HOME}', '${containerEnv:PATH}', '${devcontainerId}', 'a${b}']) {
      refused(withField('containerEnv', { TESTCONTAINERS_HOST_OVERRIDE: value }), /containerEnv/);
    }
    const secret = 'ghs' + `_${'x'.repeat(36)}`;
    refused(withField('containerEnv', { TESTCONTAINERS_HOST_OVERRIDE: secret }),
      /^containerEnv\.TESTCONTAINERS_HOST_OVERRIDE holds a value shaped like a secret$/);
    refused(withField('containerEnv', { TESTCONTAINERS_HOST_OVERRIDE: 1 }), /must be a string/);
    refused(withField('containerEnv', ['x']), /^containerEnv must be an object/);
  });

test('no carried string names the host\'s environment or paths: ${localEnv:}, ${env:}, ${localWorkspaceFolder}', () => {
  for (const value of ['${localEnv:HOME}', 'x ${env:GH_TOKEN} y', '${localWorkspaceFolder}/x',
    '${localWorkspaceFolderBasename}', '${ localEnv:X}', '${LOCALENV:X}', '${localEnv:X:default}']) {
    refused(withField('postStartCommand', value), /^the configuration\.postStartCommand names the host's/);
    refused(withField('postCreateCommand', ['sh', '-c', value]), /^the configuration\.postCreateCommand\[2\] names/);
    refused(withField('build', { dockerfile: value }), /^the configuration\.build\.dockerfile names/);
  }
  assert.equal(check(withField('postStartCommand', 'echo ${HOME} ${containerEnv:PATH}')).postStartCommand,
    'echo ${HOME} ${containerEnv:PATH}', 'the container\'s own variables are the container\'s');
});

test('features: by id from the list, the list\'s options and values, at a digest of the list the lockfile pins', () => {
  refused(withField('features', { 'ghcr.io/devcontainers/features/docker-in-docker:2': {} }),
    /^the feature "ghcr\.io\/devcontainers\/features\/docker-in-docker:2" is not one of the list's/);
  refused(withField('features', { 'ghcr.io/devcontainers/features/docker-outside-of-docker:2': {} }), /not one of/);
  refused(withField('features', { [FEATURE]: { moby: true } }), /^features\..*\.moby is not one of the list's values$/);
  refused(withField('features', { [FEATURE]: { version: 'latest' } }), /\.version is not an option of the list's$/);
  refused(withField('features', { [FEATURE]: 'x' }), /must be an object of options/);
  refused(withField('features', []), /^features must be an object$/);
  refused(CONFIG, /is not in the product's devcontainer-lock\.json/, { lock: null });
  refused(CONFIG, /is not in the product's devcontainer-lock\.json/, { lock: { features: {} } });
  const lockWith = (entry) => ({ features: { [FEATURE]: { ...LOCK.features[FEATURE], ...entry } } });
  refused(CONFIG, /is not resolved to/, { lock: lockWith({ resolved: `ghcr.io/evil/docker-outside-of-docker@${FEATURE_DIGEST}` }) });
  refused(CONFIG, /is not resolved to/, { lock: lockWith({ integrity: `sha256:${'0'.repeat(64)}` }) });
  refused(CONFIG, /is not resolved to/, { lock: lockWith({ resolved: FEATURE.replace(':1', ':latest') }) });
  const other = `sha256:${'1'.repeat(64)}`;
  refused(CONFIG, /at a digest the list does not hold/,
    { lock: lockWith({ resolved: FEATURE_REF.replace(FEATURE_DIGEST, other), integrity: other }) });
  assert.deepEqual(check(withField('features', { [FEATURE]: {} })).features[0].options, {});
});

test('the list itself is held to its shape', () => {
  assert.equal(checkList(TASK_CONFIG_LIST), TASK_CONFIG_LIST);
  for (const broken of [
    { ...TASK_CONFIG_LIST, mounts: [] },
    { ...TASK_CONFIG_LIST, capAdd: 'NET_ADMIN' },
    { ...TASK_CONFIG_LIST, features: { 'not an id': { options: {}, digests: {} } } },
    { ...TASK_CONFIG_LIST, features: { [FEATURE]: { options: {}, digests: { latest: { version: '1', metadata: {} } } } } },
    { ...TASK_CONFIG_LIST, features: { [FEATURE]: { options: { moby: [] }, digests: {} } } },
  ]) {
    assert.throws(() => checkList(broken), TaskConfigError);
  }
});

test('the override: what was carried, with absolute paths into the clone, the features by digest, and the '
  + 'dispatcher\'s mounts, workspace and users', () => {
  const work = `/home/factory/tasks/${RUN_ID}/w`;
  const override = buildOverride(check(CONFIG), { runId: RUN_ID });
  assert.deepEqual(override, {
    build: { dockerfile: `${work}/.devcontainer/Dockerfile`, context: `${work}/.devcontainer` },
    features: { [FEATURE_REF]: { moby: false } },
    postCreateCommand: ['echo', 'created'],
    postStartCommand: CONFIG.postStartCommand,
    remoteUser: 'dev',
    capAdd: ['NET_ADMIN', 'NET_RAW'],
    containerEnv: CONFIG.containerEnv,
    runArgs: ['--add-host=host.docker.internal:host-gateway',
      '--mount=type=bind,source=/opt/factory-checkout,target=/opt/factory,readonly',
      `--mount=type=volume,source=factory-task-${RUN_ID}-claude,target=/home/dev/.claude`,
      '--mount=type=volume,source=factory-dispatcher-m2,target=/home/dev/.m2'],
    workspaceMount: `type=bind,source=${work},target=/workspace`,
    workspaceFolder: '/workspace',
    updateRemoteUserUID: false,
    containerUser: 'root',
  });
  const id = `sha256:${'b'.repeat(64)}`;
  const resumed = buildOverride(check(CONFIG), { runId: RUN_ID, imageId: id });
  assert.equal(resumed.image, id);
  assert.equal(resumed.build, undefined);
  assert.equal(resumed.features, undefined, 'a resumed task runs the image it recorded, its features in it');
  assert.throws(() => buildOverride(check(CONFIG), { runId: RUN_ID, imageId: 'ubuntu:24.04' }), TypeError);
  assert.throws(() => buildOverride(check(CONFIG), { runId: '../x' }), TypeError);
});

const carried = check(CONFIG);
const own = { remoteUser: 'dev', postStartCommand: CONFIG.postStartCommand, capAdd: ['NET_ADMIN'],
  containerEnv: CONFIG.containerEnv, updateRemoteUserUID: false, containerUser: 'root' };
const feature = { id: FEATURE_REF, ...METADATA };
const label = (entries) => JSON.stringify(entries);
const refusedLabel = (entries, pattern) => assert.throws(() => checkImageMetadata(label(entries), { carried }),
  (error) => {
    assert.ok(error instanceof TaskConfigError, error.message);
    assert.match(error.message, pattern);
    return true;
  });

test('the image\'s devcontainer.metadata: the feature\'s entry as declared at its digest, and the configuration\'s',
  () => {
    assert.equal(checkImageMetadata(label([feature, own]), { carried }).length, 2);
    assert.equal(checkImageMetadata(label([{ ...feature, id: FEATURE }, own]), { carried }).length, 2,
      'the entry may name the feature by its list id');
    assert.equal(checkImageMetadata(label(own), { carried }).length, 1, 'one entry, not an array');
    assert.deepEqual(checkImageMetadata(undefined, { carried }), [], 'an image with no label');
  });

test('the review of #0-282: a feature\'s entry is taken only when it is, value by value, what the feature declares at '
  + 'the lockfile\'s digest; any other content under its id is refused', () => {
  const changed = [
    { ...feature, privileged: true },
    { ...feature, init: true },
    { ...feature, entrypoint: '/tmp/evil.sh' },
    { ...feature, securityOpt: ['label=disable', 'seccomp=unconfined'] },
    { ...feature, securityOpt: [] },
    { id: feature.id, entrypoint: feature.entrypoint, mounts: feature.mounts },
    { ...feature, mounts: [...feature.mounts, { source: '/', target: '/host', type: 'bind' }] },
    { ...feature, mounts: [{ ...feature.mounts[0], source: '/run/user/1001/docker.sock' }] },
    { ...feature, customizations: { vscode: { extensions: ['x'] } } },
    { ...feature, containerEnv: { DOCKER_HOST: 'tcp://evil:2375' } },
  ];
  for (const entry of changed) {
    refusedLabel([entry, own], /the feature .* is not what the feature declares at sha256:698f/);
  }
  refusedLabel([feature, feature, own], /is a second entry of the feature/);
  refusedLabel([{ ...feature, id: 'ghcr.io/devcontainers/features/docker-in-docker:2' }, own],
    /is a feature's, and no feature of the configuration's/);
  assert.throws(() => checkImageMetadata(label([feature]), { carried: { ...carried, features: [] } }),
    /no feature of the configuration's/);
});

test('an entry that is no feature\'s holds only the carried fields by their rules and the dispatcher\'s at its values',
  () => {
    for (const [entry, pattern] of [
      [{ mounts: ['type=bind,source=/,target=/host'] }, /\.mounts is not on the list/],
      [{ initializeCommand: 'curl evil' }, /\.initializeCommand is not on the list/],
      [{ entrypoint: '/x' }, /\.entrypoint is not on the list/],
      [{ privileged: true }, /\.privileged is not on the list/],
      [{ securityOpt: ['label=disable'] }, /\.securityOpt is not on the list/],
      [{ runArgs: ['--privileged'] }, /\.runArgs is not on the list/],
      [{ remoteUser: 'root' }, /\.remoteUser must be the agents' user/],
      [{ containerUser: 'dev' }, /\.containerUser is not the dispatcher's value/],
      [{ updateRemoteUserUID: true }, /\.updateRemoteUserUID is not the dispatcher's value/],
      [{ capAdd: ['SYS_ADMIN'] }, /\.capAdd\[0\] is not one of the list's/],
      [{ containerEnv: { GIT_AUTHOR_NAME: 'x' } }, /\.containerEnv\.GIT_AUTHOR_NAME is not a key/],
      [{ postStartCommand: 'echo ${localEnv:HOME}' }, /\.postStartCommand names the host's/],
      [{ postCreateCommand: { a: 'x' } }, /\.postCreateCommand must be a command/],
    ]) {
      refusedLabel([feature, entry, own], pattern);
    }
    refusedLabel(['x'], /is not an object/);
    assert.throws(() => checkImageMetadata('{not json', { carried }), /is not JSON/);
  });
