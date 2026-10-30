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
 * On the way out the forwarder drops the builder's credential headers and
 * sets its own `Authorization: Bearer <token>`, from the harness's
 * environment. `anthropic-version` and `anthropic-beta` go on as sent: the
 * OAuth capability claude declares for a subscription token is carried in
 * `anthropic-beta`, and the API answers 401 without it.
 */
import { headerValues, isAbsoluteUri, type RequestHead } from './http-head.ts';

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
  | 'run-cap'
  | 'round-cap';

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

/** Fields that describe one hop, the builder's credentials, and what the forwarder sets itself. */
const DROPPED = new Set([
  'authorization', 'x-api-key', 'proxy-authorization', 'cookie',
  'host', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'content-length', 'accept-encoding', 'expect',
]);

/**
 * The headers the forwarder sends to the model API: the builder's, less the
 * dropped ones and any the builder named in `Connection`, plus the real
 * credential, the API's host, the body's length, and `identity`, so the
 * forwarder can read the usage in the response.
 */
export function forwardedHeaders(head: RequestHead, credential: string, bodyLength: number): Record<string, string> {
  const named = new Set(headerValues(head, 'connection').flatMap((value) => value.split(',')).map((name) => name.trim().toLowerCase()));
  const kept: Record<string, string> = {};
  for (const [name, value] of head.headers) {
    if (DROPPED.has(name) || named.has(name)) continue;
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
