/**
 * Where a credential of the dispatcher may be sent (incident-platform backlog #0-271): an https:// URL, or plain
 * http:// to a loopback address, which only the tests' fake GitHub listens on. One list of loopback hosts and one
 * check, for the API that gets the app's JWT and for the push URL that gets builder-app's token.
 *
 * Since incident-platform backlog #0-273 it runs on the owner's host too: dispatcher/bin/dev-token.mjs checks its
 * --api with it, next to the dev app's key. A change here is a change of code that runs on the host, not only in the
 * dispatcher.
 */

/** The hostnames, as URL gives them, of a loopback address. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '[::1]', 'localhost']);

/**
 * The parsed URL, when it is https://, or http:// to a loopback address; throws otherwise. `what` names the URL in
 * the error ("the API", "a push URL").
 *
 * @param {string} url
 * @param {string} what
 * @returns {URL}
 */
export function requireHttpsOrLoopback(url, what) {
  const parsed = new URL(url);
  const loopback = LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${what} must be an https:// URL, not ${parsed.protocol}//${parsed.host}`);
  }
  return parsed;
}
