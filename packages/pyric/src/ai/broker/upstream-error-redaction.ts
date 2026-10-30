/**
 * Masking an upstream Gemini error before it reaches a caller: the gemini
 * proxy relaying it to the browser (#1584), and the gemini engine throwing it
 * on the Node host for `hosted: true` (#1631). One definition serves both, so
 * the same server key cannot reach the same page masked by one route and in
 * plain text by the other. The dev server's terminal reads it too.
 *
 * An upstream or a gateway can quote the credential it was sent in any form:
 * in the URL (`?key=`, `&key=`, JSON-escaped or percent-encoded), in plain
 * text, or in an echoed header such as `x-goog-api-key` or
 * `Authorization: Bearer`. So the exact credentials the request carried are
 * removed, raw and percent-encoded, then `redactUrl` runs as a second pass
 * for any other credential parameter.
 *
 * A JSON body is masked value by value and serialized again, so the
 * browser engine still reads Gemini's own status and message. Text
 * redaction over the raw JSON could eat a closing quote and leave the
 * envelope unparseable.
 */
import { redactUrl } from './synthesizer.js';

const MASK = '***';

/** The forms a credential can appear in, longest first. */
function quotedForms(credential: string): string[] {
  const forms = new Set([encodeURIComponent(credential), credential]);
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * `text` with every credential in `credentials` removed, and every
 * credential URL parameter masked. For a string that is not a body, such as
 * one message or one header value.
 */
export function redactUpstreamText(text: string, credentials: readonly string[]): string {
  let masked = text;
  for (const credential of credentials) {
    for (const form of quotedForms(credential)) masked = masked.split(form).join(MASK);
  }
  return redactUrl(masked);
}

function redactValue(value: unknown, credentials: readonly string[]): unknown {
  if (typeof value === 'string') return redactUpstreamText(value, credentials);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, credentials));
  const isObject = value !== null && typeof value === 'object';
  if (!isObject) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [redactUpstreamText(key, credentials), redactValue(item, credentials)]);
  return Object.fromEntries(entries);
}

/** The JSON value `text` holds, or undefined when it is not JSON. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * `text` with every credential in `credentials` removed, and every
 * credential URL parameter masked. A JSON body stays JSON.
 */
export function redactUpstreamError(text: string, credentials: readonly string[]): string {
  const json = parseJson(text);
  if (json === undefined) return redactUpstreamText(text, credentials);
  return JSON.stringify(redactValue(json.value, credentials));
}
