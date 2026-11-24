/**
 * What the proxy lets through to Anthropic of a request's body and betas (incident-platform backlog #0-313, review
 * round 1 of factory#29, sec-5a7e; the owner's decision (a)): an allowlist, not a denylist.
 *
 * A task's code holds the token (444 in its container) and Bash, and the proxy's address is fixed. Without this
 * check it could ask Anthropic to run a tool on Anthropic's side, web_search, web_fetch or an MCP connector
 * (mcp_servers), which reach any host from there: past the VM's filter and the managed settings' tools. So, before
 * anything goes upstream:
 *
 * - the body is held, to the proxy's BODY_LIMIT (a chunked body too), and parsed as JSON; it must be an object, no
 *   deeper than MAX_DEPTH anywhere and of no more than MAX_NODES arrays and objects (below);
 * - `messages` is an array of objects, each with a `content` that is a string or an array (review round 3 of
 *   factory#29: one that is no array was taken as empty, and passed);
 * - it has no key `mcp_servers`, whatever its value;
 * - each element of `tools`, if there is one (an array), is a client tool: an object with no `type`, or
 *   `type: "custom"`. Any other `type`, whatever its name or version, is refused;
 * - each object with a `source` key, in any content block of `messages` and of `system` (when it is a list), a
 *   tool_result's content among them, at any depth, has a source of type `base64` or `text`: Anthropic fetches a
 *   `url` source itself, and a `file` one is the workspace's, so any other type is refused (review round 2 of
 *   factory#29, sec-c41e); each block there is of a type of BLOCK_TYPES (review round 4: a block of any other type,
 *   one a beta might let define or change a tool in a message, never reaches Anthropic); and no object there has a
 *   `file_id` key (a container_upload block names a file of the
 *   workspace's with no source: harmless only while code execution, a server tool, is refused; review round 3);
 * - each comma-separated value of `anthropic-beta` is on the list measured from Claude Code's own calls
 *   (claude-code/expectations.json's anthropicBetas, re-measured at a version bump). Any other value refuses the
 *   request: it is not cut from the header.
 * A request refused is 400 invalid_request_error, X-Should-Retry false (server.mjs), counted in proxy.json under its
 * reason, and logged by that reason alone: never the body, a tool's name or type, or the header's value. Nothing of
 * it reaches upstream.
 *
 * The filter never throws, on any input of a client's (review round 3 of factory#29, sec-d3e7, a regression of
 * round 2). Round 2's walk of the content (a recursion) and JSON.stringify of the parsed body went down a tree the
 * task's code builds, with no bound: 200 KB of nested arrays (JSON.parse takes them) threw "Maximum call stack size
 * exceeded" after JSON.parse's try, the request's async handler left the rejection unhandled, and Node ended the
 * dispatcher without its finally blocks (the proxy not closed, the token not revoked, the task left running, its
 * container with no one to watch it). So, at each layer:
 *   1. the depth of the whole parsed body is measured first, iteratively (a stack of its own, not the call stack),
 *      every key included, and a body deeper than MAX_DEPTH is refused (reason depth) before anything else walks it or
 *      JSON.stringify serializes it; the content's walk is iterative too;
 *   2. filterRequest turns any exception at all into a refusal (reason invalid), logged by that reason alone, never by
 *      the exception's text, which could hold the body's;
 *   3. server.mjs's handler catches whatever is left, answers 500 in Anthropic's shape (or ends the socket once the
 *      headers went), and leaves no rejection: the process outlives any request.
 *
 * What goes upstream is what was checked: the parsed body, serialized again (JSON.stringify), so a key given twice or
 * bytes that are no UTF-8 cannot make Anthropic's parser see another body than this check did (review round 2 of
 * factory#29). The body is read only for this check: never logged, written or kept after the request. The response is
 * still streamed, never held (upstream.mjs). This reverses #0-313's first rule ("the body is never read"): the review
 * of factory#29 found that a body passed unread carries Anthropic's server tools, and content sources it fetches.
 */

/** The reasons of a refusal, as proxy.json counts them. */
export const FILTER_REASONS = Object.freeze(['body-not-json', 'body-not-object', 'depth', 'size', 'messages-form',
  'mcp-servers', 'tools-not-list', 'server-tool', 'content-type', 'content-source', 'content-file', 'beta', 'invalid']);

/**
 * The deepest a body may nest, the body itself one level, each array or object inside it one more (sec-d3e7). Claude
 * Code's calls are shallow: the owner's measurement (2026-11-24) shows message blocks four levels down (body,
 * messages, a message, its content), a tool_result's content two more, and a tool's input_schema, a JSON Schema,
 * some ten more at most. 64 is far above that, and far below what JSON.stringify's recursion, the one walk left on
 * the call stack, can take (V8's stack holds thousands of frames).
 */
export const MAX_DEPTH = 64;

/**
 * The most arrays and objects a body may hold (review round 4 of factory#29, SEC-21, measured by the owner: 32 MiB of
 * about 11 million empty arrays cost JSON.parse 1.6 s, a walk 1.5 s and about 1.57 GB of heap, the event loop stopped
 * some 3 s; on the VM, a lower heap limit would end the dispatcher out of memory: sec-d3e7's end by another road).
 * Claude Code's calls hold few: the fixture's two variants, built with an input_schema of one object per tool, hold 34
 * and 38 (a real tool's JSON Schema some tens more each, a long session's messages some thousands). 100 000 is far
 * above that, and far below what stops the loop or fills the heap: the walk of 100 000 nodes takes milliseconds and a
 * few MB. It is counted twice: on the bytes, before JSON.parse builds anything (byteShape), and on the parsed tree.
 */
export const MAX_NODES = 100_000;

/**
 * The content block types passed (review round 4 of factory#29, FAC-S02; an allowlist, as the whole filter): the two
 * measured variants of Claude Code 2.1.328's calls hold text blocks alone; the others are what Claude Code sends in
 * ordinary work: images and documents (base64 or text sources, SOURCES), its tools' calls and their results, and its
 * thinking. None runs anything on Anthropic's side. Any other type (server_tool_use, web_search_tool_result,
 * mcp_tool_use, container_upload, one a beta adds) is refused, so that no beta, such as one that changes tools in the
 * middle of a conversation, can carry a server tool in a message.
 */
export const BLOCK_TYPES = Object.freeze(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking',
  'redacted_thinking']);

/**
 * The arrays and objects of a JSON text, and its deepest nesting, counted on its bytes before JSON.parse builds
 * anything (review round 4 of factory#29): brackets outside strings, a string's escapes skipped. It stops at the
 * first bound passed. The text need not be valid JSON: JSON.parse refuses what this cannot judge.
 *
 * @param {Buffer} bytes
 * @returns {'depth' | 'size' | null}
 */
export function byteShape(bytes) {
  let nodes = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (b === 0x5c) {
        escaped = true;
      } else if (b === 0x22) {
        inString = false;
      }
    } else if (b === 0x22) {
      inString = true;
    } else if (b === 0x5b || b === 0x7b) {
      nodes += 1;
      depth += 1;
      if (depth > MAX_DEPTH) {
        return 'depth';
      }
      if (nodes > MAX_NODES) {
        return 'size';
      }
    } else if (b === 0x5d || b === 0x7d) {
      depth -= 1;
    }
  }
  return null;
}

/** The content sources passed: data the request carries, never one Anthropic fetches (sec-c41e). */
export const SOURCES = Object.freeze(['base64', 'text']);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Why `value` is past its bounds, or null: deeper than MAX_DEPTH (itself one level), or more than MAX_NODES arrays and
 * objects, walked with a stack of its own, every array and object under any key, in one pass. It stops at the first
 * bound passed, so a hostile tree is never walked whole.
 *
 * @returns {'depth' | 'size' | null}
 */
export function treeBounds(value) {
  const stack = [[value, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (typeof node !== 'object' || node === null) {
      continue;
    }
    if (depth > MAX_DEPTH) {
      return 'depth';
    }
    nodes += 1;
    if (nodes > MAX_NODES) {
      return 'size';
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (typeof child === 'object' && child !== null) {
        stack.push([child, depth + 1]);
      }
    }
  }
  return null;
}

/**
 * The reason `content` is refused, or null. A content is a string, or an array of blocks, each an object of a type of
 * BLOCK_TYPES; a block's own `content` (a tool_result's) is a content too, at any depth. Each block's `source`, if any,
 * must have a SOURCE type, and no block, nor its source, may have a `file_id`. Walked with a stack of its own.
 */
function contentRefusal(content) {
  const blocks = [];
  const take = (value) => {
    if (typeof value === 'string') {
      return true;
    }
    if (!Array.isArray(value)) {
      return false;
    }
    blocks.push(...value);
    return true;
  };
  if (!take(content)) {
    return 'content-type';
  }
  while (blocks.length > 0) {
    const node = blocks.pop();
    if (!isObject(node) || typeof node.type !== 'string' || !BLOCK_TYPES.includes(node.type)) {
      return 'content-type';
    }
    if (Object.hasOwn(node, 'source') && !(isObject(node.source) && SOURCES.includes(node.source.type))) {
      return 'content-source';
    }
    if (Object.hasOwn(node, 'file_id') || (isObject(node.source) && Object.hasOwn(node.source, 'file_id'))) {
      return 'content-file';
    }
    if (Object.hasOwn(node, 'content') && !take(node.content)) {
      return 'content-type';
    }
  }
  return null;
}

/**
 * `body` and `beta` checked: the reason they are refused, or null and the JSON to send upstream, the checked value's.
 *
 * @param {{ body: Buffer, beta: string | string[] | undefined, betas: readonly string[] }} request `beta` the request's
 *   anthropic-beta header (node joins a repeated one); `betas` the values allowed
 * @returns {{ reason: string | null, json: string | null }} `reason` one of FILTER_REASONS; never a throw
 */
export function filterRequest({ body, beta, betas }) {
  try {
    return checkRequest({ body, beta, betas });
  } catch {
    // Whatever the body made happen, a refusal, never an exception (sec-d3e7, layer 2): its text is not kept.
    return { reason: 'invalid', json: null };
  }
}

function checkRequest({ body, beta, betas }) {
  const refused = (reason) => ({ reason, json: null });
  if (beta !== undefined) {
    const values = (Array.isArray(beta) ? beta.join(',') : beta).split(',').map((value) => value.trim());
    if (!values.every((value) => value !== '' && betas.includes(value))) {
      return refused('beta');
    }
  }
  // The bounds on the bytes, before JSON.parse builds anything (review round 4 of factory#29, SEC-21).
  const bytes = byteShape(body);
  if (bytes !== null) {
    return refused(bytes);
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return refused('body-not-json');
  }
  if (!isObject(parsed)) {
    return refused('body-not-object');
  }
  // Before anything walks the body or serializes it (sec-d3e7, layer 1), whatever the bytes' count said.
  const tree = treeBounds(parsed);
  if (tree !== null) {
    return refused(tree);
  }
  const reason = refusalOf(parsed);
  return reason === null ? { reason: null, json: JSON.stringify(parsed) } : refused(reason);
}

/** The reason of filterRequest alone. */
export const requestRefusal = (request) => filterRequest(request).reason;

/** The reason a parsed body (an object) is refused, or null. */
function refusalOf(parsed) {
  if (Object.hasOwn(parsed, 'mcp_servers')) {
    return 'mcp-servers';
  }
  if (Object.hasOwn(parsed, 'tools')) {
    if (!Array.isArray(parsed.tools)) {
      return 'tools-not-list';
    }
    if (!parsed.tools.every((tool) => isObject(tool) && (!Object.hasOwn(tool, 'type') || tool.type === 'custom'))) {
      return 'server-tool';
    }
  }
  if (!Array.isArray(parsed.messages) || !parsed.messages.every((message) => isObject(message)
    && (typeof message.content === 'string' || Array.isArray(message.content)))) {
    return 'messages-form';
  }
  for (const content of [...parsed.messages.map((message) => message.content),
    ...(Array.isArray(parsed.system) ? [parsed.system] : [])]) {
    const reason = contentRefusal(content);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

/**
 * The request's body, held to `limit` bytes as it comes (a chunked one too): its bytes, or 'too-large' once past the
 * limit (the rest is not read), or 'aborted' when the client goes.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer | 'too-large' | 'aborted'>}
 */
export function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        chunks.length = 0;
        finish('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('aborted', () => finish('aborted'));
    req.on('error', () => finish('aborted'));
    req.on('close', () => finish(req.complete ? Buffer.concat(chunks) : 'aborted'));
  });
}
