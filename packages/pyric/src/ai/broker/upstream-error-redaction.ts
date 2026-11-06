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

/**
 * Every form every credential can appear in, raw and percent-encoded,
 * longest first. One credential can contain another, such as an ADC token
 * and the refreshed token that extends it, so the longer is masked first:
 * masking the shorter first would leave the rest of the longer behind.
 */
function quotedForms(credentials: readonly string[]): string[] {
  const forms = new Set(credentials.flatMap((credential) => [encodeURIComponent(credential), credential]));
  return [...forms].sort((a, b) => b.length - a.length);
}

/** A URL's scheme and the slashes after it, forward or back, any count. */
const SCHEME_PREFIX = /^\s*[a-z][a-z0-9+.-]*:[/\\]*/i;

/** `user:password` split at its first colon, without empty parts. */
function userinfoParts(userinfo: string): string[] {
  const colon = userinfo.indexOf(':');
  const parts = colon < 0 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)];
  return parts.filter((part) => part !== '');
}

/** The userinfo of `url` read as text: everything before the last `@` after the scheme. */
function splitUserinfo(url: string): string[] {
  const rest = url.replace(SCHEME_PREFIX, '');
  const at = rest.lastIndexOf('@');
  if (at < 0) return [];
  return userinfoParts(rest.slice(0, at));
}

/** The userinfo of `url` as a URL parser reads it, or undefined when it rejects `url`. */
function parsedUserinfo(url: string): { parts: string[]; raw: string[] } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const parts = [parsed.username, parsed.password].filter((part) => part !== '');
  if (parts.length === 0) return { parts, raw: [] };
  // The authority as written, so a character the parser percent-encodes is masked raw too.
  const authority = url.replace(SCHEME_PREFIX, '').split(/[/\\?#]/, 1)[0] ?? '';
  return { parts, raw: splitUserinfo(authority) };
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The username and password an upstream base URL carries, as written,
 * percent-encoded and percent-decoded, for the exact-string masking
 * {@link redactUpstreamText} applies (#1766). A URL the parser rejects, such
 * as a password with an unencoded `/`, `#`, `?` or `\`, is split on the last
 * `@` after its scheme instead: fetch quotes such a URL whole in its error.
 */
export function urlCredentials(url: string): string[] {
  const parsed = parsedUserinfo(url);
  const parts = parsed === undefined ? splitUserinfo(url) : [...parsed.parts, ...parsed.raw];
  return [...new Set(parts.flatMap((part) => [part, decoded(part)]))];
}

/** `url` as it is shown: without its userinfo, and with credential parameters masked. */
export function redactUpstreamUrl(url: string): string {
  return redactUpstreamText(url, urlCredentials(url));
}

/**
 * `text` with every credential in `credentials` removed, and every
 * credential URL parameter masked. For a string that is not a body, such as
 * one message or one header value.
 */
export function redactUpstreamText(text: string, credentials: readonly string[]): string {
  let masked = text;
  for (const form of quotedForms(credentials)) masked = masked.split(form).join(MASK);
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
