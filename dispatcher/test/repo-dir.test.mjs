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

import { RepoDirError, checkOwnRepoDir, checkRepoDir, mainObjects } from '../src/git/task-objects.mjs';
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
    for (const mode of [0o750, 0o705, 0o755]) {
      await chmod(dir, mode);
      await refused(checkOwnRepoDir(repo));
    }
    // A parent its group may write is refused by the rule of the way to the clone already (review round 1, g).
    await chmod(dir, 0o770);
    await assert.rejects(checkOwnRepoDir(repo), /a directory on the way to FACTORY_REPO_DIR, .*, has mode 770/);
    await chmod(dir, 0o755);
    await chmod(repo, 0o700);
    await checkOwnRepoDir(repo);
    await chmod(repo, 0o755);
    await chmod(dir, 0o700);
    // Another user's parent, or a clone not this process's, is refused by the rule of the way (review round 1, g).
    const notOwn = /is owned by uid \d+: only this process's user or root may own one$/;
    await assert.rejects(checkOwnRepoDir(repo, { lstatOf: changed(dir, (s) => ({ uid: s.uid + 1 })) }), notOwn);
    await assert.rejects(checkOwnRepoDir(repo, { uid: process.getuid() + 1 }), notOwn);
    // Root's parent of 755 passes the way, and does not shield: the clone's 755 is refused by the shield.
    await refused(checkOwnRepoDir(repo, { lstatOf: changed(dir, () => ({ uid: 0, mode: 0o40755 })) }));
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

test('review round 1 g: every directory on the way to /, as sshd\'s StrictModes: one writable by others or its group is '
  + 'refused, another user\'s is refused, root\'s 755 passes, a symlink on the way is refused', async () => {
  const { dir, repo } = await home();
  const outer = join(dir, 'outer');
  await mkdir(join(outer, 'inner'), { recursive: true, mode: 0o700 });
  const nested = join(outer, 'inner', 'repo');
  git(dir, ['clone', '-q', '--bare', repo, nested]);
  await chmod(outer, 0o755);
  await checkOwnRepoDir(nested);
  for (const mode of [0o757, 0o775, 0o777, 0o1777]) {
    await chmod(outer, mode);
    await assert.rejects(checkOwnRepoDir(nested), (error) => error instanceof RepoDirError
      && error.message === `a directory on the way to FACTORY_REPO_DIR, ${outer}, has mode ${mode.toString(8)}: the `
        + 'group and others may not write one', mode.toString(8));
  }
  await chmod(outer, 0o755);
  await assert.rejects(checkOwnRepoDir(nested, { lstatOf: changed(outer, (s) => ({ uid: s.uid + 1 })) }),
    (error) => error instanceof RepoDirError && /, outer, |outer, is owned by uid \d+: only this process's user or root/
      .test(error.message));
  await checkOwnRepoDir(nested, { lstatOf: changed(outer, () => ({ uid: 0 })) });
  await checkOwnRepoDir(nested, { lstatOf: changed('/', () => ({ uid: 0, mode: 0o40755 })) });
  await assert.rejects(checkOwnRepoDir(nested, { lstatOf: changed('/', () => ({ mode: 0o40777 })) }),
    /a directory on the way to FACTORY_REPO_DIR, \/, has mode 777/);
  const link = join(dir, 'via');
  await symlink(join(outer, 'inner'), link);
  await assert.rejects(checkOwnRepoDir(join(link, 'repo')), (error) => error instanceof RepoDirError
    && error.message === `a directory on the way to FACTORY_REPO_DIR, ${link}, is not a directory (a symlink is refused)`);
  await assert.rejects(checkOwnRepoDir('relative/repo'), TypeError);
});

test('review round 2, 2: a path not normalized is refused naming the setting, never the value; a normalized one passes',
  async () => {
    const { dir, repo } = await home();
    const link = join(dir, 'link-to-clone');
    await symlink(repo, link);
    const cases = { 'a trailing / at a symlink to the clone': `${link}/`, 'a trailing /': `${repo}/`,
      'a .. inside': join(dir, 'x').replace(/x$/, `x/../${repo.split('/').at(-1)}`), 'a . inside': `${dir}/./repo`,
      'a //': `${dir}//repo` };
    for (const [what, path] of Object.entries(cases)) {
      for (const check of [checkOwnRepoDir, checkRepoDir]) {
        await assert.rejects(check(path), (error) => error instanceof RepoDirError
          && error.message === 'FACTORY_REPO_DIR is not a normalized path: no . or .. segment, no // and no trailing / '
            + '(a trailing / would follow a symlink at its end)' && !error.message.includes(dir), `${check.name}: ${what}`);
      }
    }
    await checkOwnRepoDir(repo);
    await checkRepoDir(repo);
  });
