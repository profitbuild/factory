// Not a test file. The scan of test/child-process-static.test.mjs for the options only a test gives (incident-platform
// backlog #0-276, review round 2): pushTask's `gitBase` and `hooks`, the `git` of runGit and of the helpers that run
// git, runGit's `maxOutput`, and mainObjects' `lstatOf`. No module of src/ gives one a value: in production git is
// /usr/bin/git, the host GitHub's, no hook, the bound GIT_MAX_OUTPUT, the lstat of node:fs.
//
// The rule, on the source masked as child-process-scan.mjs masks it (comments, strings, templates and regex literals
// blanked):
//  - a call of one of FUNCTIONS (an identifier followed by `(`, not a method `x.f(`, not its declaration) whose
//    arguments name one of OPTIONS as a key with a value (`git: ...`) is refused, in every module;
//  - the same key as a shorthand (`{ git }`) forwards the caller's own parameter: allowed only in the modules of
//    CHAIN, which pass a test's value down to runGit, refused anywhere else;
//  - pushTarget, whose host is its second argument, is called with one argument, but in push.mjs, which forwards its
//    own `gitBase`.
// Its bounds: an object built elsewhere and passed whole (`runGit(options)`) is not read, nor a spread (`...opts`) of
// one; a key computed (`[name]: x`) is not seen. The review reads those.
import { mask } from './child-process-scan.mjs';

export const OPTIONS = Object.freeze(['git', 'gitBase', 'hooks', 'maxOutput', 'lstatOf']);
export const FUNCTIONS = Object.freeze(['pushTask', 'runGit', 'initBare', 'readConfig', 'checkPushConfig',
  'loadBundle', 'mainObjects', 'pushTarget']);
/** The modules that run git, or push, and forward a test's options to it. */
export const CHAIN = Object.freeze(['git/run-git.mjs', 'git/bundle.mjs', 'git/config-allowlist.mjs',
  'github/push.mjs']);

function closing(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') {
      depth += 1;
    } else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return code.length;
}

/** The top-level arguments of a call, as masked code, split on its commas. */
function argumentsOf(args) {
  const parts = [];
  let depth = 0;
  let from = 1;
  for (let i = 1; i < args.length - 1; i += 1) {
    if ('([{'.includes(args[i])) {
      depth += 1;
    } else if (')]}'.includes(args[i])) {
      depth -= 1;
    } else if (args[i] === ',' && depth === 0) {
      parts.push(args.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(args.slice(from, args.length - 1));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Where `source`, the module at `path` under src/, gives a test's option: a list of messages, empty when it does not.
 *
 * @param {string} path
 * @param {string} source
 * @returns {string[]}
 */
export function testOnlyOptions(path, source) {
  const { code } = mask(source);
  const found = [];
  for (const name of FUNCTIONS) {
    for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g'))) {
      if (/\bfunction\s*$/.test(code.slice(0, use.index))) {
        continue;
      }
      const open = use.index + use[0].length - 1;
      const args = code.slice(open, closing(code, open));
      for (const key of args.matchAll(
        new RegExp(`(?:[{,]\\s*)(${OPTIONS.join('|')})\\s*([:,}])`, 'g'))) {
        if (key[2] === ':') {
          found.push(`${path}: ${name}( gives ${key[1]} a value`);
        } else if (!CHAIN.includes(path)) {
          found.push(`${path}: ${name}( forwards ${key[1]}, which only the modules that run git may`);
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
