/**
 * The item a run builds (incident-platform backlog #0-301, the owner's answer to point A): read from the adapter's
 * queue files (`queue.kind` backlog-md, e.g. BACKLOG.md), as blobs of the task's base, as the adapter is (ADR-0060
 * D6), never from a branch nor a working tree. The parser is closed:
 * - the item is the one heading `### <id>. <title>` across the queue files, its block running to the next `### ` or
 *   `## ` heading;
 * - the block holds `**Complexity:** low|medium|high` exactly once, anywhere in a line (BACKLOG.md writes it in the
 *   middle of one: "**Autopilot:** … · **Risk:** … · **Complexity:** high · …"), and no other
 *   `**Complexity:**`;
 * - the block has at least one line that begins with `AC<n>.`, under an "Acceptance criteria." heading or not.
 * Anything else stops the task, naming what is missing, never quoting the text. The block goes into the prompt as the
 * base's data; the dispatcher decides on the Complexity alone (low: implementer-light).
 */
import { blobOf } from '../product/base-tree.mjs';

/** The item is not one the dispatcher builds. */
export class ItemError extends Error {}

const COMPLEXITY = /\*\*Complexity:\*\* (low|medium|high)(?![A-Za-z0-9-])/g;
const ANY_COMPLEXITY = /\*\*Complexity:\*\*/g;

/**
 * The item `id`'s block in `texts` (the queue files' contents, in the adapter's order).
 *
 * @param {string} id 0-N
 * @param {{ path: string, text: string }[]} texts
 * @returns {{ id: string, complexity: 'low' | 'medium' | 'high', block: string, file: string }}
 */
export function parseItem(id, texts) {
  const heading = `### ${id}. `;
  const found = [];
  for (const { path, text } of texts) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.startsWith(heading) && line.length > heading.length) {
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j].startsWith('### ') || lines[j].startsWith('## ')) {
            end = j;
            break;
          }
        }
        found.push({ file: path, block: lines.slice(i, end).join('\n') });
      }
    });
  }
  if (found.length !== 1) {
    throw new ItemError(found.length === 0 ? `the item ${id} is in no queue file of the adapter's`
      : `the item ${id} has ${found.length} headings in the queue files, not one`);
  }
  const [{ file, block }] = found;
  const all = block.match(ANY_COMPLEXITY) ?? [];
  const valid = [...block.matchAll(COMPLEXITY)];
  if (all.length !== 1 || valid.length !== 1) {
    throw new ItemError(`the item ${id} in ${file} has no single Complexity of low, medium or high`);
  }
  if (!block.split('\n').some((line) => /^AC[0-9]+\. /.test(line))) {
    throw new ItemError(`the item ${id} in ${file} has no acceptance criteria (no line AC<n>.)`);
  }
  return { id, complexity: valid[0][1], block, file };
}

/**
 * @param {{ repoDir: string, base: string, adapter: { queue: { files: string[] } }, id: string, git?: string }} options
 */
export async function readItem({ repoDir, base, adapter, id, git }) {
  if (adapter?.queue?.kind !== 'backlog-md') {
    // The one kind this parser reads (review round 1 of factory#26, 9).
    throw new ItemError('the adapter\'s queue is not of the kind backlog-md, the one the dispatcher reads');
  }
  const texts = [];
  for (const path of adapter.queue.files) {
    texts.push({ path, text: await blobOf({ repoDir, base, path, git, what: `the queue file ${path}` }) });
  }
  return parseItem(id, texts);
}
