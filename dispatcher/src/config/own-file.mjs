/**
 * Reads the app's key only when it is the process's own (incident-platform backlog #0-271): a regular file, not a
 * symlink, owned by the process's user, and with none of the mode bits the caller forbids (for the key: any access
 * by group or others).
 *
 * `lstat` refuses a symlink by name; the file is then opened with O_NOFOLLOW and O_NONBLOCK and its handle checked
 * again (the same inode, the same owner and mode), so a file swapped between the two calls is refused, not read: a
 * symlink fails the open, and a FIFO, which a plain open would wait on for a writer for ever, opens at once and fails
 * the check.
 *
 * Since incident-platform backlog #0-273 it runs on the owner's host too: dispatcher/bin/dev-token.mjs reads the dev
 * app's key with it, next to that key. A change here is a change of code that runs on the host, not only in the
 * dispatcher.
 *
 * Since incident-platform backlog #0-276 it reads a bundle too (git/bundle.mjs, readBundleFile): as bytes
 * (`encoding: null`), and no larger than `maxBytes`, checked on the handle before the read.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/**
 * @param {string} path
 * @param {{ what: string, forbiddenMode: number, uid?: number, refuse: (message: string) => Error,
 *   afterLstat?: () => Promise<void>, encoding?: BufferEncoding | null, maxBytes?: number }} options `what` names
 *   the file in a refusal ("the key"); `uid` is the owner required, the process's by default (a test's other);
 *   `afterLstat` runs between the lstat and the open, where a swap would happen: for the tests only; `encoding`
 *   'utf8' by default, null for the bytes; `maxBytes` refuses a larger file without reading it.
 * @returns {Promise<string | Buffer>} the file's text, or its bytes
 */
export async function readOwnFile(path, {
  what, forbiddenMode, uid = process.getuid(), refuse, afterLstat, encoding = 'utf8', maxBytes,
}) {
  const check = (stats) => {
    if (!stats.isFile()) {
      throw refuse(`${what} ${path} is not a regular file (a symlink, a FIFO or a directory is refused)`);
    }
    if (stats.uid !== uid) {
      throw refuse(`${what} ${path} is owned by uid ${stats.uid}, not by this process's (${uid})`);
    }
    if ((stats.mode & forbiddenMode) !== 0) {
      throw refuse(`${what} ${path} has mode ${(stats.mode & 0o777).toString(8)}, which allows more than its owner `
        + `should: chmod ${(0o777 & ~forbiddenMode & ~0o111).toString(8)} it`);
    }
  };
  const linkStats = await lstat(path);
  check(linkStats);
  await afterLstat?.();
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw refuse(`${what} ${path} is not a regular file (a symlink is refused)`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (stats.ino !== linkStats.ino || stats.dev !== linkStats.dev) {
      throw refuse(`${what} ${path} changed while it was read`);
    }
    check(stats);
    if (maxBytes !== undefined && stats.size > maxBytes) {
      throw refuse(`${what} ${path} is ${stats.size} bytes, more than ${maxBytes}`);
    }
    return await handle.readFile(encoding === null ? {} : encoding);
  } finally {
    await handle.close();
  }
}
