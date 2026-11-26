import { redactUpstreamSuccessBody, urlCredentials } from 'pyric/ai/internal';

/**
 * Explicit allowlist of OpenAI-compatible POST path suffixes accepted under
 * `/__pyric/ai-proxy`. Empty string allows direct POST to a fully-qualified
 * configured `aiProxyUpstream` endpoint URL.
 */
const ALLOWED_AI_PROXY_SUFFIXES: ReadonlySet<string> = new Set([
  '',
  '/chat/completions',
  '/completions',
  '/embeddings',
  '/responses',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/responses',
]);

const DISALLOWED_SUFFIX_CHARS_RE = /[%\\@?#\s\x00-\x1f\x7f]|[^\x20-\x7e]/;

export type AiProxyPathValidation =
  | { readonly ok: true; readonly suffix: string }
  | { readonly ok: false; readonly status: 400 | 404; readonly message: string };

function extractRawPathname(rawRequestUrl: string | undefined): string | undefined {
  if (rawRequestUrl === undefined || rawRequestUrl === '') return undefined;
  let pathPart = rawRequestUrl;
  const queryAt = pathPart.indexOf('?');
  if (queryAt !== -1) pathPart = pathPart.slice(0, queryAt);
  const hashAt = pathPart.indexOf('#');
  if (hashAt !== -1) pathPart = pathPart.slice(0, hashAt);
  if (/^https?:\/\//i.test(pathPart)) {
    const schemeEnd = pathPart.indexOf('://');
    const firstSlash = pathPart.indexOf('/', schemeEnd + 3);
    if (firstSlash === -1) return '/';
    return pathPart.slice(firstSlash);
  }
  return pathPart;
}

function hasUnsafeSuffixSyntax(suffix: string): boolean {
  if (suffix === '') return false;
  if (!suffix.startsWith('/')) return true;
  if (suffix.includes('//')) return true;
  if (DISALLOWED_SUFFIX_CHARS_RE.test(suffix)) return true;
  const segments = suffix.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return true;
    }
  }
  return false;
}

/**
 * Validate and normalize the path suffix after `routePrefix` (`/__pyric/ai-proxy`).
 *
 * Inspects both the raw `req.url` path (before WHATWG `URL` dot-segment
 * normalization) and the parsed `url.pathname`, rejecting traversal segments
 * (`..`, `.`), percent-encoded sequences (`%2e`, `%2f`, `%5c`, `%00`),
 * backslashes, double slashes, control/non-ASCII chars, and disallowed
 * non-OpenAI endpoint suffixes.
 */
export function validateAiProxyPathSuffix(
  rawRequestUrl: string | undefined,
  parsedPathname: string,
  routePrefix: string,
): AiProxyPathValidation {
  if (parsedPathname !== routePrefix && !parsedPathname.startsWith(`${routePrefix}/`)) {
    return {
      ok: false,
      status: 400,
      message: 'pyric dev ai-proxy: invalid upstream path suffix.',
    };
  }
  const parsedSuffix = parsedPathname.slice(routePrefix.length);
  if (hasUnsafeSuffixSyntax(parsedSuffix)) {
    return {
      ok: false,
      status: 400,
      message: 'pyric dev ai-proxy: invalid upstream path suffix.',
    };
  }

  const rawPathname = extractRawPathname(rawRequestUrl);
  if (rawPathname !== undefined) {
    const matchesPrefix =
      rawPathname === routePrefix || rawPathname.startsWith(`${routePrefix}/`);
    if (!matchesPrefix) {
      return {
        ok: false,
        status: 400,
        message: 'pyric dev ai-proxy: invalid upstream path suffix.',
      };
    }
    const rawSuffix = rawPathname.slice(routePrefix.length);
    if (hasUnsafeSuffixSyntax(rawSuffix) || rawSuffix !== parsedSuffix) {
      return {
        ok: false,
        status: 400,
        message: 'pyric dev ai-proxy: invalid upstream path suffix.',
      };
    }
  }

  if (!ALLOWED_AI_PROXY_SUFFIXES.has(parsedSuffix)) {
    return {
      ok: false,
      status: 404,
      message: 'pyric dev ai-proxy: unsupported endpoint path.',
    };
  }
  return { ok: true, suffix: parsedSuffix };
}

/**
 * Defense-in-depth check ensuring a joined upstream URL stays on the exact
 * configured `upstreamBase` origin and path prefix whenever both URLs parse
 * cleanly (leaving intentionally malformed `#1766` base URLs to `fetchAiUpstream`'s
 * redacted error path).
 */
export function verifyJoinedUpstreamTarget(
  upstreamBase: string,
  target: string,
  suffix: string,
): boolean {
  let baseUrl: URL;
  let targetUrl: URL;
  try {
    baseUrl = new URL(upstreamBase);
    targetUrl = new URL(target);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return true;
  }
  if (targetUrl.origin !== baseUrl.origin) return false;
  const normalizedBasePath = baseUrl.pathname.replace(/\/+$/, '');
  const expectedPath = `${normalizedBasePath}${suffix}` || '/';
  return targetUrl.pathname === expectedPath;
}

/** True when an upstream HTTP status code is a `3xx` redirect. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** True when a `2xx` non-SSE response body carries text or JSON that may echo credentials. */
export function isTextLikeAiContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (lower === '') return true;
  if (lower.includes('json')) return true;
  if (lower.startsWith('text/')) return true;
  if (lower.includes('xml')) return true;
  return false;
}

function maskSseEventText(eventText: string, credentials: readonly string[]): string {
  if (eventText === '') return '';
  return redactUpstreamSuccessBody(eventText, credentials, { maskExactCredentials: true });
}

function drainSseExactCredentialEvents(
  buffer: string,
  eventParts: string[],
  credentials: readonly string[],
): { out: string; pending: string } {
  let out = '';
  let start = 0;
  let index = 0;
  while (index < buffer.length) {
    const ch = buffer.charAt(index);
    if (ch === '\r') {
      if (index + 1 === buffer.length) {
        break;
      }
      const isCrLf = buffer.charAt(index + 1) === '\n';
      const terminator = isCrLf ? '\r\n' : '\r';
      const raw = buffer.slice(start, index);
      index += isCrLf ? 2 : 1;
      start = index;
      if (raw === '') {
        out += `${maskSseEventText(eventParts.join(''), credentials)}${terminator}`;
        eventParts.length = 0;
      } else {
        eventParts.push(`${raw}${terminator}`);
      }
      continue;
    }
    if (ch === '\n') {
      const raw = buffer.slice(start, index);
      index += 1;
      start = index;
      if (raw === '') {
        out += `${maskSseEventText(eventParts.join(''), credentials)}\n`;
        eventParts.length = 0;
      } else {
        eventParts.push(`${raw}\n`);
      }
      continue;
    }
    index += 1;
  }
  return { out, pending: buffer.slice(start) };
}

/**
 * Incrementally redact exact/transformed credentials across every SSE event
 * (normal JSON chunks, plain non-JSON lines, and error events), flushing each
 * event as soon as its terminating blank line arrives without cross-event
 * buffering.
 */
export function maskSseExactCredentials(
  body: ReadableStream<Uint8Array>,
  credentials: readonly string[],
): ReadableStream<Uint8Array> {
  if (credentials.length === 0) return body;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const eventParts: string[] = [];
  let pending = '';

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        const arrived = decoder.decode(bytes, { stream: true });
        if (arrived.length === 0) return;
        const hasLineBreak = arrived.includes('\n') || arrived.includes('\r');
        const pendingEndsWithCr = pending.endsWith('\r');
        if (!hasLineBreak && !pendingEndsWithCr) {
          pending += arrived;
          return;
        }
        const drained = drainSseExactCredentialEvents(pending + arrived, eventParts, credentials);
        pending = drained.pending;
        if (drained.out !== '') {
          controller.enqueue(encoder.encode(drained.out));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        let out = '';
        if (pending !== '') {
          const drained = drainSseExactCredentialEvents(pending, eventParts, credentials);
          out += drained.out;
          pending = drained.pending;
        }
        if (pending !== '') {
          if (pending === '\r') {
            out += `${maskSseEventText(eventParts.join(''), credentials)}\r`;
            eventParts.length = 0;
          } else {
            eventParts.push(pending);
          }
          pending = '';
        }
        if (eventParts.length > 0) {
          out += maskSseEventText(eventParts.join(''), credentials);
          eventParts.length = 0;
        }
        if (out !== '') {
          controller.enqueue(encoder.encode(out));
        }
      },
    }),
  );
}

function headerEntries(headers: HeadersInit | undefined): Array<[string, string]> {
  if (headers === undefined) return [];
  if (headers instanceof Headers) {
    return [...headers.entries()].map(([name, value]) => [name.toLowerCase(), value]);
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  }
  return Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]);
}

function headerValue(entries: Array<[string, string]>, name: string): string | null {
  return entries.find(([entryName]) => entryName === name)?.[1] ?? null;
}

/**
 * The credentials an upstream request carries: the `key` URL parameter, the
 * `x-goog-api-key` / `x-api-key` / `api-key` headers, the `Authorization`
 * value without its scheme, and the URL's username and password (#1766).
 */
export function requestCredentials(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): string[] {
  const isRequest = input instanceof Request;
  const entries = headerEntries(isRequest ? input.headers : init?.headers);
  const url = isRequest ? input.url : String(input);
  const authorization = headerValue(entries, 'authorization')?.replace(/^\S+\s+/, '') ?? null;
  const found = [
    headerValue(entries, 'x-goog-api-key'),
    headerValue(entries, 'x-api-key'),
    headerValue(entries, 'api-key'),
    authorization,
    ...urlCredentials(url),
  ];
  return found.filter((value): value is string => value !== null && value !== '');
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return value;
  }
}

/**
 * Strip URL userinfo before invoking `fetch` (Node/Undici rejects URLs with
 * embedded credentials) and forward it as an `Authorization: Basic` header.
 */
export function stripFetchUserinfo(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): {
  fetchInput: Parameters<typeof fetch>[0];
  fetchInit: RequestInit | undefined;
  extraCredentials: string[];
} {
  if (input instanceof Request) {
    return { fetchInput: input, fetchInit: init, extraCredentials: [] };
  }
  let parsed: URL;
  try {
    parsed = new URL(String(input));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { fetchInput: input, fetchInit: init, extraCredentials: [] };
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    (parsed.username === '' && parsed.password === '')
  ) {
    return { fetchInput: input, fetchInit: init, extraCredentials: [] };
  }
  const decodedUser = safeDecodeURIComponent(parsed.username);
  const decodedPass = safeDecodeURIComponent(parsed.password);
  const basicToken = Buffer.from(`${decodedUser}:${decodedPass}`, 'utf8').toString('base64');
  parsed.username = '';
  parsed.password = '';
  const entries = headerEntries(init?.headers);
  const hasAuthorization = headerValue(entries, 'authorization') !== null;
  let nextHeaders: HeadersInit | undefined = init?.headers;
  if (!hasAuthorization) {
    if (init?.headers instanceof Headers) {
      const clone = new Headers(init.headers);
      clone.set('authorization', `Basic ${basicToken}`);
      nextHeaders = clone;
    } else if (Array.isArray(init?.headers)) {
      nextHeaders = [...init.headers, ['authorization', `Basic ${basicToken}`]];
    } else {
      nextHeaders = {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        authorization: `Basic ${basicToken}`,
      };
    }
  }
  const nextInit: RequestInit = {};
  if (init !== undefined) Object.assign(nextInit, init);
  if (nextHeaders !== undefined) nextInit.headers = nextHeaders;
  return {
    fetchInput: parsed.toString(),
    fetchInit: nextInit,
    extraCredentials: [basicToken],
  };
}
