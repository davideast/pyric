/**
 * Terminal-safe rendering of remote-authored text.
 *
 * Every AI diagnostic the dev server prints quotes a string somebody else
 * wrote: a broker rejection reason, a model server's finish message, a
 * `Retry-After` header, a model id out of a project config. The terminal is
 * not a sandbox, so that text is flattened onto one line and stripped of
 * control and bidi characters, the same treatment `activity-warning.ts` gives
 * incident text.
 *
 * Leaf module: it imports nothing, so the browser-side diagnostics relay can
 * share it without pulling the dev server's formatting code into a served
 * bundle.
 */

/**
 * Credential-bearing query-string params masked before an upstream URL (or a
 * raw fetch error embedding one) reaches the terminal.
 *
 * Replicated, deliberately, from `redactUrl` in
 * `packages/pyric/src/ai/broker/synthesizer.ts`: that helper is internal to
 * the broker (re-exported only from `ai/broker/index.ts`) and `pyric`'s
 * package `exports` map publishes no subpath that reaches it, so the CLI
 * cannot import it across the package boundary. Keep the two in sync.
 */
const SENSITIVE_URL_PARAM = /([?&](?:key|apiKey|api_key|access_token)=)[^&\s]*/gi;

/** Mask credential VALUES, keeping host + path readable for diagnosis. */
export function redactProxyUrl(text: string): string {
  return text.replace(SENSITIVE_URL_PARAM, '$1***');
}

/** Control, bidi-override, and line-separator characters. A remote string
 *  carrying these can forge a terminal line or reverse the text around it. */
const TERMINAL_UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Flatten an upstream-authored string into ONE terminal-safe line.
 *
 * Broker rejection reasons are production's own messages, and several are
 * multi-line (`ai-error-empty-contents` is a bulleted list): pasted verbatim
 * they shred the indented block into fragments. Control and bidi characters
 * get dropped for the same reason `activity-warning.ts` drops them: the text
 * can originate from a remote model server, and the terminal is not a sandbox.
 */
export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}
