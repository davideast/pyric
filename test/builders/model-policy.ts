/**
 * What the model forwarder lets through, and what it sends on. A builder's
 * claude reaches the forwarder at `ANTHROPIC_BASE_URL`, so every request it
 * makes arrives in origin form (`POST /v1/messages?beta=true`). The
 * forwarder passes on only the Messages API requests claude needs to work
 * (https://code.claude.com/docs/en/llm-gateway-protocol, "API formats"):
 *
 * - `POST /v1/messages`, with or without `?beta=true`;
 * - `POST /v1/messages/count_tokens`, likewise.
 *
 * Everything else is refused: a CONNECT, an absolute URI, any other method or
 * path or query, among them claude's `HEAD /api/hello` warm-up and its
 * `GET /v1/models` lookup, which the same page says a gateway may reject.
 *
 * On the way out the forwarder keeps only the builder's allowed headers and
 * sets its own `Authorization: Bearer <token>`, from the harness's
 * environment. `anthropic-version` and `anthropic-beta` go on as sent: the
 * OAuth capability claude declares for a subscription token is carried in
 * `anthropic-beta`, and the API answers 401 without it.
 */
import { isAbsoluteUri, type RequestHead } from './http-head.ts';
import type { BodyRefusalReason } from './message-body.ts';
import type { MeterRefusal } from './model-meter.ts';

export const MODEL_API_HOST = 'api.anthropic.com';

export const MESSAGES_PATHS: readonly string[] = ['/v1/messages', '/v1/messages/count_tokens'];
const ALLOWED_QUERIES: readonly string[] = ['', 'beta=true'];

/** Why the forwarder refused a request. Each is a `reason` in the run's network record. */
export type RefusalReason =
  | 'closed-before-head'
  | 'head-timeout'
  | 'head-too-long'
  | 'malformed'
  | 'connect'
  | 'absolute-uri'
  | 'method'
  | 'path'
  | 'framing'
  | 'body-malformed'
  | 'body-timeout'
  | 'closed-before-body'
  | 'no-credential'
  | BodyRefusalReason
  | MeterRefusal;

function splitTarget(target: string): { path: string; query: string } {
  const at = target.indexOf('?');
  if (at === -1) return { path: target, query: '' };
  return { path: target.slice(0, at), query: target.slice(at + 1) };
}

/** The reason a parsed request may not reach the model API, or undefined when it may. */
export function requestRefusal(head: RequestHead): RefusalReason | undefined {
  if (head.method === 'CONNECT') return 'connect';
  if (isAbsoluteUri(head.target)) return 'absolute-uri';
  if (head.method !== 'POST') return 'method';
  const { path, query } = splitTarget(head.target);
  const isMessagesRequest = MESSAGES_PATHS.includes(path) && ALLOWED_QUERIES.includes(query);
  return isMessagesRequest ? undefined : 'path';
}

/** The path of a request target, without its query, for the record. */
export const pathOf = (target: string) => splitTarget(target).path;

/**
 * The builder's headers that go on, by name. The gateway page's "Request
 * headers" names `anthropic-version`, `anthropic-beta` and the
 * `x-claude-code-*` session, agent and hint headers; the Anthropic SDK's
 * own `x-stainless-*` headers and the plain content headers go too.
 *
 * The same page asks gateways to pass every `anthropic-*` header rather than
 * an allowlist, so a capability a later Claude Code adds as a new header is
 * dropped here. Each request's line in the record names what was dropped.
 */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  'anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'user-agent',
  'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id',
  'x-claude-code-request-class', 'x-claude-code-agent-type', 'x-claude-code-compaction',
  'x-claude-code-context-compacted', 'x-claude-code-prev-tool-durations', 'x-claude-code-prompt-id',
]);
const ALLOWED_PREFIX = 'x-stainless-';

/** Headers the forwarder sets or frames itself, so dropping the builder's is no news. */
const REPLACED_HEADERS: ReadonlySet<string> = new Set(['host', 'authorization', 'content-length', 'transfer-encoding', 'accept-encoding', 'connection', 'keep-alive']);

const isAllowedHeader = (name: string) => ALLOWED_HEADERS.has(name) || name.startsWith(ALLOWED_PREFIX);

/** The names of the builder's headers that don't go on, for the record. Never their values. */
export function droppedHeaderNames(head: RequestHead): string[] {
  const names = head.headers.map(([name]) => name).filter((name) => !isAllowedHeader(name) && !REPLACED_HEADERS.has(name));
  return [...new Set(names)];
}

/**
 * The headers the forwarder sends to the model API: the builder's allowed
 * ones, plus the real credential, the API's host, the body's length, and
 * `identity`, so the forwarder can read the usage in the response.
 */
export function forwardedHeaders(head: RequestHead, credential: string, bodyLength: number): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of head.headers) {
    if (!isAllowedHeader(name)) continue;
    kept[name] = kept[name] === undefined ? value : `${kept[name]}, ${value}`;
  }
  return {
    ...kept,
    host: MODEL_API_HOST,
    authorization: `Bearer ${credential}`,
    'content-length': String(bodyLength),
    'accept-encoding': 'identity',
  };
}
