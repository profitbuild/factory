/**
 * Where a credential of the dispatcher may be sent (incident-platform backlog #0-271; since #0-276's review round 4,
 * one rule, pinnedOrLoopback): GitHub's own origin, or plain http:// to a loopback address, which only the tests'
 * fakes listen on. One list of loopback hosts and one check, for the API that gets the app's JWT and for the push
 * URL that gets builder-app's token.
 *
 * Since incident-platform backlog #0-273 it runs on the owner's host too: dispatcher/bin/dev-token.mjs checks its
 * --api with it, next to the dev app's key. A change here is a change of code that runs on the host, not only in the
 * dispatcher.
 */

/** The hostnames, as URL gives them, of a loopback address. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '[::1]', 'localhost']);

/** A host a credential would go to is not the one it may go to. */
export class HostRefusedError extends Error {}

/**
 * The one rule of a host a credential of the dispatcher goes to (incident-platform backlog #0-276, review round 4):
 * exactly `pinned`, an https:// origin (GitHub's API for the app's JWT and its tokens, GitHub for a push); or plain
 * http:// to a loopback origin, which only the tests' fakes listen on. No other host, HTTPS or not: an https:// URL
 * of any other host would be handed the JWT, or a token. `url` is an origin alone, as `pinned` is: no path, user,
 * password, query or fragment, and written as URL writes it (lower case, no default port).
 *
 * @param {string} url
 * @param {string} pinned
 * @param {string} what names the URL in a refusal ("the API", "--api", "the git host")
 * @returns {URL}
 * @throws {HostRefusedError}
 */
export function pinnedOrLoopback(url, pinned, what) {
  if (url === pinned) {
    return new URL(pinned);
  }
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    // refused below
  }
  if (!parsed || parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(parsed.hostname) || parsed.origin !== url) {
    throw new HostRefusedError(`${what} must be ${pinned}, or a test's http:// origin on a loopback address`);
  }
  return parsed;
}
