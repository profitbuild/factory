// Not a test file. A run that takes the dispatcher's lock and holds it until it is killed (incident-platform backlog
// #0-275 AC2): `node hold-lock.mjs <stateDir>` prints "locked" once it holds it.
import { acquireLock } from '../src/state/lock.mjs';

acquireLock(process.argv[2]);
process.stdout.write('locked\n');
setInterval(() => {}, 60_000);
