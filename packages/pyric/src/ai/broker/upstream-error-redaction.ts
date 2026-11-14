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
const SCHEME_PREFIX = /^(\s*[a-z][a-z0-9+.-]*:[/\\]*)/i;

/** Whether `port` is empty or an integer in `0..65535`. */
function isValidPort(port: string): boolean {
  if (port === '') return true;
  if (!/^\d{1,5}$/.test(port)) return false;
  const value = Number(port);
  return value >= 0 && value <= 65535;
}

/** Whether `hostPort` has the lexical shape of a URL authority's `host[:port]`. */
function isValidHostPort(hostPort: string): boolean {
  if (hostPort === '') return false;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close <= 1) return false;
    const rest = hostPort.slice(close + 1);
    if (rest === '') return true;
    if (!rest.startsWith(':')) return false;
    return isValidPort(rest.slice(1));
  }
  const colon = hostPort.indexOf(':');
  const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
  const port = colon < 0 ? '' : hostPort.slice(colon + 1);
  if (colon >= 0 && port.includes(':')) return false;
  if (host === '' || /[\s/\\?#"'\[\]@]/.test(host)) return false;
  return isValidPort(port);
}

/**
 * Whether `hostPort` names a network endpoint (IPv6 literal, `localhost`,
 * dotted hostname/IPv4, or explicit `:port`), distinguishing `@host` after an
 * unencoded delimiter in userinfo from `@domain` inside a query parameter.
 */
function isNetworkHostPort(hostPort: string): boolean {
  if (!isValidHostPort(hostPort)) return false;
  if (hostPort.startsWith('[')) return true;
  const colon = hostPort.indexOf(':');
  const host = (colon < 0 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
  const hasExplicitPort = colon >= 0 && colon < hostPort.length - 1;
  return host === 'localhost' || host.includes('.') || hasExplicitPort;
}

/**
 * Whether an `@`-free authority prefix is already the URL's `host[:port]`
 * rather than the leading slice of userinfo interrupted by `/`, `?`, `#` or `\`.
 */
function authorityLooksLikeHostWithoutUserinfo(authorityPrefix: string): boolean {
  if (authorityPrefix === '' || authorityPrefix.endsWith(':')) return false;
  if (authorityPrefix.startsWith('[')) return authorityPrefix.indexOf(']') > 1;
  const colon = authorityPrefix.indexOf(':');
  const host = (colon < 0 ? authorityPrefix : authorityPrefix.slice(0, colon)).toLowerCase();
  const port = colon < 0 ? undefined : authorityPrefix.slice(colon + 1);
  const isIpOrLocalhost = host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (isIpOrLocalhost) return true;
  return host.includes('.') && (port === undefined || isValidPort(port));
}

interface LocatedUserinfo {
  schemePrefix: string;
  rawUserinfo: string;
  afterAt: string;
}

/**
 * Locate the authority userinfo of `url`, even when an unencoded `/`, `?`, `#`
 * or `\` inside the username or password makes `new URL(url)` fail or misread
 * the prefix before the delimiter as `host[:port]`, without mistaking an `@`
 * in the path or query string for userinfo (#1766).
 */
function locateUserinfo(url: string): LocatedUserinfo | undefined {
  const match = SCHEME_PREFIX.exec(url);
  if (match === null) return undefined;
  const schemePrefix = match[1]!;
  const rest = url.slice(schemePrefix.length);
  if (!rest.includes('@')) return undefined;
  const authorityPrefix = rest.split(/[/\\?#]/, 1)[0] ?? '';

  if (authorityPrefix.includes('@')) {
    const at = authorityPrefix.lastIndexOf('@');
    const hostAfterAt = authorityPrefix.slice(at + 1);
    const hasLaterAt = rest.slice(authorityPrefix.length).includes('@');
    if (isValidHostPort(hostAfterAt) || !hasLaterAt) {
      return {
        schemePrefix,
        rawUserinfo: authorityPrefix.slice(0, at),
        afterAt: rest.slice(at + 1),
      };
    }
  } else if (authorityLooksLikeHostWithoutUserinfo(authorityPrefix)) {
    return undefined;
  }

  let fallback: LocatedUserinfo | undefined;
  for (let at = rest.indexOf('@'); at >= 0; at = rest.indexOf('@', at + 1)) {
    const afterAt = rest.slice(at + 1);
    const candidateHost = afterAt.split(/[/\\?#]/, 1)[0] ?? '';
    if (isNetworkHostPort(candidateHost)) {
      return { schemePrefix, rawUserinfo: rest.slice(0, at), afterAt };
    }
    if (fallback === undefined && isValidHostPort(candidateHost)) {
      fallback = { schemePrefix, rawUserinfo: rest.slice(0, at), afterAt };
    }
  }
  return fallback;
}

/** `user:password` split at its first colon, without empty parts. */
function userinfoParts(userinfo: string): string[] {
  const colon = userinfo.indexOf(':');
  const parts = colon < 0 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)];
  return parts.filter((part) => part !== '');
}

/** Non-empty username/password as WHATWG `URL` percent-encodes them, when `url` parses. */
function parsedAuthorityUserinfo(url: string): string[] {
  try {
    const parsed = new URL(url);
    return [parsed.username, parsed.password].filter((part) => part !== '');
  } catch {
    return [];
  }
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return '';
  let out = '';
  let i = 0;
  while (i + 2 < bytes.length) {
    const triple = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64_ALPHABET[(triple >> 18) & 63]!;
    out += BASE64_ALPHABET[(triple >> 12) & 63]!;
    out += BASE64_ALPHABET[(triple >> 6) & 63]!;
    out += BASE64_ALPHABET[triple & 63]!;
    i += 3;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const single = bytes[i]! << 16;
    out += BASE64_ALPHABET[(single >> 18) & 63]!;
    out += BASE64_ALPHABET[(single >> 12) & 63]!;
    out += '==';
  } else if (remaining === 2) {
    const pair = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += BASE64_ALPHABET[(pair >> 18) & 63]!;
    out += BASE64_ALPHABET[(pair >> 12) & 63]!;
    out += BASE64_ALPHABET[(pair >> 6) & 63]!;
    out += '=';
  }
  return out;
}

function synthesizedBasicTokens(url: string, rawUserinfo: string): string[] {
  const tokens: string[] = [];
  const colon = rawUserinfo.indexOf(':');
  let rawUser = rawUserinfo;
  let rawPass = '';
  if (colon >= 0) {
    rawUser = rawUserinfo.slice(0, colon);
    rawPass = rawUserinfo.slice(colon + 1);
  }
  if (rawUser !== '' || rawPass !== '') {
    tokens.push(encodeUtf8Base64(`${decoded(rawUser)}:${decoded(rawPass)}`));
    tokens.push(encodeUtf8Base64(`${rawUser}:${rawPass}`));
  }
  try {
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') {
      tokens.push(encodeUtf8Base64(`${decoded(parsed.username)}:${decoded(parsed.password)}`));
    }
  } catch {
    // Malformed authority userinfo already covered above.
  }
  return tokens.filter((token) => token !== '');
}

/**
 * The username, password, and synthesized Basic-auth token an upstream URL
 * carries, as written, percent-encoded and percent-decoded, for the
 * exact-string masking {@link redactUpstreamText} applies (#1766).
 */
export function urlCredentials(url: string): string[] {
  const located = locateUserinfo(url);
  if (located === undefined) return [];
  const parts = [
    located.rawUserinfo,
    ...userinfoParts(located.rawUserinfo),
    ...parsedAuthorityUserinfo(url),
  ].filter((part) => part !== '');
  const expanded = parts.flatMap((part) => [part, decoded(part)]);
  expanded.push(...synthesizedBasicTokens(url, located.rawUserinfo));
  return [...new Set(expanded)];
}

/** `url` as it is shown: without its userinfo, and with credential parameters masked. */
export function redactUpstreamUrl(url: string): string {
  const located = locateUserinfo(url);
  const withoutUserinfo = located === undefined ? url : `${located.schemePrefix}${located.afterAt}`;
  return redactUrl(withoutUserinfo);
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

function isJsonErrorEvent(data: string): boolean {
  try {
    const value = JSON.parse(data) as unknown;
    return value !== null && typeof value === 'object' && 'error' in value;
  } catch {
    return false;
  }
}

function maskSseLine(
  line: string,
  credentials: readonly string[],
  state: { eventIsError: boolean },
): string {
  const carriageReturn = line.endsWith('\r') ? '\r' : '';
  const body = line.slice(0, line.length - carriageReturn.length);
  if (body === '') {
    state.eventIsError = false;
    return line;
  }
  if (/^event:\s*error$/i.test(body)) {
    state.eventIsError = true;
    return line;
  }
  const prefix = /^data: ?/.exec(body)?.[0];
  if (prefix === undefined) return line;
  const data = body.slice(prefix.length);
  if (!state.eventIsError && !isJsonErrorEvent(data)) return line;
  return `${prefix}${redactUpstreamError(data, credentials)}${carriageReturn}`;
}

/**
 * Wraps an SSE `2xx` byte stream so any error event (`data: {"error": ...}` or
 * `event: error`) has its credentials masked before reaching the caller, while
 * streaming complete lines immediately in linear time without buffering.
 */
export function maskStreamErrors(
  body: ReadableStream<Uint8Array>,
  credentials: readonly string[],
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = { eventIsError: false };
  let pending = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        const arrived = decoder.decode(bytes, { stream: true });
        const lastNewline = arrived.lastIndexOf('\n');
        if (lastNewline === -1) {
          pending += arrived;
          return;
        }
        const lines = (pending + arrived.slice(0, lastNewline)).split('\n');
        pending = arrived.slice(lastNewline + 1);
        const masked = lines.map((line) => `${maskSseLine(line, credentials, state)}\n`).join('');
        controller.enqueue(encoder.encode(masked));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending !== '') {
          controller.enqueue(encoder.encode(maskSseLine(pending, credentials, state)));
        }
      },
    }),
  );
}
