// FACTORY_REPO_DIR is the dispatcher's alone (incident-platform backlog #0-278 AC7): through alternates its objects
// feed every push (#0-276), so no one else may write a loose object's directory or a pack file of it. Held by the
// directory that shields it: the clone or its parent a directory of this process's user, not a symlink, with no bit
// for the group or others; then no file under it is anyone else's to write, a pack git writes later included. Shown on
// a real bare clone (the provisioning's: `git clone --bare` in the dispatcher's home, 700), its loose directories and
// packs left as git wrote them (755, 644), and on the owner of each directory given apart (lstatOf).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { RepoDirError, checkOwnRepoDir, mainObjects } from '../src/git/task-objects.mjs';
import { git, makeProduct } from '../testing/git-fixtures.mjs';
import { makeStateDir } from '../testing/state-dir.mjs';

const root = await makeStateDir();
after(root.remove);
let n = 0;

/** A home of 700 holding a bare clone, as provision.sh makes it; the clone's own mode git's (755). */
async function home() {
  n += 1;
  const dir = join(root.dir, `home-${n}`);
  await mkdir(dir, { mode: 0o700 });
  const product = await makeProduct(dir);
  const repo = join(dir, 'repo');
  git(dir, ['clone', '-q', '--bare', product.dir, repo]);
  git(repo, ['repack', '-q', '-a', '-d']);
  return { dir, repo };
}

const refused = (promise) => assert.rejects(promise, (error) => error instanceof RepoDirError
  && /^FACTORY_REPO_DIR is not the dispatcher's alone: neither it nor its parent directory is owned by this process's user with mode 700/.test(error.message));

/** lstat with `path`'s owner or mode given apart, which a test cannot chown. */
const changed = (path, fields) => async (p) => {
  const stats = await lstat(p);
  return p === path ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, fields(stats)) : stats;
};

test('AC7: a bare clone in a home of 700 is the dispatcher\'s alone, its loose directories and packs as git wrote them',
  async () => {
    const { repo } = await home();
    const packs = await readdir(join(repo, 'objects', 'pack'));
    assert.ok(packs.some((f) => f.endsWith('.pack')), 'a pack is there');
    assert.equal(((await lstat(repo)).mode & 0o777).toString(8), '755', 'the clone itself is git\'s 755');
    await checkOwnRepoDir(repo);
    assert.equal(await mainObjects(repo), join(repo, 'objects'));
  });

test('AC7: a parent open to the group or others, or another user\'s, is refused unless the clone shields itself',
  async () => {
    const { dir, repo } = await home();
    for (const mode of [0o750, 0o705, 0o770, 0o755]) {
      await chmod(dir, mode);
      await refused(checkOwnRepoDir(repo));
    }
    await chmod(dir, 0o755);
    await chmod(repo, 0o700);
    await checkOwnRepoDir(repo);
    await chmod(repo, 0o755);
    await chmod(dir, 0o700);
    await refused(checkOwnRepoDir(repo, { lstatOf: changed(dir, (s) => ({ uid: s.uid + 1 })) }));
    await refused(checkOwnRepoDir(repo, { uid: process.getuid() + 1 }));
  });

test('AC7: a clone that is a symlink is refused, whatever its target; one missing too', async () => {
  const { dir, repo } = await home();
  const link = join(dir, 'link');
  await symlink(repo, link);
  for (const path of [link, join(dir, 'none')]) {
    await assert.rejects(checkOwnRepoDir(path), (error) => error instanceof RepoDirError
      && error.message === 'FACTORY_REPO_DIR is not a directory (a symlink is refused)');
  }
});

test('AC7: the push\'s check of the objects ends with it: a home open to others refuses mainObjects too', async () => {
  const { dir, repo } = await home();
  await chmod(dir, 0o755);
  await refused(mainObjects(repo));
});
