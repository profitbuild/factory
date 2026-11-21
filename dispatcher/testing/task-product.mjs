// Not a test file. A product with a task configuration, for the task container's tests (incident-platform backlog
// #0-277 AC9): a generic one, named after no product. Its main holds `.devcontainer/task.json` (JSONC: comments and
// trailing commas), the lockfile devcontainer reads beside it, and a Dockerfile; made by the test's git, as
// FACTORY_REPO_DIR would hold it, a bare clone.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git } from './git-fixtures.mjs';

export const FEATURE = 'ghcr.io/devcontainers/features/docker-outside-of-docker:1';
export const FEATURE_DIGEST = 'sha256:698f5900fac471e046c6e9d4333fec88c0e8d952c713494fa0712dce80baeca0';
export const FEATURE_REF = `ghcr.io/devcontainers/features/docker-outside-of-docker@${FEATURE_DIGEST}`;
export const CONFIG_PATH = '.devcontainer/task.json';

/** The task configuration's text: every field the list carries, with comments and trailing commas. */
export const CONFIG_TEXT = `// A product's task configuration: what the task container is made of (a generic fixture).
{
  /* the build, from the configuration's directory */
  "build": { "dockerfile": "Dockerfile", "context": "." },
  "remoteUser": "dev", // the agents' user
  "postCreateCommand": ["echo", "created"],
  "postStartCommand": "sudo /usr/local/bin/init-firewall.sh \${FIREWALL_EXTRA:+x}",
  "capAdd": ["NET_ADMIN", "NET_RAW"],
  "runArgs": ["--add-host=host.docker.internal:host-gateway"],
  "containerEnv": {
    "TESTCONTAINERS_HOST_OVERRIDE": "host.docker.internal",
    "TESTCONTAINERS_RYUK_DISABLED": "false",
  },
  "features": {
    "${FEATURE}": { "moby": false },
  },
}
`;

/** The lockfile beside it, at the digest the list holds. */
export const LOCK = { features: { [FEATURE]: { version: '1.10.1',
  resolved: FEATURE_REF, integrity: FEATURE_DIGEST } } };

/** The configuration as an object, for the tests that change one field of it. */
export const CONFIG = {
  build: { dockerfile: 'Dockerfile', context: '.' },
  remoteUser: 'dev',
  postCreateCommand: ['echo', 'created'],
  postStartCommand: 'sudo /usr/local/bin/init-firewall.sh ${FIREWALL_EXTRA:+x}',
  capAdd: ['NET_ADMIN', 'NET_RAW'],
  runArgs: ['--add-host=host.docker.internal:host-gateway'],
  containerEnv: { TESTCONTAINERS_HOST_OVERRIDE: 'host.docker.internal', TESTCONTAINERS_RYUK_DISABLED: 'false' },
  features: { [FEATURE]: { moby: false } },
};

/**
 * A product's clone (a work tree, for the test's git) and a bare clone of it, FACTORY_REPO_DIR, whose main holds
 * `files` (path -> text, null for none), by default the configuration, its lockfile and a Dockerfile; `executable`
 * the paths written with mode 755 (a script the adapter names), `links` symlinks (path -> target).
 *
 * @returns {Promise<{ work: string, repoDir: string, base: string }>}
 */
export async function makeTaskProduct(root, { files = {}, links = {}, executable = [] } = {}) {
  const work = join(root, 'product');
  await mkdir(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  const all = {
    [CONFIG_PATH]: CONFIG_TEXT,
    '.devcontainer/devcontainer-lock.json': `${JSON.stringify(LOCK, null, 2)}\n`,
    '.devcontainer/Dockerfile': 'FROM scratch\n',
    'README.md': 'a product\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) {
      continue;
    }
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), text);
    if (executable.includes(path)) {
      await chmod(join(work, path), 0o755);
    }
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(join(work, path, '..'), { recursive: true });
    git(work, ['update-index', '--add', '--cacheinfo',
      `120000,${git(work, ['hash-object', '-w', '--stdin'], { input: target })},${path}`]);
  }
  git(work, ['add', '-A', '--', ...Object.keys(all).filter((p) => all[p] !== null)]);
  git(work, ['commit', '-q', '-m', 'the product']);
  const base = git(work, ['rev-parse', 'HEAD']);
  const repoDir = join(root, 'repo.git');
  git(root, ['clone', '-q', '--bare', work, repoDir]);
  return { work, repoDir, base };
}
