// Not a test file. The scan of test/child-process-static.test.mjs (incident-platform backlog #0-276 AC7): every function
// of node:child_process that a module of src/ calls takes its `env` from childEnv. Node has no parser of JavaScript
// for a test to use without a package, so this reads the source as text, with a small tokenizer that blanks comments,
// strings, template literals and regular expression literals (keeping every offset), and these rules on what is left:
//  1. node:child_process (or child_process) is imported only as `import { a, b as c } from '...'`: a namespace import,
//     a default import, a re-export, `require(`, a dynamic `import(` and any other mention of the module's name in a
//     string are refused;
//  2. every use of an imported name, outside the import, is a direct call `name(` (so no alias `const s = spawn`, no
//     `spawn.call`, no passing it as a value); `x.spawn(` is another object's and not counted;
//  3. the call's arguments hold `env: childEnv(`, and nothing after that call's closing parenthesis within the
//     arguments spreads (`...`) or names `env` again, which could replace it.
// childProcessCalls gives each call's first argument as written, for the test's rule of which module starts which
// program (git only from src/git/run-git.mjs, as the variable `git`; flock only from src/state/lock.mjs).
// Its bounds, said plainly: it does not read what childEnv is given (`childEnv({ allow: Object.keys(process.env) })`
// passes: the review reads that); code inside a template literal's `${}` is blanked with the template, so a call there
// is not seen; it does not follow `Reflect.apply`, `globalThis`, `eval`, `new Function`, `process.binding` or a module
// of src/ that re-exports a wrapper by another name (rule 1 refuses the re-export of child_process itself only); a
// regular expression literal is told from a division by the token before it, as tokenizers without a parser do.

const MODULE = /^(?:node:)?child_process$/;

/** The source with comments, strings, templates and regex literals blanked (spaces; newlines kept). */
export function mask(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== '\n') {
        out[i] = ' ';
      }
    }
  };
  const strings = [];
  let i = 0;
  let last = '';
  const regexMayStart = () => last === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(?:return|typeof|case|in|of)$/.test(last);
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        j += source[j] === '\\' ? 2 : 1;
      }
      strings.push({ start: i, end: j + 1, value: source.slice(i + 1, j) });
      blank(i + 1, j);
      i = j + 1;
      last = 'x';
    } else if (c === '/' && regexMayStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && (inClass || source[j] !== '/') && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 1;
        } else if (source[j] === '[') {
          inClass = true;
        } else if (source[j] === ']') {
          inClass = false;
        }
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      last = 'x';
    } else {
      if (!/\s/.test(c)) {
        last = /[A-Za-z0-9_$]/.test(c) ? `${last.slice(-8)}${c}` : c;
      }
      i += 1;
    }
  }
  return { code: out.join(''), strings };
}

/** The offset just past the parenthesis that closes the one at `open`, in masked code. */
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
  return -1;
}

/** The first argument of the call whose arguments span [start, end) of the masked code, as the source writes it. */
function firstArgument(source, code, start, end) {
  let depth = 0;
  for (let i = start + 1; i < end - 1; i += 1) {
    if ('([{'.includes(code[i])) {
      depth += 1;
    } else if (')]}'.includes(code[i])) {
      depth -= 1;
    } else if (code[i] === ',' && depth === 0) {
      return source.slice(start + 1, i).trim();
    }
  }
  return source.slice(start + 1, end - 1).trim();
}

/**
 * Each call of an imported function of node:child_process in `source`: its name and its first argument as written.
 *
 * @param {string} source
 * @returns {{ name: string, first: string }[]}
 */
export function childProcessCalls(source) {
  return scan(source).calls;
}

/**
 * Where `source` breaks the rules above: a list of messages, empty when it keeps them.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function childProcessViolations(source) {
  return scan(source).found;
}

function scan(source) {
  const { code, strings } = mask(source);
  const found = [];
  const calls = [];
  const moduleStrings = strings.filter((s) => MODULE.test(s.value));
  const allowed = [];
  for (const string of moduleStrings) {
    const before = code.slice(0, string.start);
    const match = /\bimport\s*\{([^}]*)\}\s*from\s*$/.exec(before);
    if (match && /^\s*import\b/m.test(code.slice(code.lastIndexOf('\n', match.index) + 1, match.index + 6))) {
      allowed.push({ start: match.index, end: string.end, names: match[1] });
    } else {
      found.push(`child_process is named other than in "import { ... } from 'node:child_process'" at offset ${string.start}`);
    }
  }
  if (/\brequire\s*\(/.test(code)) {
    found.push('require( is used');
  }
  const locals = [];
  for (const { names } of allowed) {
    for (const part of names.split(',').map((p) => p.trim()).filter(Boolean)) {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (!m) {
        found.push(`an import of child_process this scan cannot read: ${part}`);
      } else {
        locals.push(m[2] ?? m[1]);
      }
    }
  }
  const inImport = (offset) => allowed.some(({ start, end }) => offset >= start && offset < end);
  for (const name of locals) {
    for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${name.replace('$', '\\$')}(?![\\w$])`, 'g'))) {
      if (inImport(use.index)) {
        continue;
      }
      const after = code.slice(use.index + name.length);
      const open = /^\s*\(/.exec(after);
      if (!open) {
        found.push(`${name} is used other than as a direct call at offset ${use.index}`);
        continue;
      }
      const start = use.index + name.length + open[0].length - 1;
      const end = closing(code, start);
      const args = code.slice(start, end);
      calls.push({ name, first: firstArgument(source, code, start, end) });
      const env = /\benv\s*:\s*childEnv\s*\(/.exec(args);
      if (!env) {
        found.push(`${name}( at offset ${use.index} takes no env: childEnv(...)`);
        continue;
      }
      const envEnd = closing(args, env.index + env[0].length - 1);
      if (/\.\.\.|\benv\b/.test(args.slice(envEnd))) {
        found.push(`${name}( at offset ${use.index} spreads or sets env after its childEnv(...)`);
      }
    }
  }
  return { found, calls };
}
