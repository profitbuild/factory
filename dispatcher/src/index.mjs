/**
 * The dispatcher of the factory (incident-platform ADR-0060): claims a task, runs each agent of it as its own
 * `claude -p` in a container that holds no credential, runs the product's gate itself, and pushes and opens the
 * pull request as builder-app after checks made outside the container.
 *
 * The skeleton of step 4.1 (backlog #0-267). Step 4.3a (#0-275) brings the entry point, src/cli.mjs, with the task
 * state outside any repository, the lock and the retries of #0-261; the container's lifecycle is 4.3c's, the phases
 * 4.4's. Node's built-in modules only, no package from
 * npm (ADR-0060 D2): the dispatcher holds the GitHub App's key, so every dependency would be code running next to it.
 */

/** The dispatcher's name, as `package.json` gives it. */
export const NAME = '@profitbuild/dispatcher';
