/**
 * The item's lock, before a task starts (incident-platform ADR-0060 D8 as amended, backlog #0-278 AC9, AC11): in v0
 * the owner names the item (`run --item 0-N`, taken with the product's next-item.sh in their own session), and the
 * dispatcher runs no queue command. It refuses the item when
 *  - one of its own tasks holds it: a task of that item still running with a branch, the one kind `run --resume
 *    <branch>` takes up. A running task with no branch does not hold it: a run killed before its branch was made
 *    leaves one running for ever, and the next run must start (#0-277 AC13);
 *  - an open pull request holds it: its head branch contains `/<id>-` (factory/feat/0-278-x, feat/0-278-x; not
 *    feat/0-2780-x), the lock next-item.sh reads, so that the owner's path and the dispatcher's lock each other.
 *    The rule's cases are testing/fixtures/item-lock-branches.tsv, which next-item.sh's tests read too.
 * The open pull requests are listed with builder-app's token, every page, each through the retry helper (#0-261):
 * `GET /repos/{owner}/{repo}/pulls?state=open&sort=created&direction=asc&per_page=100&page=N` until a page shorter than
 * 100; a page that cannot be read, or is not a list of pull requests with a head branch, or more than MAX_PULL_PAGES
 * pages, refuses the start: a list not read whole is never used. A pull request closed while the pages are read can
 * move another across a page's edge, so that it is missed: what that costs is a task done twice, never a write
 * elsewhere, and next-item.sh's own read has the same race.
 * A refusal names the item (the owner's) and the dispatcher's own task, never a value read from GitHub.
 */
import { GITHUB_API } from './app-token.mjs';
import { parseRepository } from './builder-token.mjs';
import { GitHubUnavailableError, githubCall } from './retry.mjs';

/** The item is held, or whether it is could not be read. */
export class ItemLockError extends Error {}

/** A page of the list, and the most pages read (3000 open pull requests). */
export const PULLS_PER_PAGE = 100;
export const MAX_PULL_PAGES = 30;

const ITEM = /^[0-9]+-[0-9]+$/;

/** Whether the head branch `branch` holds the item `item` (0-N): it contains `/<id>-`. */
export function branchHoldsItem(branch, item) {
  if (!ITEM.test(item ?? '')) {
    throw new TypeError('branchHoldsItem: item must be a backlog item, 0-N');
  }
  return branch.includes(`/${item}-`);
}

/**
 * The head branches of the product's open pull requests, every page.
 *
 * @param {{ repository: string, tokens: { repository: string, getToken: () => Promise<string> }, apiBase?: string,
 *   fetchImpl?: typeof fetch, retry?: object }} options `apiBase` (GITHUB_API but in tests), `fetchImpl` and `retry`
 *   (withRetries' clock and randomness) for the tests only
 * @returns {Promise<string[]>}
 */
export async function openPullHeads({ repository, tokens, apiBase = GITHUB_API, fetchImpl, retry }) {
  const { owner, repo } = parseRepository(repository);
  if (tokens?.repository !== repository) {
    throw new ItemLockError(`the token source is for ${tokens?.repository ?? 'no repository'}, not ${repository}`);
  }
  const heads = [];
  for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
    let answer;
    try {
      const query = `state=open&sort=created&direction=asc&per_page=${PULLS_PER_PAGE}&page=${page}`;
      answer = await githubCall({ baseUrl: apiBase, method: 'GET', bearer: await tokens.getToken(), fetchImpl,
        path: `/repos/${owner}/${repo}/pulls?${query}` }, retry);
    } catch (error) {
      const why = error instanceof GitHubUnavailableError ? 'GitHub failed ten times in a row, each time transiently'
        : 'the call was refused';
      throw new ItemLockError(`the open pull requests could not be read whole (page ${page}: ${why}): the run is `
        + 'refused, its item\'s lock unknown', { cause: error });
    }
    if (!Array.isArray(answer) || answer.length > PULLS_PER_PAGE
      || answer.some((pull) => typeof pull?.head?.ref !== 'string')) {
      throw new ItemLockError(`the open pull requests could not be read whole (page ${page} is not a list of pull `
        + 'requests with a head branch): the run is refused, its item\'s lock unknown');
    }
    heads.push(...answer.map((pull) => pull.head.ref));
    if (answer.length < PULLS_PER_PAGE) {
      return heads;
    }
  }
  throw new ItemLockError(`the open pull requests are more than ${MAX_PULL_PAGES} pages of ${PULLS_PER_PAGE}: the `
    + 'run is refused, its item\'s lock unknown');
}

/**
 * Refuses the item when one of the dispatcher's own tasks holds it; no call to GitHub.
 *
 * @param {{ item: string, tasks: object[] }} options `tasks` listTasks'
 */
export function refuseHeldByTask({ item, tasks }) {
  const holder = tasks.find((task) => task.item === item && task.status === 'running' && task.branch !== null);
  if (holder) {
    throw new ItemLockError(`the item ${item} is held by the dispatcher's own task ${holder.runId}, still running on `
      + `${holder.branch}: take it up with \`run --resume ${holder.branch}\``);
  }
}

/**
 * Refuses the item when an open pull request's head branch holds it.
 *
 * @param {{ item: string, heads: string[] }} options `heads` openPullHeads'
 */
export function refuseHeldByPull({ item, heads }) {
  const count = heads.filter((branch) => branchHoldsItem(branch, item)).length;
  if (count > 0) {
    throw new ItemLockError(`the item ${item} is held by ${count} open pull request${count === 1 ? '' : 's'} (a head `
      + `branch containing /${item}-): the run is refused`);
  }
}
