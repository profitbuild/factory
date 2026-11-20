// The base's bundle, made in FACTORY_REPO_DIR (incident-platform ADR-0062 point 2; backlog #0-277 AC7): main's commit
// is v0's base; the bundle is exactly refs/heads/base at the base, with no prerequisite, or it is refused, whatever
// the git that made it wrote.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BASE_REF, BaseBundleError, mainCommit, makeBaseBundle } from '../src/git/base-bundle.mjs';
import { REAL_GIT, git } from '../testing/git-fixtures.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';
import { makeTaskProduct } from '../testing/task-product.mjs';

const root = await makeStateDir();
after(root.remove);
const product = await makeTaskProduct(root.dir);

test('main\'s commit is the base; the bundle is refs/heads/base at it, the whole history, no prerequisite', async () => {
  assert.equal(await mainCommit(product.repoDir, { git: REAL_GIT }), product.base);
  const bundle = await makeBaseBundle({ repoDir: product.repoDir, baseSha: product.base, git: REAL_GIT });
  assert.equal(bundle.subarray(0, bundle.indexOf('\n\n')).toString(), `# v2 git bundle\n${product.base} ${BASE_REF}`);
  assert.equal(git(product.repoDir, ['rev-parse', BASE_REF]), product.base, 'the ref points at the base');
  await assert.rejects(makeBaseBundle({ repoDir: product.repoDir, baseSha: 'main' }), TypeError);
  const empty = join(root.dir, 'empty.git');
  git(root.dir, ['init', '-q', '--bare', empty]);
  await assert.rejects(mainCommit(empty, { git: REAL_GIT }), BaseBundleError);
});

test('a bundle that is not exactly the base\'s, whatever git wrote, is refused', async () => {
  for (const [name, header] of [
    ['prerequisite', `# v2 git bundle\n-${'1'.repeat(40)} x\n${product.base} ${BASE_REF}`],
    ['other-ref', `# v2 git bundle\n${product.base} refs/heads/main`],
    ['other-commit', `# v2 git bundle\n${'2'.repeat(40)} ${BASE_REF}`],
    ['two-refs', `# v2 git bundle\n${product.base} ${BASE_REF}\n${product.base} refs/heads/x`],
    ['v3', `# v3 git bundle\n@object-format=sha1\n${product.base} ${BASE_REF}`],
  ]) {
    const fake = join(root.dir, `git-${name}`);
    const output = join(root.dir, `bundle-${name}`);
    await writeFile(output, `${header}\n\nPACK`);
    await writeFile(fake, `#!/bin/sh\ncase "$*" in *bundle*) cat '${output}' ;; esac\nexit 0\n`);
    await chmod(fake, 0o755);
    await assert.rejects(makeBaseBundle({ repoDir: product.repoDir, baseSha: product.base, git: fake }), (error) => {
      assert.ok(error instanceof BaseBundleError, `${name}: ${error.message}`);
      assert.match(error.message, /is not exactly refs\/heads\/base at the base, with no prerequisite/);
      return true;
    });
  }
});
