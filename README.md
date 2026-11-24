# factory

The AI software factory of profitbuild, product-agnostic. Today it holds the dispatcher and the plugin of the build
agents; the build VM moves here in a later step (incident-platform ADR-0060 D5). A product loads it read-only,
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
| `.claude-plugin/plugin.json`, `agents/`, `hooks/` | The factory's Claude Code plugin, the repository's root its directory (see "The plugin") |
| `dispatcher/` | The dispatcher: Node (`.node-version`), built-in modules only, no package from npm (ADR-0060 D2). Its tests: `cd dispatcher && node --test` |
| `.github/workflows/ci.yml` | CI: the dispatcher's tests (`Test`); the same whole suite on git 2.43, the build VM's, in an `ubuntu:24.04` container, run as an ordinary user, not root (`Test (git 2.43)`); the workflow linters at incident-platform's pins (`Lint Workflows`); and the secret scan of every commit a pull request or a push adds (`Secret Scan`, betterleaks) |
| `.github/scripts/install-pinned-tool.sh` | Installs a CI tool pinned by tag and SHA-256; a copy of incident-platform's until stage T makes one template |
| `.github/scripts/secret-scan.sh`, `test-secret-scan.sh` | The secret scan and its cases; copies of incident-platform's, which its CI keeps equal to the originals but for their notice |
| `.devcontainer/` | Where a session writes this repository's code, as the app `profitbuild-factory-dev` (see "Changes") |
| `dispatcher/bin/dev-token.mjs` | Run on the host: mints that app's hour token for the devcontainer |
| `dispatcher/src/github/builder-token.mjs` | builder-app's token for the dispatcher (stage 4.2): minted after the checks of `checked-token.mjs`, narrowed to the product's repository (its adapter's `repository`, incident-platform backlog #0-276), kept in memory until 5 minutes before it expires, given to `git push` through `dispatcher/libexec/git-askpass.sh` only, in a push repository the dispatcher made (`push.mjs`) |
| `dispatcher/src/github/push.mjs` | builder-app's push (stage 4.3b, #0-276): no git with the dispatcher's rights runs in a repository an agent wrote. For each push, a fresh `git init --bare` under `$FACTORY_STATE_DIR/tasks/<runId>/push/` (700, removed after the push, refused or not), its objects' alternates on `FACTORY_REPO_DIR` (whose `objects`, `objects/info` and `objects/pack` must be the dispatcher's, writable by no one else, with no alternates of their own); the token source must be the same repository's; the URL is always `https://github.com/<repository>.git`; its config held to a reference `git init --bare`'s (keys and values) after init and again before the token is asked for; `FACTORY_REPO_DIR` the dispatcher's alone (it or its parent, the dispatcher's home, a directory of its user with mode 700, so no one else can write a loose object or a pack of it: incident-platform backlog #0-278 AC7); the repository made by `dispatcher/src/git/task-objects.mjs`, which the check of the trusted paths shares; the task's commits read in as a bundle (`dispatcher/src/git/bundle.mjs`: exactly the base as prerequisite, one ref, the bundle's own objects through `index-pack --strict`, the ref a descendant of the base, no ref written); the refspec the code's, `<sha>:refs/heads/factory/<branch>`, never forced |
| `dispatcher/src/git/run-git.mjs`, `dispatcher/src/process/child-env.mjs` | The one way the dispatcher runs git, `/usr/bin/git` by its full path (PATH does not choose the program handed the token): its own directory as `cwd`; `GIT_DIR` naming the repository for every command run in one, the one exception being `git init --bare <path>`, which makes the repository at the path it is given; no hooks, fsmonitor, credential helper, commit-graph, system or global config; and the one builder of every child's environment from an allowlist (`childEnv`): a variable of the dispatcher's outside the list reaches no child; `dispatcher/test/child-process-static.test.mjs` holds every call of `node:child_process` in `src/` to it |
| `dispatcher/bin/check-app.mjs` | Run on the build VM as the dispatcher's user, `node --env-file=/home/dispatcher/.config/factory/env dispatcher/bin/check-app.mjs --adapter-from-repo` (the product's repository from its adapter, `.factory/adapter.json` at `refs/heads/main` of `FACTORY_REPO_DIR`, read as the dispatcher reads it: incident-platform backlog #0-278 AC8), or `--repository <owner/name>` until the VM's `install-builder-app.sh` passes none of its own; exactly one of the two: mints a builder-app token for it, runs every check, expects 404 for an installation on factory, revokes the token; prints no token |
| `/home/dispatcher/.config/factory/env` | On the build VM, not here: builder-app's `BUILDER_APP_ID`, `BUILDER_APP_INSTALLATION_ID` and `BUILDER_APP_KEY`, as `KEY=value` lines. The dispatcher reads its settings from the environment only (incident-platform ADR-0055, `dispatcher/src/config/builder-env.mjs`), and Node loads the file into it with `--env-file`: no parser of it is ours, none is in a shell. A variable already set in the process's environment wins over the file's value. The file is trusted as code is (it can set `NODE_OPTIONS`, e.g. `--require`, and so run code in the process that reads the key), so only its owner may write it: file 600, directory 700, owned by the dispatcher user, as the deployment of step 4.2b checks (incident-platform backlog #0-272). It never holds a secret: its values reach `process.env` and every child of the dispatcher. No id sits in the code |
| `dispatcher/src/cli.mjs` | The dispatcher's entry point (stage 4.3a, incident-platform backlog #0-275), on the build VM as the dispatcher's user: `node --env-file=/home/dispatcher/.config/factory/env dispatcher/src/cli.mjs run --item 0-N` (the owner names the item until stage 7: a run with no `--item` is refused) or `run --resume <branch>`. Its settings: `FACTORY_STATE_DIR`, `FACTORY_REPO_DIR`, `FACTORY_MAX_BLOCKED`, `FACTORY_AUDIT_EVERY`, `FACTORY_MAX_MERGES_PER_DAY` and `FACTORY_HELPER_IMAGE` (the one-shot helpers' image, `buildpack-deps:noble-scm` pinned by digest, #0-277), every one required and none with a default, and `FACTORY_SLOTS` (how many tasks may be live at once, a positive integer, 1 unless set: M2's one slot; M5 sets 2; incident-platform backlog #0-303) (`dispatcher/src/config/factory-env.mjs`), and builder-app's; an unknown `FACTORY_*` is refused, and so is any variable of the environment holding a value shaped like a secret, each by its name only. It takes the dispatcher's lock for its slot section alone (incident-platform backlog #0-303: "The locks" below), opens the breaker, then (incident-platform backlog #0-278) refuses an item one of its own tasks holds (running, on a branch, or live with none yet, which the refusal names by its runId: #0-303), reads the adapter from `FACTORY_REPO_DIR`'s main for the repository builder-app's token is narrowed to, brings that main up to GitHub's with the token (fast-forward only: `+` is never used, and an update that is not one is refused; the clone's config held to a reference's but for `remote.origin.url`, before the token is handed over), takes the new main as the task's base and reads the adapter again from it, refuses an item an open pull request holds (a head branch containing `/<id>-`, every page of the list read with the token, a list not read whole refusing the start; the cases in `dispatcher/testing/fixtures/item-lock-branches.tsv`, a copy of incident-platform's `.github/scripts/fixtures/item-lock-branches.tsv`, which leads (ADR-0061) and which its `next-item.sh` tests read), refuses the run when `FACTORY_SLOTS` other tasks are live (before it touches the daemon), checks the daemon's options and refuses while a rollback runs, only then makes the task (or takes the resumed one) and takes its lock, so that a refusal leaves no task, sweeps `factory`'s daemon (the whole daemon when no other task is live, only the run's own labelled objects when one is), releases the dispatcher's lock, and under the task's lock alone sets up the task and its container (`dispatcher/src/container/`, below), and sweeps the daemon again at the end, the task BLOCKED or not; the phases come with 4.4. `cli.mjs sweep` is the sweep alone, for what a killed run left, under the dispatcher's lock: refused while any task is live, naming it (`--force` does not pass that: #0-303), and refused while a running container carries `factory.rollback`, which it names; `sweep --force` sweeps that container too (one a task's code labelled so) |
| `dispatcher/src/product/` | What the dispatcher reads of a product and how it runs its commands (incident-platform backlog #0-278, ADR-0060 D6 to D8 as amended): **no product code runs as `dispatcher`**, `main`'s included, and **a task cannot change the scripts that judge it nor the adapter that names them**. The adapter, `.factory/adapter.json`, and every file of the product the dispatcher reads are blobs of the task's base in `FACTORY_REPO_DIR`, read through `runGit`, never a checkout and never a task's branch (`adapter-from-base.mjs`, `base-tree.mjs`): every path the adapter names resolved in the base's tree segment by segment, a symlink or a submodule on the way or at it refused, a trusted directory with one under it refused; each command's script executable and under `trustedPaths`, and the adapter itself under them. A branch that changes a path of `trustedPaths` is refused before its gate by the dispatcher's own check (`trusted-paths.mjs`): `git diff-tree -r -z --name-only --no-renames` of the base and the head, in a repository made for the check from the task's bundle, held to the base's adapter; the product's `changedPaths` stays advisory. The product's commands (`gate`, `changedPaths`) run only in the task container (`commands.mjs`): the base's blobs of `trustedPaths`, packed by the dispatcher as a tar of directories and regular files alone, go on the stdin of one `docker exec` that unpacks them into a fresh `/tmp/factory-trusted.XXXXXXXX` (the one a run before left removed) and prints it, and a second runs the script from there with the clone (`/workspace`) as its working directory. So only what the script reads relative to itself (`$(dirname "$0")`) is the base's: a file it reads by a path relative to the clone is the copy in the agent's working tree (the contract of a product's commands, which `schemas/adapter.schema.json` states for `gate` and `changedPaths`); the task image must hold `sh`, `mktemp`, `tar` and `rm`, probed when the container is set up. What a command prints is the agent's side: no refusal rests on it, and CI stays the gate that counts |
| `dispatcher/src/container/` | The task container (stage 4.3c, incident-platform backlog #0-277, ADR-0062), on the build VM. No `docker`, `devcontainer` or container command runs as `dispatcher`: each goes through one starter, `run-container.mjs`, as `/usr/bin/sudo -n -H -u factory -- /usr/bin/docker\|/usr/local/bin/devcontainer`, the one sudoers rule of the VM's provisioning, with an environment from `childEnv` and no argument shaped like a secret (sudo logs them). The starter passes no variable, no directory and no `-D`: the rule's `env_reset` and `!setenv` drop the environment, its `env_file` (`/etc/factory-dispatcher.env`) gives the programs `DOCKER_HOST=unix:///run/docker.sock`, and its `secure_path` and `runcwd="/"` set PATH and the directory. What docker, devcontainer or the task container write to stderr (the agent's side) never leaves the starter (incident-platform backlog #0-284): its result is `{ code, stdout, stderrFile }` and nothing else, the stderr kept, at most 1 MiB of it, in a file of its own, `$FACTORY_STATE_DIR/stderr/<time>-<command>-<random>.log` (600, made with O_EXCL and O_NOFOLLOW, in a directory 700), for the owner to read on the VM; a refusal names the command, its exit code and that file's path, never its text. A stderr that cannot be kept fails closed (the VM's state is not certain): no result of the call is taken, an exit of 0 included, and a call that failed already keeps its own class, the original as its cause. What this guarantees, and how far: the result's shape is tested (`dispatcher/test/run-container.test.mjs`); `dispatcher/test/child-process-static.test.mjs` holds every docker and devcontainer call of `src/` to the starter; and `dispatcher/test/starter-stderr-static.test.mjs` holds that no other module of `src/` reads a `stderr` field of a result, nor names `stderrFile` but inside a message's template literal, so none can hand the path to a read (it does not see a computed key, nor a path built again from the state directory: the review reads those). The dispatcher writes nothing in a directory of `factory`'s and mounts nothing of its state: the work directory, `/home/factory/tasks/<runId>/w`, is made, written and removed by one-shot containers of the helper image pinned by digest (`work-dir.mjs`: `--network none`, three capabilities, a constant script, the base's bundle and the override on stdin), a clone of the base's bundle that shares no inode with `FACTORY_REPO_DIR`. The container's configuration is the dispatcher's, from the product's task configuration (its adapter's `taskImage`), read from the base as data (`jsonc.mjs`), held to a closed list (`task-config.mjs`, `task-config-list.json`), and written as the configuration file of `devcontainer up --config` (`work-dir.mjs` says why not `--override-config`: the CLI writes the features' lockfile beside the configuration file, and `factory` may not write in the clone); the image and the container are checked before anything runs in them (#0-284, ADR-0062 points 4 and 6 as amended): `docker info` first, before the run's first container, the sweep's helper included (and before `cli.mjs sweep`'s), its security options exactly rootless, seccomp's builtin profile and cgroup namespaces and its default runtime runc, or the run (the sweep) is refused and no container is made on the daemon; then `devcontainer build --config <runId>/build/devcontainer.json --image-name factory-task-<runId>`, a call of its own that makes no container, the image's ID read once from that name, and from there the image named by its ID alone: its `devcontainer.metadata` label held to the list (a label off it ends the task with no container of the task's and no lifecycle command run), the ID recorded in `task.json`, and `devcontainer up` from `{ image: <ID> }`, with neither a build nor a feature (either would make the CLI build another image over the one checked), for a new task and a resumed one alike; the container's image must be that ID, its mounts exactly the dispatcher's and the listed features', and its HostConfig held field by field to a closed table (`host-config.mjs`: each field the dispatcher's value, such as the configuration's and the listed features' capabilities (the one rule of CapAdd and of Privileged), a listed feature's security options, the list's run arguments, or Docker 29.9.3's default, read from moby's source at `docker-v29.9.3`; a field off the table must hold its zero value, so one a new Docker adds stops the task until the table names it; never a comparison with a reference container, which would carry the daemon's `daemon.json` into it). A refusal names a position, a count or an ID the daemon gave (hex), never a value it returned (a label's key, a mount's target, a capability's or a container's, network's or volume's name): the sweep's refusals and what `cli.mjs sweep` prints too, containers and networks by the daemon's IDs, volumes by count; the rollback's refusal alone still names its containers, until M4 removes the rollback. Every call in it runs under `timeout -s TERM -k`; past it the task's containers are killed by their label and the task ends BLOCKED. The task's commits leave as `git bundle create -` on `docker exec`'s stdout, into the dispatcher's own directory (`task-bundle.mjs`). The rollback shares the VM by time (`daemon.mjs`, `environment.mjs`): a run is refused while a running container carries `factory.rollback`; when no other task is live (in M2, always), it sweeps every container, then network, then volume of the daemon but `factory-dispatcher-m2`, then every work directory, and checks the result, and when another task is live it removes only the objects that carry its own label (#0-303); makes its labelled network; checks for a rollback again; and sweeps again at the end |
| `dispatcher/src/container/task-config-list.json` | The closed list of a task configuration (ADR-0062 point 4): the capabilities, the `docker run` arguments, the `containerEnv` keys and the features (by id, options and values, and per digest the image metadata the feature declares, which the built image's entry must equal value by value) a product's task configuration may carry. The dispatcher's, not a product's: widening it is a pull request here, reviewed by the code owner, that a product gets with the factory's next tag; an entry names a kind of product's need, never one product |
| `$FACTORY_STATE_DIR` | On the build VM, outside any repository; made by the provisioning (700, the dispatcher user's), which `run` checks and never changes: `lock` (the dispatcher's), `state.lock` (the state's) and `tasks/<runId>/lock` (a task's), the three locks of "The locks" below, `state.json` (the breaker, the semantics of incident-platform's `state.sh`), `tasks/<runId>/task.json` (with the task image's ID, #0-277), `tasks/<runId>/bundles/` (what a task container hands over, #0-277), `stderr/` (what each container call wrote to stderr, the agent's side's, kept for the owner, #0-284; its files are not rotated yet: nothing removes them today); every file 600: `state.json` and `task.json` written to a temporary file and renamed (`dispatcher/src/state/`), a bundle and a stderr file each opened once, new, with O_EXCL and O_NOFOLLOW (`task-bundle.mjs`, `run-container.mjs`) |
| `dispatcher/src/github/retry.mjs` | The one helper of every GitHub call of the flow: a 5xx, a 429, a rate limit's 403, a timeout or a network error is retried (1 s doubling to 60 s, with jitter), not counted as an attempt; ten in a row block the task with the reason (incident-platform #0-261) |
| `dispatcher/src/proxy/` | The run's credential proxy: Claude's key, the proxy's configuration, the fresh-VM marker, the token, the upstream ("The credential proxy" below; incident-platform backlog #0-313) |
| `schemas/answers/`, `schemas/findings.schema.json`, `claude-code/` | The agents' answers, a fix-review run's findings, the task container's managed settings and what an agent call must show ("Agent calls" below; incident-platform backlog #0-301) |
| `schemas/adapter.schema.json`, `schemas/gate.schema.json` | A product's `.factory/adapter.json` and its gate's answer (incident-platform ADR-0060 D6), checked by `dispatcher/src/schema/validate.mjs`, a validator of Node's built-ins that refuses any keyword it does not check |
| `CONTRIBUTING.md` | How a change is made, from the change to the merge, and who writes what: what stays after ADR-0055's migration, and what holds until a named stage |
| `.claude/settings.json` | The denies of a Claude Code session started here; `dispatcher/test/session-denies.test.mjs` keeps them |

## The plugin

The repository's root is a Claude Code plugin named `factory` (incident-platform backlog #0-299, migration step M2.0;
ADR-0060 D5 as amended), which a product's task container loads read-only from `/opt/factory` at the pinned tag
(`claude --plugin-dir`). Its agents are called by the plugin's name, `--agent factory:<agent>`: a clone's own
`.claude/agents/` would take a bare name first.

| Agent | Model, turns | What |
|---|---|---|
| `factory:architect` | `claude-opus-5-5`, 40 | Plans one item before any code: the plan file the task names and, for a reversible decision, a Proposed ADR; stops the item on anything for the owner |
| `factory:implementer` | `claude-opus-5-5`, 120 | Builds a planned item, or fixes what it is given, by mode: `implement`, `fix-tests`, `fix-review`, `fix-acceptance`, `self-check` |
| `factory:implementer-light` | `claude-sonnet-5-5`, 80 | The implementer's text word for word, but for one marked paragraph, for an item rated low in complexity |

- **Product-neutral.** No agent names a product's paths, rules, modules or stack. Each first reads the product's own
  `/workspace/CLAUDE.md` with Read, whether or not Claude Code also loads it, and what it points to; the paths of the
  task's own files (plan, handoff, the gate's log) come in the task the dispatcher writes. What the agent reads from
  `/workspace` is its working tree, which its branch can change: its context, never a ground for the dispatcher's
  decisions (ADR-0060 D6).
- **No commit.** An agent makes no commit and pushes nothing; its answer carries a `commitMessage` (a Conventional
  Commits subject by the product's rules, a blank line, a body), and the dispatcher commits each call's changes with it
  (#0-302). The answer's schema comes with the dispatcher's call (#0-301).
- **Hooks.** Claude Code ignores a plugin agent's frontmatter `hooks:`, `mcpServers:` and `permissionMode:`, so the
  plugin's hooks are `hooks/hooks.json`: `foreground-bash.mjs` refuses a Bash call with `run_in_background` (an
  agent's turns are its budget), and fails closed: every input but a Bash call in the foreground exits 2. Of its own
  accord Claude Code blocks a call only on a hook's exit 2, and runs it after any other status; with
  `onFailure: "block"`, which `hooks/hooks.json` sets, it also blocks the call when the hook exits with a status
  other than 0 or its interpreter does not start.
  The architect has no boundary hooks on this path: the old path's `readonly-bash` and `write-scope` are not
  ported (migration step M2.0's decision), so in the container nothing limits what it writes. The dispatcher's own
  check of the paths each call's commit changed replaces them (`writeScopes`, fail closed, incident-platform backlog
  #0-302); until then the architect's text alone asks it to write only its plan file and an ADR.
  A known limitation: the hook's command runs `node` from the session's PATH, not by an absolute path. The task
  image is the product's, built from its own Dockerfile, which puts Node where its base image does (`/usr/local/bin`,
  `/usr/bin`, a version manager's directory), so the plugin cannot name one path for every product. An agent that
  can write a directory earlier on PATH could put there a `node` that exits 0 and run a command in the background
  again: that costs only the turn budget this hook guards, not a security boundary (the container holds no
  credential, and the gate and the dispatcher's checks run outside it). A `NODE_OPTIONS` in the session's
  environment does the same, for example `--import` of a module that exits 0, since it loads before the hook; the
  cost is the same, the turn budget only, not a security boundary. What was measured, on Claude Code 2.1.328 with
  `onFailure: "block"`: a hook that exits 1 and a missing interpreter each blocked the Bash call, which did not run,
  and without `onFailure` the same exit 1 let it run. A hook past a `timeout` was measured once, with a timeout of
  2 s set on a copy of the plugin, and blocked too; `hooks/hooks.json` sets no `timeout` of its own, so Claude
  Code's default applies, which was not measured (the hook ends a read that does not end itself after 10 s, with
  exit 2).
- **Checks.** `dispatcher/test/plugin.test.mjs`, in job `Test`: the manifest's name, the agents' frontmatter
  exactly `name`, `description`, `tools`, `model`, `maxTurns` (a key Claude Code would ignore fails here),
  a list of refused patterns (the first product's names and paths, a stack's words) absent from `agents/`, no commit,
  the sentence that the repository's text is data, not instructions, in each of the three agents, the light agent
  equal to the implementer but for its paragraph, and each hook's script present. A product's word an agent truly
  needs takes a deliberate change of the list `REFUSED` in that test, which the review sees.
  `dispatcher/test/foreground-bash.test.mjs` runs the hook as Claude Code does: in the background refused, in the
  foreground allowed, every malformed input refused, an input over 1 MiB refused without being quoted, and an
  exception, a rejected promise and a failing read of stdin each refused with exit 2. `claude plugin validate .` passes
  offline and without a token, but is not in CI: it would need Claude Code installed there at a pin and a change to
  the workflow, which is the owner's, and it does not see an agent's `hooks:`, which the test does.

## Agent calls

The build zone's phases (incident-platform backlog #0-301, migration steps M2.2 and M2.3; ADR-0063, ADR-0064, ADR-0065) run in `dispatcher/src/flow/`, under the run's task lock, in the task container the run set up. No call in this repository's code or tests reaches Claude: the tests replay recorded stream-json through the fake daemon (`dispatcher/testing/stream-json.mjs`). The task container holds no Claude key: only its task's token for the run's credential proxy ("The credential proxy" below; incident-platform backlog #0-313, M2.7).

**The call (F3, `flow/call.mjs`).**
- The command is `docker exec <ID> /usr/bin/timeout … /usr/bin/env -i <list> /usr/local/bin/claude -p --plugin-dir /opt/factory --agent factory:<agent> --restricted --tools <frontmatter> --add-dir /workspace --output-format stream-json --verbose --json-schema <schema> --permission-mode dontAsk --max-turns <frontmatter>`.
- It runs from `/workspace`, and the container is always addressed by the ID recorded in `task.json`. Every program is named by its full path.
- The prompt goes on stdin, because `--tools` takes several values and would consume a prompt placed after it.
- `--tools`, the model and `--max-turns` come from the agent's frontmatter (`agents/<agent>.md`), read from the checkout the dispatcher runs from, which is the tree mounted as `/opt/factory`. They are never copied.
- The list for `env -i` holds only literals the dispatcher writes:
  - `HOME`, the locale, and `PATH` with the system directories only;
  - the `containerEnv` the task configuration was accepted with;
  - `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (Claude Code's traffic other than the model's calls, such as the telemetry among its builtin plugins and the remote settings, would otherwise go to Anthropic past #0-313's proxy: ADR-0064 point 5 as amended on 2026-11-22), `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`;
  - `ANTHROPIC_BASE_URL=http://<ADDR>:<port>`, the run's proxy's address (#0-313): a literal, no secret. The token is in no variable.
  
  No secret ever goes in it: the arguments of `env` are visible in `/proc`.
- The time limit is 30 minutes for the architect, 90 for the implementer and 60 for implementer-light.

**Managed settings.**
- `claude-code/etc/managed-settings.json` is mounted read-only over the whole of `/etc/claude-code` in the task container. The mount is part of `expectedMounts` and of the HostConfig table.
- `apiKeyHelper` is `/usr/bin/cat /run/factory/token` (#0-313): Claude Code's credential is the task's token, from its read-only file.
- It sets `allowManagedPermissionRulesOnly: true`, `strictPluginOnlyCustomization: true` (a boolean: 2.1.328 rejects the object form), `strictKnownMarketplaces: []` and `disableAllHooks: false`.
- The agents have seven tools: `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` and `StructuredOutput`, through which `structured_output` comes back. The settings allow six of them: `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`. The list leaves out `StructuredOutput` on purpose: measured on 2.1.328, its call passes under `allowManagedPermissionRulesOnly` and `dontAsk` with no allow rule (`permission_denials` empty).
- It never sets `allowManagedHooksOnly` or `disableSideloadFlags`.

**The init event**, checked before the answer is read (`INIT_CHECKS`). Any difference stops the task:
- `agents` holds `factory:<agent>`, and every other entry is either a factory agent or one of the builtin agents listed in `claude-code/expectations.json` (a closed list, like the plugins);
- `plugins` has exactly one entry outside the builtin ones, `factory` at `/opt/factory` from `factory@inline`, and the builtin ones are exactly those listed in `claude-code/expectations.json`;
- `plugin_errors` is empty or absent;
- `tools` is the agent's expected set;
- `model` is the frontmatter's;
- `permissionMode` is `dontAsk`;
- `claude_code_version` is the expected one;
- `mcp_servers` is empty;
- `apiKeySource` is `"apiKeyHelper"` (#0-313): a constant of the check, not of `expectations.json`. #0-313 measured `"none"` without a helper and with `ANTHROPIC_AUTH_TOKEN` in the environment, so a call whose credential came any other way stops. What keeps a credential of the environment out is `env -i`, not this field.

**`claude-code/expectations.json`** holds the expected version (`claudeCodeVersion`, `MAJOR.MINOR.PATCH`), which incident-platform's `check-factory-copies.rb` compares with its `.devcontainer/claude-code.pin`. It also holds the builtin plugins and builtin agents measured on that version, each agent's tools (a test keeps them equal to the frontmatter), and `anthropicBetas`, the `anthropic-beta` values Claude Code's calls send on that version, which the credential proxy alone lets through (#0-313: the eight measured by the owner on 2026-11-24, every call of the three agents sending all of them; the call's shape, keys, types and roles only, is `dispatcher/testing/fixtures/claude-code-2.1.328-request-shape.json`, and a test passes a call of that shape through the proxy).

Both builtin lists are measured with the whole of `callEnv`'s variables, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` among them. The first call on the VM (#0-301 AC4) records the builtin plugins and agents of its init event. If they differ from the lists, the lists are corrected before any run; until then a run stops at the init event's check, as it should.

The file is read after `sweep`'s branch, so `cli.mjs sweep` still works when it is broken; a run is refused.

**The stream and the answer.**
- The stream is written to `tasks/<runId>/calls/<n>-<agent>.jsonl` (mode 600) as it arrives, up to 64 MiB. It is never held whole in memory.
- It is read back line by line, failing closed:
  - the first line must be the init event;
  - every line must be JSON and an event type 2.1.328 writes;
  - the last line must be the single `result`.
- A call that exits other than 0 is a stop, even when its result is a success.
- The answer is `structured_output` of a successful result, checked against `schemas/answers/<agent>.schema.json`, the same bytes passed to `--json-schema`. It is written to `calls/<n>-<agent>.answer.json`.
- The agent's own words stay in that file. Only an answer's `commitMessage` is kept in the call's record, as `agentText`, for #0-302.
- `commitMessage` has a fixed form in the schema: a subject of one line (1 to 100 characters), then a blank line and a body; printable characters and `\n` only, at most 8000 in all; no line that starts like one of the dispatcher's trailers (`Factory-…:`, `Task:`, `Feature:`).

**The phases** (`flow/phases.mjs`):
1. `plan`: the architect;
2. `implement`: the implementer, or implementer-light when the item's Complexity is low;
3. `path-gate`: the adapter's `changedPaths`; an exit code other than 0 stops the task;
4. `test-gate`: the adapter's `gate`.
   - A pass with an artifact ends the phase.
   - A pass without one, or a stop, stops the task.
   - A fixable result calls the implementer in fix-tests mode, at most `MAX_TEST_FIXES` (2) times. The count is this gate's: each test gate starts it at 0.

`run --resume <branch> --findings <file>` is a fix-review run: the implementer in fix-review mode, then the two gates. One run is one review round, at most `MAX_ROUNDS` (3).
- The findings file is the owner's, mode 600, in the form of `schemas/findings.schema.json`.
- The ids are `<kind>-<4 hex>`, or `ver-<8 hex>` for a refuted claim.
- The implementer's answer must name each id exactly once, in `fixed` or `disputed`.

**Records and stops.**
- Every call is recorded in the task's `calls` before it starts, so a killed call still counts. A call beyond `MAX_AGENT_CALLS` (45) stops the task.
- An agent call, the item's read and both gates stop the item on the same failures: a call's, the item's, GitHub out of reach, and the task container's blocking failures (`BLOCKING` in `container/environment.mjs`: a stream past its limit, a stderr that cannot be kept, a signal, sudo, git, the base tree). A call that fails this way is recorded as `failed` first.
- Every stop goes through `stopItem`: the task is marked BLOCKED with `<stage>: <reason>` in the dispatcher's own words, and the breaker counts it with its stage.
- The item comes from the adapter's queue files (a queue of kind `backlog-md`; any other kind is a stop), read as blobs of the base. It must have a single `**Complexity:** low|medium|high` anywhere in its block and at least one line beginning `AC<n>.`.
- Until #0-302 commits a run's work, a task that has completed a phase cannot be resumed, with `--findings` or without.

## The credential proxy

Claude's key stays outside the task container (incident-platform backlog #0-313, M2.7; ADR-0060 D4, ADR-0064 point 5 and ADR-0062 points 4 and 5 as amended). The container holds only its task's token, and reaches Claude through a proxy of the dispatcher's (`dispatcher/src/proxy/`). No test reaches Anthropic or holds a real key: they run against a fake upstream (`dispatcher/testing/fake-anthropic.mjs`) with a key that is a marker.

**A run, step by step** (`proxy/task-proxy.mjs`):
1. Before the slot section, `cli.mjs` reads Claude's key and `/etc/factory-proxy.conf`. Either one off its form refuses the run before the daemon, and so does `FACTORY_SLOTS` above the number of ports.
2. Right before the task's container, the run consumes the fresh-VM marker (below), since `devcontainer up` already runs the product's code.
3. The container is set up and checked. Its token's directory, `/home/factory/tasks/<runId>/token/`, made empty by the work directory's helper, is mounted read-only on `/run/factory`. The mount is in the exact mount comparison and the `HostConfig` table.
4. The proxy starts in the run's own process, on `ADDR` and the first free port of `PORTS`. It makes the token: 32 random bytes.
5. A helper writes the token into `token/token`: from stdin, never an argument (sudo logs a command's arguments), mode 444, with noclobber.
6. The token is activated, and the phases run. Each call's `env -i` list holds `ANTHROPIC_BASE_URL`, and the managed settings' `apiKeyHelper` prints the file.
7. In a finally, whatever the phases did, the token is revoked, the proxy closed and its record written.
8. The sweep at the end removes the work directory, and the token's file with it.

A stop in step 2, 4 or 5 ends the task BLOCKED through `stopItem`, stage `fresh-vm` or `proxy`, and the breaker counts it. No token is then issued.

**The proxy** (`proxy/server.mjs`, `proxy/upstream.mjs`):
- It lives and dies with its run, so a token is valid only while its run lives. A run killed takes its proxy with it, and each run's proxy knows no token but its own.
- It listens on `ADDR` alone, never `0.0.0.0` or the loopback.
- A request carries the token in `x-api-key` or `Authorization: Bearer`. Claude Code sends both, and both present must agree. The token is compared in constant time.
- Anything else is 401: no token, another task's, one not yet active or revoked.
- It forwards only `POST /v1/messages`, with no query or exactly `?beta=true`. `HEAD /api/hello`, `count_tokens` and every other path are 404 until AC4 shows a need (the owner's answer on the plan).
- The target is fixed, `https://api.anthropic.com:443`, its Host and TLS server name the proxy's own, never the request's.
- Every refusal is in Anthropic's error shape, `X-Should-Retry` false on 400, 401, 403, 404 and 413, true with `Retry-After: 1` on 429 and 503.
- At most 4 requests of the task are in flight; one more is 429.
- The request's body is held, to 32 MiB (413 past it, a chunked body too), and read only to check its tools and betas: never logged, written or kept after the request. The response is never buffered. A client that closes ends the upstream request. (This reverses #0-313's first rule, "the body is never read": review round 1 of factory#29, sec-5a7e.)
- **What passes** (`proxy/request-filter.mjs`, an allowlist): the body must be a JSON object, nested no deeper than 64 levels anywhere (`MAX_DEPTH`) and of no more than 100 000 arrays and objects (`MAX_NODES`, counted on the bytes before `JSON.parse` and again on the tree), with no `mcp_servers` key, whatever its value, and a `messages` that is an array of objects, each with a `content` that is a string or an array. Each element of its `tools`, if any, must be a client tool: no `type`, or `type: "custom"`; any other `type` (`web_search`, `web_fetch`, any server tool, whatever its version) is refused. Each object with a `source` key, in any content block of `messages` or of `system` (when it is a list), a `tool_result`'s content included, at any depth, must have `source.type` `base64` or `text`, each block there must be of a type of `BLOCK_TYPES` (`text`, `image`, `document`, `tool_use`, `tool_result`, `thinking`, `redacted_thinking`; any other, or none, is refused), and no object there may carry a `file_id`: Anthropic fetches a `url` source itself, and a `file` one is the workspace's (review round 2 of factory#29, sec-c41e). What goes upstream is the parsed body serialized again, the very value the filter checked, so a key given twice or bytes that are no UTF-8 cannot show Anthropic another body. Each comma-separated value of `anthropic-beta` must be one of `claude-code/expectations.json`'s `anthropicBetas`, the betas measured from Claude Code's own calls on the pinned version. Any other value refuses the request; it is not cut from the header. A refusal is 400 `invalid_request_error`, `X-Should-Retry: false`, counted in `proxy.json` and logged by its reason alone (never the body, a tool's name or type, or the header's value), and nothing reaches upstream. Without this check a task's code, which holds the token and Bash, could ask Anthropic to run a tool on Anthropic's side that reaches any host from there.
- **The filter never throws, and the handler leaves no rejection** (review round 3 of factory#29, sec-d3e7, a regression of round 2, whose unbounded walk of a hostile tree could end the dispatcher with none of its `finally` blocks run). The depth is measured first, iteratively, over the whole body; any exception in the check is a refusal (`invalid`); anything left in the awaited handling of a request is 500 `api_error`, `X-Should-Retry: false` (or the socket ended, once the headers went); each callback that counts a response in upstream's listeners catches its own, a failure there stopping that response's count and never its stream (`accountingErrors`), and a listener that throws past them destroys both sides of that exchange alone (`internal`). So no exception a request makes in the proxy's code reaches the process. The proxy guarantees this for its own code: a fault of Node's own, such as memory run out, is outside it, which `MAX_NODES` and `BODY_LIMIT` bound.
- **A second layer, outside this repository and checked by nothing here:** web search, web fetch and the MCP connector turned off for the factory's workspace in the Console, where the Console allows it per workspace (the owner checks it).
- Timeouts: 10 s to connect, 120 s to the response's headers, 300 s with no byte of the stream.
- A refusal goes to the run's stderr at most once per 10 s per reason, the next line counting those skipped. A line names the run, the reason and, for a path, the path alone (no query, cut to 200 characters, quoted as JSON). It never names a header, a query or a value of the request's or of upstream's.

**The headers:**

| Direction | Removed | Set | Passed |
|---|---|---|---|
| Client to upstream | `Authorization`, `X-Api-Key`, `Cookie` of the client; the hop-by-hop ones; every header not passed | `x-api-key` (the key), `host`, `accept-encoding: identity` (so the meter reads plain SSE), `content-length` | `anthropic-version`, `anthropic-beta`, `content-type`, `accept`, `user-agent`, `x-stainless-*` |
| Upstream to client | `set-cookie` and every header not passed | | `content-type`, `content-length`, `request-id`, `retry-after`, `x-should-retry`, `anthropic-ratelimit-*` |

The request list is a guess: no measurement recorded Claude Code's header names. So the names of the request headers dropped go to `proxy.json`, without values. AC4 compares them with a call that answered, and the list changes knowingly if a dropped header was needed.

**What it counts** (`proxy/usage.mjs`): `tasks/<runId>/proxy.json` (`state/proxy.schema.json`), its own file and not `task.json`, which the phases write from the task they hold. It holds:
- the requests forwarded, and those refused by reason;
- the tokens summed from each response's SSE stream, read from `message_start` and `message_delta` alone. The meter holds one line at most, and a response it cannot count is `unmetered`;
- the last response's rate-limit headers (`retry-after`, `anthropic-ratelimit-*`, each value a number or an ISO time), for M5's slots;
- the names of the request headers dropped (`^[a-z0-9-]{1,64}$`, at most 32, the rest counted).

The proxy writes it under the state's lock, at most once a second, and once more when it closes.

**Claude's key** (`proxy/key.mjs`): `CLAUDE_KEY`, an absolute path, by default `/home/dispatcher/.config/factory/claude.key`. It holds the Console key of the factory's workspace, which has a monthly spend limit (the owner's). It must be the dispatcher's own regular file, mode 600, at most 512 bytes, one line `sk-ant-…`. It is read once at the start of a run and kept only in that run's memory and in the upstream's `x-api-key`.

**`/etc/factory-proxy.conf`** (`proxy/conf.mjs`), written by incident-platform's `provision.sh` at every boot, `root:root` 0644:

    ADDR=<the address of the dummy interface provision.sh sets up for the proxy>
    PORTS=8770

The proxy has an address of its own, on a dummy interface (the owner's measurement on the VM). `ADDR` must be an IPv4 literal of a local interface, neither a wildcard nor of `127.0.0.0/8`, and not the address of an interface a default route leaves by (read from `/proc/net/route`): that is the VM's own address, which in a cloud its network sees. A route table that cannot be read refuses the run too. `PORTS` (one port per slot, comma-separated) must lie in 1024–65535, outside the ephemeral range 32768–60999, with no port twice. Until #0-285 the fresh-VM marker allows one run per VM, whatever `FACTORY_SLOTS` and however many ports: a second port added early is no working second slot. The file must be root's and writable by no one else. A refusal names the file and the field, never a value. The address comes from this file alone: the dispatcher works out no address of the VM's. `provision.sh` also drops the ports from any device but `lo` (the proxy is unreachable from outside the VM), and lets `factory`'s containers reach them through `FACTORY-EGRESS`.

**The fresh VM** (`proxy/fresh-vm.mjs`, #0-313 AC6): until #0-285, a run that holds a token runs only on a VM made anew that has run nothing before.
- incident-platform's `create.sh` writes `/etc/factory-fresh-vm` as root once provisioning has finished: `root:root` 0644, one line of 32 hex. `provision.sh` never writes it.
- The dispatcher cannot remove a file of root's. A run consumes the marker in the dispatcher's state instead: `fresh-vm.json`, compare and set under the state's lock.
- Every later run on that VM stops in stage `fresh-vm`, naming the run that consumed it. So does a `--resume`, and so does a run with the marker missing or off its form.
- The limit: removing the dispatcher's state on a live VM arms the marker again. Only someone with access to the VM can do that, and a VM made anew has a new state anyway.

**The token, and what it yields when leaked.**
- The token's file is 444 and owned by `factory`'s container root. Any process in the task's container can read it, as it can read anything of its container: ADR-0064 promises no isolation between users inside a container.
- On the VM, any process of uid `factory` can read it too, and that includes every task, through the daemon's socket. This is why the fresh-VM rule holds.
- Between tasks, what isolates is: the mount into its own task's container only, a token valid only in its own run's proxy, and the fresh VM.
- A leaked token yields calls of the model through that proxy, and so from the VM only and only while its run lives, within the workspace's spend limit. It yields no key and no other path. What the body's filter closes, by itself, is: Anthropic's server tools (a typed tool other than `custom`), MCP connectors (`mcp_servers`), content sources other than `base64` and `text` (a `url` Anthropic would fetch, a `file` of the workspace's), content blocks of any type off `BLOCK_TYPES` (`server_tool_use`, `mcp_tool_use`, `container_upload`, or one a beta adds), any `file_id` in the content, `messages` off its form, and betas off the measured list. So far as that allowlist holds, a leaked token reaches no other host through Anthropic. The Console's setting above is the second layer, outside this repository.

## The locks

The dispatcher's runs share one VM, and from M5 on two tasks may be live at once (incident-platform backlog #0-303, ADR-0060 D7 and ADR-0062 point 7 as amended). The three locks share one mechanism, `dispatcher/src/state/lock.mjs`: a flock(2) taken with util-linux's `/usr/bin/flock` on a descriptor the run holds, so a killed run, even by SIGKILL, leaves its locks free, a child it left behind included. No pid is written and nothing is renewed.

| Lock | Held | For |
|---|---|---|
| `$FACTORY_STATE_DIR/lock`, the dispatcher's | While a run takes its slot, while it sweeps at its end, and for `cli.mjs sweep`; waited for, up to 30 minutes, since the slot section holds the fetch of main (up to 10 minutes) and the sweep's helpers (up to 10 minutes each) | The slot section, in this order: the breaker; the fetch of main (`FACTORY_REPO_DIR` is shared, and two fetches at once collide on git's own locks); the item and the base, with the check of the item against the dispatcher's own tasks (a task running on a branch, or live with none yet, holds its item: two new runs of one item cannot both pass the check, since the second sees the first's task, made under the same lock); the count of the live tasks, refused at `FACTORY_SLOTS`; the daemon's options and the rollback's refusal; only then the task, made or the resumed one, and its lock; and the sweep. A refusal before the task leaves no task and no `tasks/<runId>/`. Counting before the run's own lock opens no race: a task's liveness grows only under the dispatcher's lock, and a run killed meanwhile can only make the count smaller. At the end: the live tasks counted again, and the sweep; if the lock is not free within the wait, the run removes its own labelled objects under its task's lock, so that no container of the agent's code is left running with no run to watch it |
| `$FACTORY_STATE_DIR/tasks/<runId>/lock`, a task's | For the whole run of that task, new or resumed; only ever tried, never waited for | The task is live while its lock cannot be taken (`isLive`): a resumed task whose lock is held is refused, the slots count the live tasks, and `cli.mjs sweep` is refused while any is live |
| `$FACTORY_STATE_DIR/state.lock`, the state's | Around every read, change and write of `state.json` and of the tasks' records, each call whole; waited for, up to 5 seconds | Two runs that record an outcome at once both count, and neither write is lost; the writes are still atomic (a temporary file renamed) |

**The order.** A run takes the locks in the order dispatcher, task, state. At its end it holds its own task's lock and waits for the dispatcher's. That makes no cycle of waits, because no one ever waits for a task's lock: it is only tried. The invariant is that no one waits for a task's lock, and no one waits for the dispatcher's while holding the state's. `isLive` and the task's lock are used only under the dispatcher's lock, since `isLive`'s try takes a free lock for an instant.

**`FACTORY_SLOTS` above 1 is not safe yet.** It has no hard limit, because the tests need 2. A value above 1 is not safe before #0-285 (M3.4: the daemon's model and the sweep's scope) and M4. While the rollback exists, the sweep of the whole daemon removes its volumes, which hold credentials; that full sweep runs when no other task is live (a run alone, or `cli.mjs sweep`), and with `FACTORY_SLOTS` above 1 overlapping tasks can keep putting it off. M5 raises it, not earlier.

**The sweep's scope.** When no other task is live, which in M2 is always, the sweep covers the whole daemon. When another task is live, it removes only the objects that carry the run's own label. What a sweep of a shared daemon removes when two tasks are live belongs to #0-285 (M3.4).

## Changes

`main` changes only by pull requests the owner merges: the ruleset requires a pull request and the code owner's
review, and refuses force pushes and deletion; its required checks are the CI jobs `Test`, `Test (git 2.43)`,
`Lint Workflows` and `Secret Scan`; a tag can be neither moved nor deleted, since products load the factory at one, and only an admin
creates one (today the owner alone).

The code is written by a session holding the token of the GitHub App `profitbuild-factory-dev`, and no other GitHub
credential (incident-platform ADR-0060 D5 as amended, backlog #0-269). The app is installed on this repository
alone, with Contents and Pull requests read and write and Metadata read: it pushes a branch and opens a pull request;
GitHub refuses it a push to `main`, a merge of a pull request the owner has not approved, a review that counts, a tag
and a change to `.github/workflows/`. Contents write still lets it publish a release on a tag that exists, and create
or delete a branch through the API: there the session's denies (`.claude/settings.json`) are the only barrier. A branch other than `main` can also be deleted by a push (`git push origin --delete <b>`), which no deny stops.

## Development

How a change is made, from the change to the merge, and who writes what: [CONTRIBUTING.md](CONTRIBUTING.md).

**A module's length** (incident-platform backlog #0-317). A module opens with a header of its invariants, which holds
only while the module is short. `dispatcher/test/max-lines.test.mjs` therefore holds every `.mjs` file of
`dispatcher/src/`, `dispatcher/bin/`, `dispatcher/testing/` and `hooks/` to two limits. Past 400 lines it warns in
the test's output; past 600 it fails. A test file is not held, since tests grow with what they cover. The files
already past 600 when the test came in are on its `RATCHET`, each at its own length: an entry always equals its
file's length. Shorten the file and lower its entry in the same change; a file down to 600 lines or fewer leaves the
list; a new module past 600 lines is split. The test holds each entry to its file's current length. That the list
only shrinks, that no file is added to it and that no limit is raised is held by review, which sees any change of
`RATCHET` or `LIMITS`: the test knows no history, so a change that adds a 700-line module together with its entry,
or raises `LIMITS`, passes it. The `Test` jobs run it, so it needs no change to CI.

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
   `node`'s one sudo rule runs `init-firewall.sh` without arguments and nothing else (`""` in the rule: sudo refuses
   `sudo init-firewall.sh <host>` before the script runs), and `node` is in neither `sudo` nor `admin`
   (incident-platform backlog #0-311).
4. Claude Code is `/usr/local/bin/claude`, root's, mode 0755, at the version of `.devcontainer/claude-code.pin`
   (incident-platform backlog #0-311, ADR-0065). The image's build installs it as root, before `USER node`, with
   `install-claude-code.sh`: the binary must be the one whose SHA-256 the manifest names, and that manifest must be
   signed by the key in `.devcontainer/keys/`. Nothing in the container updates it (`DISABLE_AUTOUPDATER=1`,
   `DISABLE_UPDATES=1`), and the image puts no `~/.local/bin` before it on `PATH`. A login shell still can:
   `node`'s `~/.profile` (Debian's `/etc/skel/.profile`) puts `~/bin` and `~/.local/bin` first when they exist, and
   `node` owns its home, so a session can leave a `claude` there, or a `PATH` line in `~/.bashrc`, that the owner's
   login shell in this container runs instead. That residual is the one incident-platform's ADR-0065 names. The call
   that is certain is `/usr/local/bin/claude` by its full path; `which -a claude` shows any other.
   The pin, the script and the key are incident-platform's files, byte for byte (ADR-0061). incident-platform does
   not compare them yet: its `check-factory-copies.rb` gains them in its part of #0-311 (AC3), after this one is
   merged. They need a list of their own there, compared byte for byte, both ways: that check's copy mode wants a
   NOTICE paragraph in the copy, which a copy byte for byte, the key's `.asc` among them, cannot hold. Being byte for
   byte, their comments name incident-platform's files (`scripts/factory/preflight.sh`,
   `.github/scripts/test-install-claude-code.sh`, "every task container"), which factory does not have: they speak
   of the repository they come from, where the installer's test is. A new version is a change of the pin there
   first, copied here, then a rebuild. The build fetches from `downloads.claude.ai`; the running container
   never does, and its firewall does not allow it. CI builds no image: `Lint Workflows` runs
   `.devcontainer/test-dockerfile.sh` (the Dockerfile read as text, with its own mutations) and
   `install-claude-code.sh --check` (the pin against the signed manifest).

Security issues: report them privately through the repository's **Security** tab ("Report a vulnerability"), not in
a public place.

## Licence

[Apache License 2.0](LICENSE).
