// The item's lock before a task starts (incident-platform backlog #0-278 AC9, AC11; ADR-0060 D8 as amended): an open
// pull request whose head branch contains /<id>- holds the item, read with builder-app's token from a fake GitHub,
// every page, each through the retry helper; a list not read whole refuses the start; one of the dispatcher's own
// tasks holds it only while it runs with a branch (a killed run's task with none does not: #0-277 AC13). The rule of
// a branch is tested against testing/fixtures/item-lock-branches.tsv, a copy of the cases incident-platform's
// next-item.sh tests read (the product's file leads, ADR-0061).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { createBuilderTokenSource } from '../src/github/builder-token.mjs';
import {
  ItemLockError, MAX_PULL_PAGES, PULLS_PER_PAGE, branchHoldsItem, openPullHeads, refuseHeldByPull, refuseHeldByTask,
} from '../src/github/item-lock.mjs';
import { makeRoot, startBuilderGitHub, writeAppFiles } from '../testing/builder-github.mjs';

const fake = await startBuilderGitHub();
const root = await makeRoot('item-lock-test');
after(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

const REPOSITORY = 'profitbuild/incident-platform';
const noWait = { sleep: async () => {}, random: () => 0 };

async function heads({ repository = REPOSITORY, tokens } = {}) {
  const { env } = await writeAppFiles(root, fake.privateKey);
  const source = tokens ?? createBuilderTokenSource({ env, repository, baseUrl: fake.baseUrl });
  try {
    return await openPullHeads({ repository, tokens: source, apiBase: fake.baseUrl, retry: noWait });
  } finally {
    await source.revoke?.();
  }
}

let mark = 0;
beforeEach(() => { mark = fake.requests.length; });
/** The requests for the pull requests since the test began. */
const pullRequests = () => fake.requests.slice(mark).filter((r) => r.path.endsWith('/pulls'));

test('AC11: the rule of a head branch holds every case of the fixture both sides read', () => {
  const text = readFileSync(new URL('../testing/fixtures/item-lock-branches.tsv', import.meta.url), 'utf8');
  const cases = text.split('\n').filter((line) => line !== '' && !line.startsWith('#')).map((line) => line.split('\t'));
  assert.ok(cases.length >= 10);
  for (const fields of cases) {
    assert.equal(fields.length, 3, `three fields, tab-separated: ${fields.join('|')}`);
    const [item, branch, expected] = fields;
    assert.ok(['held', 'free'].includes(expected));
    assert.equal(branchHoldsItem(branch, item), expected === 'held', `${item} ${branch}`);
  }
  assert.ok(cases.some(([, branch, e]) => branch === 'refactor/0-3-left-over' && e === 'held'));
  assert.ok(cases.some(([item, branch, e]) => item === '0-278' && branch === 'feat/0-2780-x' && e === 'free'));
  assert.throws(() => branchHoldsItem('feat/0-3-x', '3'), TypeError);
});

test('review round 1 a: the fixture is the product\'s copy: its notice, ended by a line of # alone, then the original',
  () => {
    const lines = readFileSync(new URL('../testing/fixtures/item-lock-branches.tsv', import.meta.url), 'utf8')
      .split('\n');
    assert.equal(lines[0], '# A copy of profitbuild/incident-platform\'s .github/scripts/fixtures/item-lock-branches.tsv, '
      + 'which leads (ADR-0061); held equal to it, this notice aside, by incident-platform\'s check-factory-copies.rb.');
    const end = lines.indexOf('#');
    assert.ok(end > 0 && lines.slice(0, end).every((line) => line.startsWith('# ')), 'the notice: # lines, then #');
    const original = lines.slice(end + 1);
    assert.equal(original.indexOf('#'), -1, 'the original holds no line of # alone, so the notice ends at the first');
    assert.ok(!original.join('\n').includes('#0-268'), 'no claim of the copy check: incident-platform adds it');
    assert.ok(original.some((line) => line === '0-3\trefactor/0-3-left-over\theld'));
  });

test('AC9: every page is read, with builder-app\'s token: an item held on the second page is refused', async () => {
  fake.state.pulls = [...Array.from({ length: PULLS_PER_PAGE }, (_, i) => `feat/0-${1000 + i}-other`),
    'factory/fix/0-278-held'];
  const found = await heads();
  assert.equal(found.length, PULLS_PER_PAGE + 1);
  const asked = pullRequests();
  assert.deepEqual(asked.map((r) => r.query.get('page')), ['1', '2']);
  assert.ok(asked.every((r) => r.query.get('state') === 'open' && r.query.get('per_page') === '100'
    && r.query.get('direction') === 'asc' && /^Bearer ghs_/.test(r.headers.authorization)));
  assert.throws(() => refuseHeldByPull({ item: '0-278', heads: found }), (error) => error instanceof ItemLockError
    && error.message === 'the item 0-278 is held by 1 open pull request (a head branch containing /0-278-): the run is '
      + 'refused' && !error.message.includes('factory/fix'));
  assert.doesNotThrow(() => refuseHeldByPull({ item: '0-27', heads: found }));
});

test('AC9: a full last page asks for one page more, and an empty one ends the list', async () => {
  fake.state.pulls = Array.from({ length: PULLS_PER_PAGE }, (_, i) => `feat/0-${i}-x`);
  assert.equal((await heads()).length, PULLS_PER_PAGE);
  assert.deepEqual(pullRequests().map((r) => r.query.get('page')), ['1', '2']);
  fake.reset();
  assert.deepEqual(await heads(), []);
});

test('AC9: a transient failure is retried; a page refused, not a list, or past the last page refuses the start',
  async () => {
    fake.state.pulls = ['feat/0-1-x'];
    let failed = 0;
    fake.state.pullsPage = () => (failed++ < 2 ? { status: 502, body: { message: 'Bad Gateway' } } : undefined);
    assert.deepEqual(await heads(), ['feat/0-1-x']);
    const answers = {
      'a 404': { status: 404, body: { message: 'the remote text' } },
      'not a list': { status: 200, body: { message: 'the remote text' } },
      'an entry with no head branch': { status: 200, body: [{ number: 1, head: {} }] },
      'more than a page': { status: 200, body: Array.from({ length: PULLS_PER_PAGE + 1 }, () => ({ head: { ref: 'x' } })) },
    };
    for (const [what, answer] of Object.entries(answers)) {
      fake.reset();
      fake.state.pulls = Array.from({ length: PULLS_PER_PAGE + 1 }, () => 'feat/x');
      fake.state.pullsPage = (page) => (page === 2 ? answer : undefined);
      await assert.rejects(heads(), (error) => {
        assert.ok(error instanceof ItemLockError, what);
        assert.match(error.message, /^the open pull requests could not be read whole \(page 2[:) ]/, what);
        assert.match(error.message, /: the run is refused, its item's lock unknown$/);
        assert.ok(!error.message.includes('the remote text'), 'no text of GitHub\'s');
        return true;
      });
    }
    fake.reset();
    fake.state.pullsPage = () => ({ status: 503, body: { message: 'down' } });
    await assert.rejects(heads(), /\(page 1: GitHub failed ten times in a row, each time transiently\)/);
    fake.reset();
    fake.state.pulls = Array.from({ length: PULLS_PER_PAGE * MAX_PULL_PAGES }, () => 'feat/x');
    await assert.rejects(heads(), /are more than 30 pages of 100: the run is refused/);
  });

test('AC9: a token source of another repository is refused before any call', async () => {
  const start = fake.requests.length;
  await assert.rejects(heads({ tokens: { repository: 'profitbuild/other-product', getToken: async () => 'x' } }),
    /the token source is for profitbuild\/other-product, not profitbuild\/incident-platform/);
  assert.equal(fake.requests.length, start);
});

const task = (fields) => ({ runId: '20261121T101500Z-3f9a1c', item: '0-278', status: 'running', branch: null,
  ...fields });

test('AC9, #0-303: the dispatcher\'s own task holds the item while it runs, with a branch or none yet, and says how to '
  + 'take it up', () => {
    assert.doesNotThrow(() => refuseHeldByTask({ item: '0-278', tasks: [task({})] }),
      'a killed run\'s task with no branch does not hold it (#0-277 AC13)');
    // #0-303 (review round 1 of factory#25, gen-3c1d): a live task with no branch holds its item too, by its runId.
    assert.throws(() => refuseHeldByTask({ item: '0-278', tasks: [task({})], live: new Set(['20261121T101500Z-3f9a1c']) }),
      (error) => error instanceof ItemLockError && error.message === 'the item 0-278 is held by the dispatcher\'s own '
        + 'task 20261121T101500Z-3f9a1c, live and still running with no branch yet: the run is refused until that '
        + 'task\'s run ends');
    assert.doesNotThrow(() => refuseHeldByTask({ item: '0-278', tasks: [task({})], live: new Set(['20261121T101500Z-000000']) }),
      'another task live');
    assert.throws(() => refuseHeldByTask({ item: '0-278', tasks: [task({ branch: 'feat/0-278-x' })] }),
      (error) => error instanceof ItemLockError && error.message === 'the item 0-278 is held by the dispatcher\'s own '
        + 'task 20261121T101500Z-3f9a1c, still running on feat/0-278-x: take it up with `run --resume feat/0-278-x`');
    for (const fields of [{ status: 'blocked' }, { status: 'shipped' }, { status: 'stopped' }, { item: '0-27' },
      { item: null }]) {
      for (const branch of ['feat/0-278-x', null]) {
        assert.doesNotThrow(() => refuseHeldByTask({ item: '0-278', tasks: [task({ branch, ...fields })],
          live: new Set(['20261121T101500Z-3f9a1c']) }), JSON.stringify({ branch, ...fields }));
      }
    }
  });
