/**
 * What the Codex forwarder passes on, and what it puts on a request it
 * passes. Codex, inside the sandbox, talks to a custom model provider whose
 * base URL is the channel's bridge, so it sends its Responses API requests
 * there with no credential at all. The forwarder sends on only:
 *
 * - `POST /backend-api/codex/responses`, a turn, and
 *   `POST /backend-api/codex/responses/compact`, Codex's compaction of a
 *   long session, each with no query;
 * - an allowlist of the request's headers, the ones Codex 0.164 sends to
 *   the ChatGPT backend (seen in the factory's experiment: `originator`,
 *   `session-id`, `thread-id`, `x-client-request-id`, the `x-codex-*` and
 *   `x-openai-*` headers), with `Authorization: Bearer <access token>` and
 *   `chatgpt-account-id` from the login set by the forwarder alone;
 * - a body that is a JSON object for the session's model, with no
 *   server-side tool: a tool OpenAI runs (web search, image generation, file
 *   search, a code interpreter, computer use, a remote MCP server) would
 *   reach beyond the sandbox from OpenAI's side.
 *
 * Everything else is refused, and its line in the record says why.
 */
import { z } from 'zod';

/** Where the ChatGPT login's requests go: Codex's own `chatgpt_base_url` host. */
export const CHATGPT_HOST = 'chatgpt.com';

/** The base URL path Codex's built-in OpenAI provider uses with a ChatGPT login. */
export const CODEX_BASE_PATH = '/backend-api/codex';

export const CODEX_PATHS: readonly string[] = [`${CODEX_BASE_PATH}/responses`, `${CODEX_BASE_PATH}/responses/compact`];

export type CodexRefusal =
  | 'method'
  | 'path'
  | 'query'
  | 'encoded-body'
  | 'body-too-large'
  | 'body-not-json'
  | 'other-model'
  | 'server-tool'
  | 'no-login'
  | 'login-expired';

/** Why the request line is refused, or undefined when it may pass. */
export function lineRefusal(method: string, target: string): CodexRefusal | undefined {
  if (method !== 'POST') return 'method';
  const [path, query] = splitTarget(target);
  if (!CODEX_PATHS.includes(path)) return 'path';
  if (query !== undefined) return 'query';
  return undefined;
}

function splitTarget(target: string): [string, string | undefined] {
  const mark = target.indexOf('?');
  if (mark === -1) return [target, undefined];
  return [target.slice(0, mark), target.slice(mark + 1)];
}

const FORWARDED_EXACT = new Set(['accept', 'content-type', 'originator', 'session-id', 'thread-id', 'user-agent', 'version', 'openai-beta', 'x-client-request-id']);
const FORWARDED_PREFIXES = ['x-codex-', 'x-openai-'];

const isForwarded = (name: string) => FORWARDED_EXACT.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Header names, lowercase, as Node gives them, with their values. */
export type Headers = Record<string, string | string[] | undefined>;

/** Headers about this hop alone, which the forwarder sets for its own: never worth naming as dropped. */
const OWN_HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

/** The names of the headers Codex sent that the forwarder drops. Names only, never a value. */
export function droppedHeaderNames(headers: Headers): string[] {
  return Object.keys(headers).filter((name) => !isForwarded(name) && !OWN_HOP.has(name)).sort();
}

/** The headers the forwarder sends on: the allowlisted ones, then the login's, which nothing Codex sent can replace. */
export function forwardedHeaders(headers: Headers, login: { accessToken: string; accountId: string }, bodyLength: number): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || !isForwarded(name)) continue;
    forwarded[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  forwarded.host = CHATGPT_HOST;
  forwarded['content-length'] = String(bodyLength);
  forwarded.authorization = `Bearer ${login.accessToken}`;
  forwarded['chatgpt-account-id'] = login.accountId;
  return forwarded;
}

/** Tool types OpenAI runs on its side. Prefixes, since their names carry versions. */
const SERVER_TOOL_PREFIXES = ['web_search', 'image_generation', 'file_search', 'code_interpreter', 'computer_use', 'mcp'];

const bodySchema = z.object({
  model: z.string(),
  tools: z.array(z.object({ type: z.string() }).passthrough()).optional(),
}).passthrough();

export type BodyCheck = { ok: true; model: string } | { ok: false; reason: CodexRefusal; names: string[] };

/** Checks a whole request body against the session's model and the server-tool list. */
export function checkBody(body: Buffer, model: string): BodyCheck {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body-not-json', names: [] };
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'body-not-json', names: [] };
  if (parsed.data.model !== model) return { ok: false, reason: 'other-model', names: [parsed.data.model] };
  const serverTools = (parsed.data.tools ?? []).map((tool) => tool.type).filter((type) => SERVER_TOOL_PREFIXES.some((prefix) => type.startsWith(prefix)));
  if (serverTools.length > 0) return { ok: false, reason: 'server-tool', names: serverTools };
  return { ok: true, model };
}
