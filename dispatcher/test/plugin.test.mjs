// The factory's plugin (incident-platform backlog #0-299, migration step M2.0; ADR-0060 D5 as amended): the manifest,
// the three build agents and the plugin's hooks, at the repository's root, which a product's task container loads
// read-only as the plugin directory. Here, in the dispatcher's suite, because job Test runs it (`node --test` in
// dispatcher/), as session-denies.test.mjs checks the root's .claude/settings.json.
//
// What it holds (AC1):
//  - the agents are product-neutral: no pattern of REFUSED below occurs in agents/; a product's knowledge reaches them
//    through the product's own CLAUDE.md, which each reads first, and the task's files through the task;
//  - an agent's frontmatter holds exactly the keys Claude Code honours for a plugin agent that the factory sets
//    (`hooks:`, `mcpServers:` and `permissionMode:` are ignored for a plugin agent; `skills:` did not preload in a
//    `claude -p --agent` session on Claude Code 2.1.328, measured for #0-299): a key that would be ignored fails here,
//    where `claude plugin validate` passes it;
//  - no agent commits: the dispatcher commits each call's changes with the answer's `commitMessage` (#0-302, M2.4);
//  - implementer-light is the implementer's text but for one marked paragraph (one definition, two models);
//  - every hook command names a script of the plugin that exists, through ${CLAUDE_PLUGIN_ROOT}, and blocks when it
//    cannot start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS = ['architect', 'implementer', 'implementer-light'];
const FRONTMATTER_KEYS = ['name', 'description', 'tools', 'model', 'maxTurns'];
/** The models and turn limits, as the old path's definitions have them (#0-299, point H): a change is deliberate. */
const LIMITS = {
  architect: { model: 'claude-opus-5-5', maxTurns: '40' },
  implementer: { model: 'claude-opus-5-5', maxTurns: '120' },
  'implementer-light': { model: 'claude-sonnet-5-5', maxTurns: '80' },
};
const FIRST_READ = 'Before anything else, read `/workspace/CLAUDE.md` with the Read tool';

/**
 * What a product-neutral agent may not name, each pattern with a sample it must match (checked below, so the list
 * cannot be weakened unseen). Case-insensitive but for the rule ids'. A word that turns out to be needed is unblocked
 * by a change of this list, which the review sees. `CLAUDE.md` and `/workspace` match none of them.
 */
const REFUSED = [
  // The product (incident-platform): its name, its domain, its modules.
  { what: 'the product\'s name or domain', pattern: /incident/i, sample: 'incident-platform' },
  { what: 'the product\'s domain', pattern: /tenant/i, sample: 'TenantContext' },
  { what: 'the product\'s broker', pattern: /kafka/i, sample: 'a Kafka consumer' },
  { what: 'a module of the product', pattern: /-service\b/i, sample: 'notification-service' },
  // The product's paths and the old path's.
  { what: 'the product\'s .ai/ tree', pattern: /\.ai\//i, sample: '.ai/rules/implementation.md' },
  { what: 'the product\'s factory scripts', pattern: /scripts\/factory/i, sample: 'scripts/factory/run-tests.sh' },
  { what: 'the product\'s gate script', pattern: /run-tests\.sh/i, sample: 'run-tests.sh' },
  { what: 'a hook path of the product', pattern: /CLAUDE_PROJECT_DIR/i, sample: '"$CLAUDE_PROJECT_DIR"/.claude/hooks' },
  { what: 'the old path\'s settings', pattern: /settings\.autopilot/i, sample: '.claude/settings.autopilot.json' },
  { what: 'the old path\'s mode', pattern: /dontAsk/i, sample: 'runs in dontAsk mode' },
  { what: 'the old path\'s operator', pattern: /factory-ops/i, sample: 'factory-ops' },
  { what: 'the old path\'s Workflow tool', pattern: /\bworkflow tool/i, sample: 'a Workflow tool\'s agents' },
  // The product's backlog and decisions: the agents say "item" and "decision".
  { what: 'the product\'s backlog', pattern: /\bbacklog\b/i, sample: 'BACKLOG.md' },
  { what: 'an ADR number', pattern: /ADR-\d/i, sample: 'ADR-0060' },
  { what: 'an item number', pattern: /#?\b0-\d{2,}\b/, sample: 'backlog #0-206' },
  { what: 'a rule id of the product', pattern: /\b[A-Z]{2,4}-\d{2}\b/, sample: 'SEC-03' },
  // A stack: the spring-boot profile is the product's until it moves into the factory as a profile (M6.1).
  { what: 'a build tool', pattern: /mvnw/i, sample: './mvnw -q test' },
  { what: 'a build tool', pattern: /maven/i, sample: 'a new Maven repository' },
  { what: 'a build file', pattern: /\bpom\.xml/i, sample: 'pom.xml' },
  { what: 'a build tool', pattern: /gradle/i, sample: './gradlew' },
  { what: 'a test library', pattern: /testcontainers/i, sample: 'Testcontainers' },
  { what: 'a framework', pattern: /spring/i, sample: 'spring-boot' },
  { what: 'a migration tool', pattern: /flyway/i, sample: 'a Flyway migration' },
  { what: 'a language', pattern: /\bjava\b/i, sample: 'src/main/java' },
];

/** The agents make no commit (the dispatcher does, M2.4): what they may not tell themselves to do. */
const NO_COMMIT = [/git commit/i, /git push/i, /headSha/, /--trailer/i, /Co-Authored-By/i];

/** The frontmatter and the body of an agent file: `key: value` lines only, every other form refused. */
function parseAgent(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'an agent file starts with a frontmatter between --- lines');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*): (\S.*)$/.exec(line);
    assert.ok(field, `a frontmatter line is "key: value", one line each (a list or a block is refused): ${line}`);
    assert.ok(!(field[1] in fields), `the key ${field[1]} appears once`);
    fields[field[1]] = field[2];
  }
  return { fields, body: match[2] };
}

const agents = Object.fromEntries(await Promise.all(AGENTS.map(async (name) =>
  [name, parseAgent(await readFile(new URL(`../../agents/${name}.md`, import.meta.url), 'utf8'))])));

test('the plugin is named factory, so its agents are factory:<agent>, and carries no version to drift from its tag',
  async () => {
    const manifest = JSON.parse(await readFile(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    assert.equal(manifest.name, 'factory');
    assert.equal('version' in manifest, false, 'the pin is the tag; a version would repeat it and drift');
  });

test('agents/ holds the three build agents and nothing else', async () => {
  const files = (await readdir(new URL('../../agents/', import.meta.url))).sort();
  assert.deepEqual(files, AGENTS.map((name) => `${name}.md`).sort());
});

test('AC1: an agent\'s frontmatter holds exactly name, description, tools, model and maxTurns, no hooks', () => {
  for (const [name, { fields }] of Object.entries(agents)) {
    assert.deepEqual(Object.keys(fields).sort(), [...FRONTMATTER_KEYS].sort(), name);
    assert.equal(fields.name, name);
    assert.equal(fields.model, LIMITS[name].model, name);
    assert.equal(fields.maxTurns, LIMITS[name].maxTurns, name);
    assert.equal(fields.tools, 'Read, Grep, Glob, Bash, Edit, Write', name);
  }
});

test('AC1: the frontmatter parser refuses hooks:, as a block or inline, and every key outside the five', () => {
  const block = '---\nname: x\nhooks:\n  PreToolUse: []\n---\nbody\n';
  assert.throws(() => parseAgent(block), /one line each/);
  const inline = parseAgent('---\nname: x\nhooks: {}\n---\nbody\n');
  assert.notDeepEqual(Object.keys(inline.fields).sort(), [...FRONTMATTER_KEYS].sort());
  assert.throws(() => parseAgent('no frontmatter\n'), /starts with a frontmatter/);
  assert.throws(() => parseAgent('---\nname: x\nname: y\n---\n'), /appears once/);
});

test('every agent first reads the product\'s CLAUDE.md with Read, before anything else', () => {
  for (const [name, { body }] of Object.entries(agents)) {
    assert.ok(body.trimStart().startsWith(FIRST_READ), name);
  }
});

test('AC1: no agent names a path, module, rule or name of a product, nor a stack', async () => {
  const found = [];
  for (const name of AGENTS) {
    const text = await readFile(new URL(`../../agents/${name}.md`, import.meta.url), 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const { what, pattern } of REFUSED) {
        if (pattern.test(line)) {
          found.push(`agents/${name}.md:${index + 1}: ${what} (${pattern})`);
        }
      }
    });
  }
  assert.deepEqual(found, []);
});

test('the refused patterns match their samples, and spare CLAUDE.md and /workspace', () => {
  for (const { what, pattern, sample } of REFUSED) {
    assert.match(sample, pattern, what);
  }
  for (const allowed of ['/workspace/CLAUDE.md', 'CLAUDE.md', '/workspace', 'the item', 'a decision (ADR)']) {
    assert.deepEqual(REFUSED.filter(({ pattern }) => pattern.test(allowed)).map(({ what }) => what), [], allowed);
  }
});

test('no agent commits or pushes: the factory commits with the answer\'s commitMessage', () => {
  for (const [name, { body }] of Object.entries(agents)) {
    for (const pattern of NO_COMMIT) {
      assert.doesNotMatch(body, pattern, `${name}: ${pattern}`);
    }
    assert.match(body, /Make no commit/, name);
    assert.match(body, /`commitMessage` is the message of the commit the factory makes/, name);
    assert.match(body, /Conventional Commits/, name);
    assert.match(body, /"commitMessage": "/, `${name}: the answer's example carries commitMessage`);
  }
});

test('the implementer keeps its five modes', () => {
  for (const name of ['implementer', 'implementer-light']) {
    for (const mode of ['implement', 'fix-tests', 'fix-review', 'fix-acceptance', 'self-check']) {
      assert.match(agents[name].body, new RegExp(`^- \`${mode}\`: `, 'm'), `${name}: ${mode}`);
    }
  }
});

test('implementer-light is the implementer\'s text but for its one marked paragraph', () => {
  const light = agents['implementer-light'].body;
  const marked = /\n<!-- light:start -->\n[\s\S]*?\n<!-- light:end -->\n/g;
  assert.equal(light.match(marked)?.length, 1, 'one marked paragraph');
  assert.equal(light.replace(marked, ''), agents.implementer.body);
  assert.match(light.match(marked)[0], /not Complexity low/);
});

test('hooks.json: each command runs a script of the plugin that exists, through ${CLAUDE_PLUGIN_ROOT}, and blocks',
  async () => {
    const config = JSON.parse(await readFile(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'));
    const entries = Object.entries(config.hooks).flatMap(([event, groups]) => groups.flatMap((group) =>
      group.hooks.map((hook) => ({ event, matcher: group.matcher, hook }))));
    assert.deepEqual(entries.map(({ event, matcher }) => `${event} ${matcher}`), ['PreToolUse Bash'],
      'foreground-bash, the one hook of M2.0');
    for (const { hook } of entries) {
      assert.equal(hook.type, 'command');
      assert.equal(hook.onFailure, 'block', 'a hook that cannot start refuses the call');
      const script = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.mjs)"$/.exec(hook.command);
      assert.ok(script, `node "\${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs", nothing else: ${hook.command}`);
      assert.ok((await stat(`${ROOT}${script[1]}`)).isFile(), script[1]);
    }
  });
