/**
 * What the proxy lets through to Anthropic of a request's body and betas (incident-platform backlog #0-313, review
 * round 1 of factory#29, sec-5a7e; the owner's decision (a)): an allowlist, not a denylist.
 *
 * A task's code holds the token (444 in its container) and Bash, and the proxy's address is fixed. Without this
 * check it could ask Anthropic to run a tool on Anthropic's side, web_search, web_fetch or an MCP connector
 * (mcp_servers), which reach any host from there: past the VM's filter and the managed settings' tools. So, before
 * anything goes upstream:
 *
 * - the body is held, to the proxy's BODY_LIMIT (a chunked body too), and parsed as JSON; it must be an object;
 * - it has no key `mcp_servers`, whatever its value;
 * - each element of `tools`, if there is one (an array), is a client tool: an object with no `type`, or
 *   `type: "custom"`. Any other `type`, whatever its name or version, is refused;
 * - each object with a `source` key, in any content block of `messages` and of `system` (when it is a list), a
 *   tool_result's content among them, at any depth, has a source of type `base64` or `text`: Anthropic fetches a
 *   `url` source itself, and a `file` one is the workspace's, so any other type is refused (review round 2 of
 *   factory#29, sec-c41e);
 * - each comma-separated value of `anthropic-beta` is on the list measured from Claude Code's own calls
 *   (claude-code/expectations.json's anthropicBetas, re-measured at a version bump). Any other value refuses the
 *   request: it is not cut from the header.
 * A request refused is 400 invalid_request_error, X-Should-Retry false (server.mjs), counted in proxy.json under its
 * reason, and logged by that reason alone: never the body, a tool's name or type, or the header's value. Nothing of
 * it reaches upstream.
 *
 * What goes upstream is what was checked: the parsed body, serialized again (JSON.stringify), so a key given twice or
 * bytes that are no UTF-8 cannot make Anthropic's parser see another body than this check did (review round 2 of
 * factory#29). The body is read only for this check: never logged, written or kept after the request. The response is
 * still streamed, never held (upstream.mjs). This reverses #0-313's first rule ("the body is never read"): the review
 * of factory#29 found that a body passed unread carries Anthropic's server tools, and content sources it fetches.
 */

/** The reasons of a refusal, as proxy.json counts them. */
export const FILTER_REASONS = Object.freeze(['body-not-json', 'body-not-object', 'mcp-servers', 'tools-not-list',
  'server-tool', 'content-source', 'beta']);

/** The content sources passed: data the request carries, never one Anthropic fetches (sec-c41e). */
export const SOURCES = Object.freeze(['base64', 'text']);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether each object with a `source` key in `content` (a block list, or any value), at any depth, has a SOURCE. */
function sourcesAllowed(content) {
  if (Array.isArray(content)) {
    return content.every(sourcesAllowed);
  }
  if (!isObject(content)) {
    return true;
  }
  if (Object.hasOwn(content, 'source') && !(isObject(content.source) && SOURCES.includes(content.source.type))) {
    return false;
  }
  return !Object.hasOwn(content, 'content') || sourcesAllowed(content.content);
}

/**
 * `body` and `beta` checked: the reason they are refused, or null and the JSON to send upstream, the checked value's.
 *
 * @param {{ body: Buffer, beta: string | string[] | undefined, betas: readonly string[] }} request `beta` the request's
 *   anthropic-beta header (node joins a repeated one); `betas` the values allowed
 * @returns {{ reason: string | null, json: string | null }} `reason` one of FILTER_REASONS
 */
export function filterRequest({ body, beta, betas }) {
  const refused = (reason) => ({ reason, json: null });
  if (beta !== undefined) {
    const values = (Array.isArray(beta) ? beta.join(',') : beta).split(',').map((value) => value.trim());
    if (!values.every((value) => value !== '' && betas.includes(value))) {
      return refused('beta');
    }
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
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (!messages.every((message) => !isObject(message) || sourcesAllowed(message.content))
    || (Array.isArray(parsed.system) && !sourcesAllowed(parsed.system))) {
    return 'content-source';
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
