# Contributing

How a change to this repository is made: until the end of incident-platform's
[ADR-0055](https://github.com/profitbuild/incident-platform/blob/main/.ai/decisions/0055-the-factory-moves-to-three-zones.md)
migration and after it (backlog #0-270). The first part stays after the migration; each point of the second part
names the stage that ends it.

## Part 1: Permanent

### Who writes what

| What | Who, and where |
|---|---|
| Code | A session in `.devcontainer/`, holding the hour token of the app `profitbuild-factory-dev` (see the README's "Development") |
| Everything under `.github/workflows/` | The owner, in their own session on the host's clone: the app has no Workflows permission, and GitHub refuses its push |
| Plans, ADRs and the backlog | [incident-platform](https://github.com/profitbuild/incident-platform), not here |

No one but the app and the owner has access to this repository.

### The steps of a pull request from the app

A change is reviewed on a draft pull request:

1. **Change.** The session changes the code in the container and runs the tests (`cd dispatcher && node --test`).
2. **Commit and draft.** The session that made the change commits it with a full message, pushes the branch, and
   opens a draft with `gh pr create --draft`, its description in the format of `/ship` (the conventions: part 2).
3. **Review.** The change is reviewed on the draft (who reviews it today: "Review" in part 2). Fixes are further
   commits on the branch, with no amend and no force push.
4. **Ready.** Once a review round finds nothing, the session marks the pull request ready: `gh pr ready`.
5. **Approval and merge.** The owner approves as the code owner (`gh pr review --approve`) and merges with a plain
   merge, without `--admin`, once the required checks (`Test`, `Lint Workflows`, `Secret Scan`) are green. The
   ruleset of `main` requires the approval of the last push, so a push after the approval needs a new one. The
   admin's bypass is only for the owner's own pull requests, which have no one else to approve them.

Neither an amend nor a force push is needed; should one be, the owner runs it, typing the command with `!` in the
container's session, since the session's denies (`.claude/settings.json`) block a force push for the session itself.

### Tags

Only an admin creates a tag (today the owner alone). A tag can be neither moved nor deleted, since products load the
factory at one.

## Part 2: Transitional

### Review

**Until stage 5**; #0-270 may change the way before then (for example, `/review` fetching the factory's pull request
itself). Today the review is incident-platform's panel's, run on files: the draft's `gh pr diff` and the result of
its CI, saved in `.ai/runs/manual/<directory>/`, a new directory for each round, with the gate as `gate-r<n>.json`
(the verifier refuses any other name); then `/review <digits>`, whose digits pick the reviewers (1 general,
2 security, 3 performance, 4 migration, 5 k8s, 6 docs, 7 architecture).

### Conventions of commit messages and pull request descriptions

**Until stage 5**, when the rules move here. Their source is incident-platform: its
[`CLAUDE.md`](https://github.com/profitbuild/incident-platform/blob/main/CLAUDE.md) ("Conventions") and its skill
[`/ship`](https://github.com/profitbuild/incident-platform/blob/main/.claude/skills/ship/SKILL.md); read them
there, since this file does not copy them. In one sentence: Conventional Commits with a scope, a body that says what
and why, and the number from incident-platform's backlog, and a description with `## Summary`, the tests, and
`## Notes for reviewers`.

### Copies of incident-platform's controls

**Until stage T**, when a template replaces them. These are copies of incident-platform's:
`.github/scripts/install-pinned-tool.sh`, `.github/scripts/secret-scan.sh`, `.github/scripts/test-secret-scan.sh`,
`.github/actions/setup-node/`, `.github/zizmor.yml`, `.node-version`, the tool pins of `.github/workflows/ci.yml`,
and the denies of `.claude/settings.json`. One is changed in incident-platform first, then here; incident-platform
compares the two
([its ADR-0061](https://github.com/profitbuild/incident-platform/blob/main/.ai/decisions/0061-the-product-checks-the-factorys-copies-and-leads.md),
backlog #0-268).
