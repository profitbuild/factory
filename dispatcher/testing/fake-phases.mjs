// Not a test file. Three fake phases and a run of them that a test can kill at a chosen point (incident-platform
// backlog #0-275 AC3):
//
//   node fake-phases.mjs <stateDir> <runId> <log> [<phase>:<effect|start>]
//
// Each phase appends its name to <log> (its effect on the world), then returns its changes, which depend only on the
// task it is given. With a pause point, the run prints "paused" there and waits to be killed: `B:effect` after B's
// effect and before its write, `C:start` after B's write and before C does anything. Without one it runs to the end
// and prints the task.
import { appendFileSync } from 'node:fs';

import { createTask, loadTask, runPhases } from '../src/state/tasks.mjs';

export function fakePhases(log, pause) {
  const wait = (point) => (pause === point
    ? new Promise(() => { process.stdout.write('paused\n'); setInterval(() => {}, 60_000); })
    : Promise.resolve());
  const phase = (name, changes) => ({
    name,
    async run(task) {
      await wait(`${name}:start`);
      appendFileSync(log, `${name}\n`);
      await wait(`${name}:effect`);
      return changes(task);
    },
  });
  return [
    phase('A', () => ({ branch: 'factory/0-1-fake', baseSha: 'a'.repeat(40) })),
    phase('B', (task) => ({ round: task.round + 1, calls: [...task.calls, { agent: 'implementer', n: task.round + 1 }] })),
    phase('C', (task) => ({ pr: `https://github.example/pr/${task.round}`, status: 'shipped' })),
  ];
}

if (import.meta.main) {
  const [stateDir, runId, log, pause] = process.argv.slice(2);
  const task = await loadTask(stateDir, runId).catch(() => createTask(stateDir, { runId, item: '0-1' }));
  const left = await runPhases(stateDir, task, fakePhases(log, pause));
  process.stdout.write(`${JSON.stringify(left)}\n`);
}
