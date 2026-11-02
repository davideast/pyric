/**
 * What the forwarder passes on for this adapter, and what it puts on a
 * request it passes. The agent, inside the sandbox, talks to a custom model provider whose
 * base URL is the channel's bridge, so it sends its Responses API requests
 * there with no credential at all. The forwarder sends on only:
 *
 * - `POST <base path>/responses`, a turn, and
 *   `POST <base path>/responses/compact`, the agent's compaction of a
 *   long session, each with no query;
 * - an allowlist of the request's headers, the ones the agent sends to the
 *   upstream (seen in the factory's experiment; listed in
 *   `FORWARDED_EXACT` and `FORWARDED_PREFIXES`); the forwarder sets
 *   `Authorization: Bearer <access token>` and the identity header from the
 *   credential (`login.ts`);
 * - a body that is a JSON object for the session's model whose tools are
 *   all ones the agent runs itself, and whose input names no URL other than
 *   an inline `data:` one and no file ID: a tool the upstream runs (web
 *   search, a remote MCP server, any added later) or a URL it fetches would
 *   reach beyond the sandbox from the upstream's side.
 *
 * Everything else is refused, and its line in the record says why.
 */
import { z } from 'zod';
import type { BodyCheck } from '../../agent.ts';

/** The upstream host the credential's requests go to. */
export const CHATGPT_HOST = 'chatgpt.com';

/** The base URL path the agent's built-in provider uses with this credential. */
export const CODEX_BASE_PATH = '/backend-api/codex';

export const CODEX_PATHS: readonly string[] = [`${CODEX_BASE_PATH}/responses`, `${CODEX_BASE_PATH}/responses/compact`];

/** The policy's refusals; the forwarder adds its own (`ForwarderRefusal`). */
export type CodexRefusal = 'method' | 'path' | 'query' | 'body-not-json' | 'other-model' | 'server-tool' | 'remote-input';

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

/** Whether a request header, by its lowercase name, is sent on. The credential's own headers are set by the forwarder alone. */
export const isForwardedHeader = (name: string) => FORWARDED_EXACT.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * The tool types the agent runs itself, on its side of the bridge. The agent
 * sends `function` and `custom` tools grouped in `namespace`s, in an
 * `additional_tools` item of `input` (seen offline, with the real binary
 * and a stand-in backend), and may send `local_shell`. Any other type is a
 * tool the upstream would run, so it is refused, including ones added later.
 */
const CLIENT_TOOL_TYPES = new Set(['function', 'custom', 'local_shell', 'namespace']);

/** Input keys that name a file or a fetchable place: the upstream would fetch a URL, and a file ID reaches files stored upstream. */
const isReferenceKey = (key: string) => key.endsWith('_url') || key === 'file_id';
const isInlineData = (value: unknown) => typeof value === 'string' && value.startsWith('data:');

const toolSchema = z.object({ type: z.string(), tools: z.array(z.unknown()).optional() }).passthrough();

const bodySchema = z.object({
  model: z.string(),
  tools: z.array(z.unknown()).optional(),
  input: z.unknown().optional(),
}).passthrough();

/** The type of every tool in `tools`, and in each namespace's own `tools`, depth first. */
function toolTypes(tools: readonly unknown[]): string[] {
  return tools.flatMap((tool) => {
    const parsed = toolSchema.safeParse(tool);
    if (!parsed.success) return ['(not a tool)'];
    return [parsed.data.type, ...toolTypes(parsed.data.tools ?? [])];
  });
}

/** Every tool list a body carries: its `tools`, and the `tools` of each item of `input` (the agent's `additional_tools`). */
function toolLists(body: z.infer<typeof bodySchema>): unknown[][] {
  const items = Array.isArray(body.input) ? body.input : [];
  const fromInput = items.map((item) => toolSchema.partial().safeParse(item)).flatMap((item) => (item.success && item.data.tools !== undefined ? [item.data.tools] : []));
  return [body.tools ?? [], ...fromInput];
}

/** The keys under `value` that point outside the request: a URL that isn't inline `data:`, or a file ID. */
function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const isOutside = isReferenceKey(key) && !isInlineData(entry);
    return isOutside ? [key] : references(entry);
  });
}

/** Checks a whole request body: the session's model, only tools the agent runs, and nothing in `input` the upstream would fetch. */
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
  const serverTools = toolLists(parsed.data).flatMap(toolTypes).filter((type) => !CLIENT_TOOL_TYPES.has(type));
  if (serverTools.length > 0) return { ok: false, reason: 'server-tool', names: [...new Set(serverTools)] };
  const outside = references(parsed.data.input);
  if (outside.length > 0) return { ok: false, reason: 'remote-input', names: [...new Set(outside)] };
  return { ok: true, model };
}
