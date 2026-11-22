// The build zone's test gate on its own (incident-platform backlog #0-301; review round 1 of factory#26, gen-3c1f), in
// a task container of the fake daemon's: MAX_TEST_FIXES counts this gate's fixes, not the task's, so a gate that
// starts on a task with fixes from an earlier gate (a fix-review run's, once #0-302 lets one resume) still fixes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { setUpTaskContainer } from '../src/container/environment.mjs';
import { readExpectations } from '../src/flow/expectations.mjs';
import { MAX_TEST_FIXES, buildPhases } from '../src/flow/phases.mjs';
import { createTask, loadTask, runPhases, updateTask } from '../src/state/tasks.mjs';
import { makeAdapterProduct } from '../testing/adapter-product.mjs';
import { makeFakeDaemon } from '../testing/fake-daemon.mjs';
import { REAL_GIT } from '../testing/git-fixtures.mjs';
import { HELPER_IMAGE, makeStateDir } from '../testing/state-dir.mjs';
import { IMPLEMENTER_ANSWER, stream } from '../testing/stream-json.mjs';
import { readAdapter } from '../src/product/adapter-from-base.mjs';

const root = await makeStateDir();
after(root.remove);

const GATE = (status, artifact = null) => JSON.stringify({ status, exitCode: status === 'pass' ? 0 : 1, modules: 'm',
  log: '', head: '', artifact, summary: [] });

test('#0-301 (review round 1 of factory#26, gen-3c1f): a test gate on a task with MAX_TEST_FIXES fixes already counts '
  + 'its own from 0, and calls fix-tests', async () => {
  const dir = join(root.dir, 'gate');
  await mkdir(dir, { mode: 0o700 });
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const product = await makeAdapterProduct(dir, { files: {
    'BACKLOG.md': '# Backlog\n\n### 0-9. A thing\n**Complexity:** medium\n\nAC1. It works.\n',
    'scripts/factory/run-tests.sh': '#!/bin/sh\nif [ -f .gate ]; then cat .gate; else printf \'%s\\n\' '
      + `'${GATE('fixable')}'; fi\n`,
  } });
  const fake = makeFakeDaemon(dir);
  const adapter = await readAdapter({ repoDir: product.repoDir, base: product.base, git: REAL_GIT });
  const ready = await setUpTaskContainer({ stateDir, repoDir: product.repoDir, adapter,
    task: await createTask(stateDir, { runId: '20261122T150000Z-0f0301', item: '0-9', baseSha: product.base }),
    helperImage: HELPER_IMAGE, ...fake.runner, git: REAL_GIT });
  assert.ok(ready.container, ready.task.reason);
  const task = await updateTask(stateDir, ready.task, { fixes: MAX_TEST_FIXES });
  fake.update((s) => { s.scenario.claude = [{ stream: stream('implementer', IMPLEMENTER_ANSWER),
    files: { '.gate': GATE('pass', 'app.jar') } }]; });
  const gate = buildPhases({ stateDir, repoDir: product.repoDir, adapter, container: ready.container,
    carried: ready.carried, expectations: await readExpectations(), baseUrl: 'http://10.0.2.15:8770', ...fake.runner,
    git: REAL_GIT })
    .find((phase) => phase.name === 'test-gate');
  const left = await runPhases(stateDir, task, [gate]);
  assert.equal(left.status, 'running', left.reason);
  const record = await loadTask(stateDir, task.runId);
  assert.deepEqual(record.calls.map((c) => [c.mode, c.outcome]), [['fix-tests', 'answered']]);
  assert.equal(record.fixes, 1, 'this gate\'s one fix, counted from 0');
});
