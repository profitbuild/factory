/**
 * The dispatcher's own settings, from its environment only (incident-platform ADR-0055; backlog #0-275, step 4.3a):
 *
 *   FACTORY_STATE_DIR=<absolute path>           the dispatcher's state, outside any repository (lock, state.json,
 *                                               tasks/); made by the provisioning, 700 and the dispatcher user's
 *   FACTORY_REPO_DIR=<absolute path>            the product's clone the dispatcher reads `main` from
 *   FACTORY_MAX_BLOCKED=<positive integer>      the breaker: blocked tasks in a row before `run` is refused
 *   FACTORY_AUDIT_EVERY=<positive integer>      tasks shipped between two audits
 *   FACTORY_MAX_MERGES_PER_DAY=<positive integer>
 *   FACTORY_HELPER_IMAGE=<name>[:tag]@sha256:<64 hex>
 *                                               the one-shot helpers' image, buildpack-deps:noble-scm pinned by
 *                                               digest (incident-platform ADR-0062 points 2 and 8, backlog #0-277):
 *                                               the provisioning's pin, never a tag alone
 *   FACTORY_SLOTS=<positive integer>            how many tasks may be live at once (incident-platform backlog #0-303,
 *                                               ADR-0060 D7 as amended): 1 unless set; M5 sets 2
 *
 * Every one is required but FACTORY_SLOTS, which the owner's decision of #0-303 gives a default of 1, the one slot of
 * M2: none other has a default (ADR-0052 point 5), so a limit is always one the owner wrote. A variable
 * with the prefix FACTORY_ that is not one of these is refused as unknown, FACTORY_PROXY_ADDR included until step 4.6
 * (the credential proxy) adds it here. The mechanism and its rules (a refusal names the variable, never its value) are
 * settings.mjs's.
 */
import { isAbsolute } from 'node:path';

import { HELPER_IMAGE } from '../container/work-dir.mjs';
import { positiveInteger, readSettings } from './settings.mjs';

const path = (field) => ({ field, valid: isAbsolute, parse: String, expected: 'an absolute path' });
const count = (field) => ({ field, valid: positiveInteger, parse: Number, expected: 'a positive integer' });

const SETTINGS = {
  FACTORY_STATE_DIR: path('stateDir'),
  FACTORY_REPO_DIR: path('repoDir'),
  FACTORY_MAX_BLOCKED: count('maxBlocked'),
  FACTORY_AUDIT_EVERY: count('auditEvery'),
  FACTORY_MAX_MERGES_PER_DAY: count('maxMergesPerDay'),
  FACTORY_HELPER_IMAGE: { field: 'helperImage', valid: (v) => HELPER_IMAGE.test(v), parse: String,
    expected: 'an image pinned by its digest, <name>[:tag]@sha256:<64 hex>' },
  FACTORY_SLOTS: count('slots'),
};

/** The settings with a default (#0-303). */
const DEFAULTS = { slots: 1 };

/**
 * @param {Record<string, string | undefined>} [env] process.env by default
 * @returns {{ stateDir: string, repoDir: string, maxBlocked: number, auditEvery: number, maxMergesPerDay: number,
 *   helperImage: string, slots: number }}
 * @throws {import('./settings.mjs').ConfigError}
 */
export function readFactoryEnv(env = process.env) {
  return readSettings(env, {
    prefix: 'FACTORY_', settings: SETTINGS, required: Object.keys(SETTINGS).filter((name) => name !== 'FACTORY_SLOTS'),
    defaults: DEFAULTS,
    missingHint: ' (it has no default, ADR-0052 point 5)',
  });
}
