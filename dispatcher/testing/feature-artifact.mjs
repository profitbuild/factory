// Not a test file. A feature's artifact, as the image label is made of it (incident-platform backlog #0-277, review
// round 1 arc-c7d1): `devcontainer up` copies some fields of the feature's devcontainer-feature.json into the built
// image's devcontainer.metadata label, under the feature's id. The fixtures are the files themselves, from the
// feature's OCI layer at its digest; the fake daemon builds its labels from them, never from the dispatcher's list,
// so a list that differs from what a feature declares is seen by the tests.
import { readFileSync } from 'node:fs';

/** The fields of devcontainer-feature.json that devcontainer up copies into the image's label. */
export const LABEL_FIELDS = Object.freeze(['init', 'privileged', 'capAdd', 'securityOpt', 'entrypoint', 'mounts',
  'customizations', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand',
  'postAttachCommand']);

/**
 * The artifacts the tests have, by digest: docker-outside-of-docker 1.10.1, devcontainer-feature.json from the layer
 * sha256:86e5644893ee2b5e08d7897c93b8b47cc6fa4c14e9056c09c5b99d8a8b572101 of the manifest below (ghcr.io).
 */
export const ARTIFACTS = Object.freeze({
  'sha256:698f5900fac471e046c6e9d4333fec88c0e8d952c713494fa0712dce80baeca0':
    new URL('./fixtures/docker-outside-of-docker-1.10.1/devcontainer-feature.json', import.meta.url),
});

/** The artifact's devcontainer-feature.json at `digest`. */
export function artifact(digest) {
  if (!Object.hasOwn(ARTIFACTS, digest)) {
    throw new Error(`no artifact of a feature at ${digest} among the fixtures`);
  }
  return JSON.parse(readFileSync(ARTIFACTS[digest], 'utf8'));
}

/** The label's entry for the feature at `digest`, under `id`, as devcontainer up writes it. */
export function labelEntry(digest, id) {
  const declared = artifact(digest);
  return { id, ...Object.fromEntries(LABEL_FIELDS.filter((f) => Object.hasOwn(declared, f)).map((f) => [f, declared[f]])) };
}
