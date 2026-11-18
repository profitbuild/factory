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
| `.github/workflows/ci.yml` | CI: the dispatcher's tests (`Test`) and the workflow linters at incident-platform's pins (`Lint Workflows`) |
| `.github/scripts/install-pinned-tool.sh` | Installs a CI tool pinned by tag and SHA-256; a copy of incident-platform's until stage T makes one template |

## Changes

`main` changes only by the owner's pull requests: the ruleset requires a pull request and the code owner's review,
and refuses force pushes and deletion (the two CI jobs become required checks once their first run has registered
them); a tag can be neither moved nor deleted, since products load the factory at one. No bot and no GitHub App has
access to this repository.

Security issues: report them privately through the repository's **Security** tab ("Report a vulnerability"), not in
a public place.

## Licence

[Apache License 2.0](LICENSE).
