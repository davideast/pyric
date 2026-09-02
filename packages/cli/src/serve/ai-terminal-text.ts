/**
 * Terminal-safe rendering of remote-authored text.
 *
 * Every AI diagnostic the dev server prints quotes a string somebody else
 * wrote: a broker rejection reason, a model server's finish message, a
 * `Retry-After` header, a model id out of a project config. The terminal is
 * not a sandbox, so that text is flattened onto one line, stripped of control
 * and bidi characters (the same treatment `activity-warning.ts` gives incident
 * text), and cut to a fixed length. Without the cut, one field of a remote
 * payload can push the rest of a diagnostic block off the screen.
 *
 * Leaf module: it imports nothing, so the browser-side diagnostics relay can
 * share it without pulling the dev server's formatting code into a served
 * bundle. Credential masking is a separate concern and comes from
 * `pyric/ai/internal`, which publishes the broker's own `redactUrl`.
 */

/**
 * Longest remote-authored string echoed into one terminal field, and the
 * longest one the browser-side relay puts on the wire. Broker rejection
 * reasons run to a few hundred characters at most, so anything past this is
 * an upstream dumping a payload into a message field.
 */
export const AI_TERMINAL_TEXT_MAX = 512;

/** Appended when text is cut, so a truncated line never reads as complete. */
const TRUNCATION_MARKER = '\u2026';

/** Cut text to {@link AI_TERMINAL_TEXT_MAX}, marking the cut. */
export function capTerminalText(text: string): string {
  if (text.length <= AI_TERMINAL_TEXT_MAX) return text;
  return `${text.slice(0, AI_TERMINAL_TEXT_MAX)}${TRUNCATION_MARKER}`;
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
  const flattened = text.replace(TERMINAL_UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return capTerminalText(flattened);
}
