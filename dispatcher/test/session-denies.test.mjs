// The session's denies in this repository (incident-platform backlog #0-269, AC5): .claude/settings.json keeps every
// one of the list below, so a pull request that removes one fails here, in job Test, where the reviewer sees which.
// The list is incident-platform's .claude/settings.json's denies that apply here; keeping the two lists in step is
// incident-platform #0-268's. Adding a deny means adding it to both the settings and this list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settings = JSON.parse(await readFile(new URL('../../.claude/settings.json', import.meta.url), 'utf8'));

const REQUIRED_DENIES = [
  "Bash(git push --force *)",
  "Bash(git push -f *)",
  "Bash(git push --force-with-lease *)",
  "Bash(git push origin main *)",
  "Bash(git push origin HEAD:main *)",
  "Bash(git push --ta*)",
  "Bash(git push * --ta*)",
  "Bash(git push --fol*)",
  "Bash(git push * --fol*)",
  "Bash(git push --m*)",
  "Bash(git push * --m*)",
  "Bash(git push *refs/tags/*)",
  "Bash(git push * tag *)",
  "Bash(gh release create *)",
  "Bash(gh release new *)",
  "Bash(gh release edit *)",
  "Bash(gh release delete *)",
  "Bash(gh release delete-asset *)",
  "Bash(gh release upload *)",
  "Bash(gh api *releases*)",
  "Bash(gh api *git/refs*)",
  "Bash(gh api *git/tags*)",
  "Bash(gh api *createRef*)",
  "Bash(gh api *updateRef*)",
  "Bash(gh api *deleteRef*)",
  "Bash(gh pr merge *--admin*)",
  "Bash(gh api *pulls/*/merge*)",
  "Bash(gh api *mergePullRequest*)",
  "Bash(gh api *rulesets*)",
  "Bash(gh api *Ruleset*)",
  "Bash(gh api *PATCH*)",
  "Bash(gh api *patch*)",
  "Bash(gh repo edit *)",
  "Bash(gh pr review *)",
  "Bash(gh api *pulls/*/reviews*)",
  "Bash(gh api *PullRequestReview*)",
  "Bash(gh api *collaborators*)",
  "Bash(gh api *environments*)",
  "Bash(gh api *Environment*)",
  "Bash(gh api *secrets*)",
  "Bash(gh secret *)",
];

test('.claude/settings.json denies every command of the list', () => {
  const deny = settings.permissions?.deny ?? [];
  const missing = REQUIRED_DENIES.filter((rule) => !deny.includes(rule));
  assert.deepEqual(missing, [], 'denies missing from .claude/settings.json');
});

test('no allow or ask rule, and no mode that skips the prompts, sits next to the denies', () => {
  assert.equal(settings.permissions?.allow, undefined);
  assert.equal(settings.permissions?.ask, undefined);
  assert.notEqual(settings.permissions?.defaultMode, 'bypassPermissions');
});
