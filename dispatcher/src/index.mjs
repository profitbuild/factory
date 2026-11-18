/**
 * The dispatcher of the factory (incident-platform ADR-0060): claims a task, runs each agent of it as its own
 * `claude -p` in a container that holds no credential, runs the product's gate itself, and pushes and opens the
 * pull request as builder-app after checks made outside the container.
 *
 * This is the skeleton of step 4.1 (backlog #0-267): nothing runs yet. Step 4.3 (#0-261) brings the core: task
 * state outside any repository, the lock, the container's lifecycle. Node's built-in modules only, no package from
 * npm (ADR-0060 D2): the dispatcher holds the GitHub App's key, so every dependency would be code running next to it.
 */

/** The dispatcher's name, as `package.json` gives it. */
export const NAME = '@profitbuild/dispatcher';
