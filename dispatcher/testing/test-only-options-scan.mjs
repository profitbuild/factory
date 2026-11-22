// Not a test file. The scan of test/child-process-static.test.mjs for the options only a test gives (incident-platform
// backlog #0-276, review rounds 2 and 3; #0-277): pushTask's `gitBase` and `hooks`, the `git` of runGit and of the
// helpers that run git, runGit's `maxOutput`, mainObjects' `lstatOf`, the `uid` a test names as the owner, and the
// `sudo` of the container starter and of everything that runs a container command (#0-277: the fake daemon). No
// module of src/ or bin/ gives one a value: in production git is /usr/bin/git, sudo /usr/bin/sudo, the host GitHub's,
// no hook, the bound GIT_MAX_OUTPUT (or GIT_MAX_LARGE_OUTPUT, runGit's `large`), the lstat of node:fs, the owner the
// process's own user.
//
// The rule, on the source masked as child-process-scan.mjs masks it (comments, strings, templates and regex literals
// blanked, offsets kept), with its closing() and argumentsOf():
//  - a call of one of FUNCTIONS (an identifier followed by `(`, not a method `x.f(`, not its declaration) whose
//    arguments name one of OPTIONS as a key with a value is refused, in every module: `git: ...`, and the key in
//    quotes too (`'git': ...`, `"git": ...`);
//  - the same key as a shorthand (`{ git }`) forwards a value: allowed only in the modules of CHAIN, which pass their
//    caller's down to runGit, and only when the module declares no local of that name (`const`, `let`, `var`, plain or
//    destructured), so that what it forwards is a parameter; refused anywhere else;
//  - pushTarget, whose host is its second argument, is called with one argument, but in push.mjs, which forwards its
//    own `gitBase`.
// Its bounds: an object built elsewhere and passed whole (`runGit(options)`) is not read, nor a spread (`...opts`) of
// one; a key computed (`[name]: x`) is not seen; a parameter reassigned (`git = '/x';`) before it is forwarded is not
// seen. The review reads those.
import { argumentsOf, closing, mask } from './child-process-scan.mjs';

export const OPTIONS = Object.freeze(['git', 'gitBase', 'hooks', 'maxOutput', 'lstatOf', 'uid', 'sudo', 'apiBase']);
export const FUNCTIONS = Object.freeze(['pushTask', 'runGit', 'initBare', 'readConfig', 'checkPushConfig',
  'loadBundle', 'mainObjects', 'pushTarget',
  // #0-277: the container starter and everything that runs a container command, or git for the task container.
  'runContainerCommand', 'mustRun', 'helper', 'makeWorkDir', 'writeOverride', 'removeWorkDir', 'removeAllWorkDirs',
  'docker', 'containers', 'networks', 'volumes', 'runningRollbacks', 'refuseWhileRollback', 'sweepDaemon', 'checkSwept',
  'createTaskNetwork', 'createTaskVolumes', 'removeOwnObjects', 'killTask', 'readTaskConfig', 'treeEntry', 'blobOf',
  'upContainer', 'inspectJson', 'execInTask', 'callInTask', 'probeTimeout', 'bundleFromTask', 'setUpTaskContainer',
  'inTaskEnvironment', 'mainCommit', 'makeBaseBundle', 'inRepo', 'sweep', 'main',
  // #0-278: the reads of the base, the fetch of main, the read of a task's commits, the item's lock, the commands.
  'lsTree', 'resolveInBase', 'subtreeFiles', 'readBlobs', 'readAdapter', 'checkAdapterPaths', 'currentAdapter',
  'itemAndBase', 'fetchMain', 'checkRepoConfig', 'withTaskObjects', 'checkOwnRepoDir', 'changedPathsOf',
  'checkTaskPaths', 'trustedArchive', 'runProductCommand', 'openPullHeads', 'probeTools',
  // #0-301: an agent's call, the item's read, the phases.
  'callAgent', 'readItem', 'buildPhases', 'readAgent', 'readAnswerSchema', 'readExpectations', 'readFindings']);
/**
 * The modules that run git, push, or run a container command, and the options of a test's each may forward: all but
 * `sudo` for #0-276's, `git` and `sudo` for #0-277's (the task container's), and for the CLI's main, which a test calls
 * with the fake daemon and the fake GitHub, `sudo`, `gitBase` and `apiBase` (#0-278).
 */
const ALL = Object.freeze(OPTIONS.filter((option) => !['sudo', 'apiBase'].includes(option)));
const TASK = Object.freeze(['git', 'sudo']);
/** The flow's own test options, by the function that takes them, and the modules that may forward them (#0-301). */
export const FLOW_OPTIONS = Object.freeze({ readAgent: ['root'], readAnswerSchema: ['root'],
  readExpectations: ['root'], readFindings: ['root'], callAgent: ['root', 'limitS'], buildPhases: ['root', 'limitS'] });
const FLOW_CHAIN = Object.freeze({ 'flow/expectations.mjs': ['root'] });
export const CHAIN = Object.freeze({
  'git/run-git.mjs': ALL, 'git/bundle.mjs': ALL, 'git/config-allowlist.mjs': ALL, 'github/push.mjs': ALL,
  'git/base-bundle.mjs': TASK, 'container/run-container.mjs': TASK, 'container/work-dir.mjs': TASK,
  'container/daemon.mjs': TASK, 'container/task-container.mjs': TASK, 'container/task-bundle.mjs': TASK,
  'container/environment.mjs': TASK, 'cli.mjs': Object.freeze(['sudo', 'gitBase', 'apiBase']),
  'git/task-objects.mjs': ALL, 'git/main-fetch.mjs': ALL, 'product/base-tree.mjs': Object.freeze(['git']),
  'product/adapter-from-base.mjs': Object.freeze(['git']), 'product/trusted-paths.mjs': Object.freeze(['git', 'uid']),
  'product/commands.mjs': TASK, 'github/item-lock.mjs': Object.freeze(['apiBase']),
  // #0-301: the flow's modules pass the task container's sudo and the reads' git down.
  'flow/call.mjs': TASK, 'flow/item.mjs': Object.freeze(['git']), 'flow/phases.mjs': TASK,
});

/**
 * Where `source`, the module at `path` under src/, gives a test's option: a list of messages, empty when it does not.
 *
 * @param {string} path
 * @param {string} source
 * @returns {string[]}
 */
export function testOnlyOptions(path, source) {
  const { code, strings } = mask(source);
  const found = [];
  const declaresLocal = (name) => new RegExp(`\\b(?:const|let|var)\\s+(?:${name}\\b|[{[][^}\\]]*\\b${name}\\b[^}\\]]*[}\\]])`)
    .test(code);
  for (const name of FUNCTIONS) {
    for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g'))) {
      if (/\bfunction\s*$/.test(code.slice(0, use.index))) {
        continue;
      }
      const open = use.index + use[0].length - 1;
      const close = closing(code, open);
      const args = code.slice(open, close);
      for (const key of args.matchAll(new RegExp(`(?:[{,]\\s*)(${OPTIONS.join('|')})\\s*([:,}])`, 'g'))) {
        if (key[2] === ':') {
          found.push(`${path}: ${name}( gives ${key[1]} a value`);
        } else if (!(CHAIN[path] ?? []).includes(key[1])) {
          found.push(`${path}: ${name}( forwards ${key[1]}, which only the modules that run git may`);
        } else if (declaresLocal(key[1])) {
          found.push(`${path}: ${name}( forwards ${key[1]}, a local of the module's, not its caller's`);
        }
      }
      for (const string of strings.filter((st) => st.start > open && st.end <= close && OPTIONS.includes(st.value))) {
        if (/^\s*:/.test(code.slice(string.end))) {
          found.push(`${path}: ${name}( gives ${string.value} a value, its key in quotes`);
        }
      }
      // #0-301 (review round 1 of factory#26, 10): the flow's readers of the factory checkout take `root`, a test's,
      // and an agent's call takes no `limitS` but its own: no module gives either a value, the one that forwards
      // `root` (flow/expectations.mjs, its parameter) apart.
      for (const extra of FLOW_OPTIONS[name] ?? []) {
        for (const key of args.matchAll(new RegExp(`(?:[{,]\\s*)(${extra})\\s*([:,}])`, 'g'))) {
          if (key[2] === ':' || !(FLOW_CHAIN[path] ?? []).includes(extra) || declaresLocal(extra)) {
            found.push(`${path}: ${name}( gives or forwards ${extra}, a test's`);
          }
        }
      }
      if (name === 'pushTarget') {
        const parts = argumentsOf(args);
        if (parts.length > 1 && !(path === 'github/push.mjs' && parts.length === 2 && parts[1] === 'gitBase')) {
          found.push(`${path}: pushTarget( is given a host`);
        }
      }
    }
  }
  return found;
}
