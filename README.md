# factory

The AI software factory of profitbuild, product-agnostic. Today it holds the skeleton of the dispatcher; the build
VM and the agent definitions move here in later steps (incident-platform ADR-0060 D5). A product loads it read-only,
at a pinned tag; nothing here is specific to one product.

Decided in [incident-platform](https://github.com/profitbuild/incident-platform), the product it is proven on:

- [ADR-0055](https://github.com/profitbuild/incident-platform/blob/main/.ai/decisions/0055-the-factory-moves-to-three-zones.md):
  the factory moves to three zones, one stage at a time;
- [ADR-0060](https://github.com/profitbuild/incident-platform/blob/main/.ai/decisions/0060-a-dispatcher-runs-each-agent-in-a-task-container.md):
  stage 4, a dispatcher on the build VM runs each agent of a task in a container that holds no credential;
- [the stage 4 plan](https://github.com/profitbuild/incident-platform/blob/main/.ai/context/migration/stage-4.md),
  step by step.

## Layout

| Path | What |
|---|---|
| `dispatcher/` | The dispatcher: Node (`.node-version`), built-in modules only, no package from npm (ADR-0060 D2). Its tests: `cd dispatcher && node --test` |
| `.github/workflows/ci.yml` | CI: the dispatcher's tests (`Test`), the workflow linters at incident-platform's pins (`Lint Workflows`), and the secret scan of every commit a pull request or a push adds (`Secret Scan`, betterleaks) |
| `.github/scripts/install-pinned-tool.sh` | Installs a CI tool pinned by tag and SHA-256; a copy of incident-platform's until stage T makes one template |
| `.github/scripts/secret-scan.sh`, `test-secret-scan.sh` | The secret scan and its cases; copies of incident-platform's, which its CI keeps equal to the originals but for their notice |
| `.devcontainer/` | Where a session writes this repository's code, as the app `profitbuild-factory-dev` (see "Changes") |
| `dispatcher/bin/dev-token.mjs` | Run on the host: mints that app's hour token for the devcontainer |
| `dispatcher/src/github/builder-token.mjs` | builder-app's token for the dispatcher (stage 4.2): minted after the checks of `checked-token.mjs`, narrowed to the product's repository (its adapter's `repository`, incident-platform backlog #0-276), kept in memory until 5 minutes before it expires, given to `git push` through `dispatcher/libexec/git-askpass.sh` only, in a push repository the dispatcher made (`push.mjs`) |
| `dispatcher/src/github/push.mjs` | builder-app's push (stage 4.3b, #0-276): no git with the dispatcher's rights runs in a repository an agent wrote. For each push, a fresh `git init --bare` under `$FACTORY_STATE_DIR/tasks/<runId>/push/` (700, removed after the push, refused or not), its objects' alternates on `FACTORY_REPO_DIR` (whose `objects`, `objects/info` and `objects/pack` must be the dispatcher's, writable by no one else, with no alternates of their own); the token source must be the same repository's; the URL is always `https://github.com/<repository>.git`; its config held to a reference `git init --bare`'s (keys and values) after init and again before the token is asked for; the task's commits read in as a bundle (`dispatcher/src/git/bundle.mjs`: exactly the base as prerequisite, one ref, the bundle's own objects through `index-pack --strict`, the ref a descendant of the base, no ref written); the refspec the code's, `<sha>:refs/heads/factory/<branch>`, never forced |
| `dispatcher/src/git/run-git.mjs`, `dispatcher/src/process/child-env.mjs` | The one way the dispatcher runs git, `/usr/bin/git` by its full path (PATH does not choose the program handed the token): its own directory as `cwd`; `GIT_DIR` naming the repository for every command run in one, the one exception being `git init --bare <path>`, which makes the repository at the path it is given; no hooks, fsmonitor, credential helper, commit-graph, system or global config; and the one builder of every child's environment from an allowlist (`childEnv`): a variable of the dispatcher's outside the list reaches no child; `dispatcher/test/child-process-static.test.mjs` holds every call of `node:child_process` in `src/` to it |
| `dispatcher/bin/check-app.mjs` | Run on the build VM as the dispatcher's user, `node --env-file=/home/dispatcher/.config/factory/env dispatcher/bin/check-app.mjs --repository <owner/name>` (the product's repository, as its adapter names it; required since #0-276): mints a builder-app token for it, runs every check, expects 404 for an installation on factory, revokes the token; prints no token |
| `/home/dispatcher/.config/factory/env` | On the build VM, not here: builder-app's `BUILDER_APP_ID`, `BUILDER_APP_INSTALLATION_ID` and `BUILDER_APP_KEY`, as `KEY=value` lines. The dispatcher reads its settings from the environment only (incident-platform ADR-0055, `dispatcher/src/config/builder-env.mjs`), and Node loads the file into it with `--env-file`: no parser of it is ours, none is in a shell. A variable already set in the process's environment wins over the file's value. The file is trusted as code is (it can set `NODE_OPTIONS`, e.g. `--require`, and so run code in the process that reads the key), so only its owner may write it: file 600, directory 700, owned by the dispatcher user, as the deployment of step 4.2b checks (incident-platform backlog #0-272). It never holds a secret: its values reach `process.env` and every child of the dispatcher. No id sits in the code |
| `dispatcher/src/cli.mjs` | The dispatcher's entry point (stage 4.3a, incident-platform backlog #0-275), on the build VM as the dispatcher's user: `node --env-file=/home/dispatcher/.config/factory/env dispatcher/src/cli.mjs run [--item 0-N \| --resume <branch>] --adapter <product>/.factory/adapter.json`. Its settings: `FACTORY_STATE_DIR`, `FACTORY_REPO_DIR`, `FACTORY_MAX_BLOCKED`, `FACTORY_AUDIT_EVERY` and `FACTORY_MAX_MERGES_PER_DAY`, every one required and none with a default (`dispatcher/src/config/factory-env.mjs`), and builder-app's; an unknown `FACTORY_*` is refused, and so is any variable of the environment holding a value shaped like a secret, each by its name only. It takes the lock, checks the adapter, opens the breaker and sets up the task; the phases come with 4.4 |
| `$FACTORY_STATE_DIR` | On the build VM, outside any repository; made by the provisioning (700, the dispatcher user's), which `run` checks and never changes: `lock` (one flock(2) for the whole dispatcher in v0, taken with util-linux's `/usr/bin/flock` on a descriptor the run holds, so a killed run leaves it free), `state.json` (the breaker, the semantics of incident-platform's `state.sh`), `tasks/<runId>/task.json`; every file 600, written to a temporary file and renamed (`dispatcher/src/state/`) |
| `dispatcher/src/github/retry.mjs` | The one helper of every GitHub call of the flow: a 5xx, a 429, a rate limit's 403, a timeout or a network error is retried (1 s doubling to 60 s, with jitter), not counted as an attempt; ten in a row block the task with the reason (incident-platform #0-261) |
| `schemas/adapter.schema.json`, `schemas/gate.schema.json` | A product's `.factory/adapter.json` and its gate's answer (incident-platform ADR-0060 D6), checked by `dispatcher/src/schema/validate.mjs`, a validator of Node's built-ins that refuses any keyword it does not check |
| `CONTRIBUTING.md` | How a change is made, from the change to the merge, and who writes what: what stays after ADR-0055's migration, and what holds until a named stage |
| `.claude/settings.json` | The denies of a Claude Code session started here; `dispatcher/test/session-denies.test.mjs` keeps them |

## Changes

`main` changes only by pull requests the owner merges: the ruleset requires a pull request and the code owner's
review, and refuses force pushes and deletion; its required checks are the CI jobs `Test`, `Lint Workflows` and
`Secret Scan`; a tag can be neither moved nor deleted, since products load the factory at one, and only an admin
creates one (today the owner alone).

The code is written by a session holding the token of the GitHub App `profitbuild-factory-dev`, and no other GitHub
credential (incident-platform ADR-0060 D5 as amended, backlog #0-269). The app is installed on this repository
alone, with Contents and Pull requests read and write and Metadata read: it pushes a branch and opens a pull request;
GitHub refuses it a push to `main`, a merge of a pull request the owner has not approved, a review that counts, a tag
and a change to `.github/workflows/`. Contents write still lets it publish a release on a tag that exists, and create
or delete a branch through the API: there the session's denies (`.claude/settings.json`) are the only barrier. A branch other than `main` can also be deleted by a push (`git push origin --delete <b>`), which no deny stops.

## Development

How a change is made, from the change to the merge, and who writes what: [CONTRIBUTING.md](CONTRIBUTING.md).

The session runs in `.devcontainer/`, on the owner's Mac:

1. On the host, from a clone on `main`: `node dispatcher/bin/dev-token.mjs --watch`. It reads the app's key
   (`~/.config/profitbuild-factory-dev/app.pem`, mode 600), checks the installation and the token against GitHub,
   and keeps `~/.local/state/profitbuild-factory-dev/token` fresh; Ctrl-C revokes the token and deletes the file.
   Its checks are builder-app's (`dispatcher/src/github/checked-token.mjs`, incident-platform backlog #0-273): the
   key must be a regular file of the user running it, not a symlink nor a FIFO, readable by no one else; the
   installation on this repository must be the app's (`app_id`), have the id `INSTALLATION_ID` of
   `dev-token.mjs`, and hold exactly the three permissions; the token must reach this repository alone and hold the
   same three. Installing the app again gives it a new installation id: dev-token then refuses every token until
   `INSTALLATION_ID` is changed (or `--installation-id` names the new one), on purpose. After a change to
   dev-token or to the code it imports, `git pull` the host's clone: the host runs it from there.
2. `devcontainer up --workspace-folder .`, then `devcontainer exec --workspace-folder . bash`: the devcontainer CLI,
   not VS Code's "Reopen in Container", which forwards the host's git credential helper (the owner's admin token) and
   SSH agent into the container (`credential-check.sh` refuses such a container loudly; it is a tripwire, not a
   boundary). The first start
   clones the repository into the container's own volume (`factory-dev-workspace`): the host's clone is not mounted,
   so nothing the container writes is ever run by the host. Log in to Claude Code there once; the login stays in the
   volume `factory-dev-claude`.
3. `git` and `gh` there use the app's token (a credential helper and a wrapper of `gh` read the file); commits are
   `profitbuild-factory-dev[bot]`'s. Outbound traffic is HTTPS to GitHub and Anthropic only (`init-firewall.sh`).

Security issues: report them privately through the repository's **Security** tab ("Report a vulnerability"), not in
a public place.

## Licence

[Apache License 2.0](LICENSE).
