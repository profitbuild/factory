// The closed list of a task configuration (incident-platform ADR-0062 point 4; backlog #0-277 AC9), on a generic
// fixture (testing/task-product.mjs): what the list carries is carried, and each field or value off it is refused on
// its own, naming the field and never the value; the override is the dispatcher's; the built image's
// devcontainer.metadata label is held to the same list, a feature's entry only when it is exactly what the feature
// declares at the digest the lockfile pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskConfigError, buildOverride, checkImageMetadata, checkList, checkTaskConfig, imageBuildConfig, TASK_CONFIG_LIST,
} from '../src/container/task-config.mjs';
import { LABEL_FIELDS, artifact, labelEntry } from '../testing/feature-artifact.mjs';
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

test('#0-284: the build\'s configuration is the build, the features by digest and the users, and nothing that runs',
  () => {
    const work = `/home/factory/tasks/${RUN_ID}/w`;
    assert.deepEqual(imageBuildConfig(check(CONFIG), { runId: RUN_ID }), {
      build: { dockerfile: `${work}/.devcontainer/Dockerfile`, context: `${work}/.devcontainer` },
      features: { [FEATURE_REF]: { moby: false } },
      remoteUser: 'dev',
      updateRemoteUserUID: false,
      containerUser: 'root',
    });
    assert.throws(() => imageBuildConfig(check(CONFIG), { runId: '../x' }), TypeError);
  });

test('#0-284 AC2: the override up reads: the image by its ID and never a build nor a feature, what was carried for '
  + 'the container, and the dispatcher\'s mounts, workspace and users', () => {
  const work = `/home/factory/tasks/${RUN_ID}/w`;
  const id = `sha256:${'b'.repeat(64)}`;
  const override = buildOverride(check(CONFIG), { runId: RUN_ID, imageId: id });
  assert.deepEqual(override, {
    image: id,
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
  assert.equal(override.build, undefined);
  assert.equal(override.features, undefined, 'with either the CLI would build an image over the one checked');
  assert.throws(() => buildOverride(check(CONFIG), { runId: RUN_ID }), TypeError, 'an ID always, a new task too');
  assert.throws(() => buildOverride(check(CONFIG), { runId: RUN_ID, imageId: 'ubuntu:24.04' }), TypeError);
  assert.throws(() => buildOverride(check(CONFIG), { runId: '../x', imageId: id }), TypeError);
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
    { ...feature, customizations: { ...feature.customizations, vscode: { ...feature.customizations.vscode,
      extensions: [...feature.customizations.vscode.extensions, 'evil.extension'] } } },
    (({ customizations, ...measured }) => measured)(feature),
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
      // #0-284: a key off the list by its position, never its name (the label is the daemon's answer).
      [{ mounts: ['type=bind,source=/,target=/host'] }, /\[1\] holds a key off the list, its key 0 \(not named\)$/],
      [{ initializeCommand: 'curl evil' }, /holds a key off the list, its key 0 \(not named\)$/],
      [{ entrypoint: '/x' }, /holds a key off the list, its key 0/],
      [{ privileged: true }, /holds a key off the list, its key 0/],
      [{ securityOpt: ['label=disable'] }, /holds a key off the list, its key 0/],
      [{ remoteUser: 'dev', runArgs: ['--privileged'] }, /holds a key off the list, its key 1 \(not named\)$/],
      [{ remoteUser: 'root' }, /\.remoteUser must be the agents' user/],
      [{ containerUser: 'dev' }, /\.containerUser is not the dispatcher's value/],
      [{ updateRemoteUserUID: true }, /\.updateRemoteUserUID is not the dispatcher's value/],
      [{ capAdd: ['SYS_ADMIN'] }, /\.capAdd\[0\] is not one of the list's/],
      [{ containerEnv: { GIT_AUTHOR_NAME: 'x' } }, /\.containerEnv\.<key 0> is not a key/],
      [{ postStartCommand: 'echo ${localEnv:HOME}' }, /\.postStartCommand names the host's/],
      [{ postCreateCommand: { a: 'x' } }, /\.postCreateCommand must be a command/],
    ]) {
      refusedLabel([feature, entry, own], pattern);
    }
    refusedLabel(['x'], /is not an object/);
    assert.throws(() => checkImageMetadata('{not json', { carried }), /is not JSON/);
  });

test('review round 1 arc-c7d1: the list holds, for the feature at its digest, what its artifact declares, whole; a '
  + 'label made from the artifact is taken, under the feature\'s digest reference or its id', () => {
  const declared = artifact(FEATURE_DIGEST);
  assert.equal(declared.version, TASK_CONFIG_LIST.features[FEATURE].digests[FEATURE_DIGEST].version);
  assert.deepEqual(METADATA, Object.fromEntries(LABEL_FIELDS.filter((f) => Object.hasOwn(declared, f))
    .map((f) => [f, declared[f]])), 'every field devcontainer up copies, and nothing else');
  assert.deepEqual(Object.keys(METADATA).sort(), ['customizations', 'entrypoint', 'mounts', 'securityOpt']);
  for (const id of [FEATURE_REF, FEATURE]) {
    assert.equal(checkImageMetadata(label([labelEntry(FEATURE_DIGEST, id), own]), { carried }).length, 2, id);
  }
});

test('#0-284 AC7: a feature\'s entry that differs names the list\'s keys whose values differ, and counts the keys off '
  + 'the list without naming them', () => {
  // Put together at run time from two parts, so that no file of the repository holds text shaped like a secret.
  const secret = 'ghs' + `_${'f'.repeat(36)}`;
  const message = (entry) => {
    try {
      checkImageMetadata(label([entry, own]), { carried });
    } catch (error) {
      assert.ok(error instanceof TaskConfigError);
      assert.ok(!error.message.includes('ghs_'), error.message);
      return error.message.replace(/^.* is not what the feature declares at sha256:[0-9a-f]{64}: /, '');
    }
    return assert.fail('refused');
  };
  assert.equal(message({ ...feature, entrypoint: secret }), 'the list\'s entrypoint differs; 0 keys off the list (not named)');
  assert.equal(message({ ...feature, entrypoint: '/x', securityOpt: [] }),
    'the list\'s securityOpt, entrypoint differ; 0 keys off the list (not named)');
  assert.equal(message({ ...feature, privileged: true, [secret]: 1 }),
    'no key of the list\'s differs; 2 keys off the list (not named)');
  assert.equal(message({ id: feature.id, entrypoint: feature.entrypoint, mounts: feature.mounts, init: true }),
    'the list\'s securityOpt, customizations differ; 1 key off the list (not named)');
});
