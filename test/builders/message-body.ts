/**
 * What the forwarder reads in a Messages request's body before it sends the
 * request on: whether it may go, and what it may cost at most. The check is
 * an allowlist and fails closed. A field, block or source it doesn't name is
 * refused, never passed on, because the meter can only bound what it can
 * price. The names come from the Messages API reference
 * (https://platform.claude.com/docs/en/api/messages/create), read
 * 2026-10-29.
 *
 * - The body is strict JSON: an object that repeats a key at any depth is
 *   refused (`strict-json.ts`).
 * - Top-level fields: only those in `ALLOWED_FIELDS`, matched exactly, case
 *   included. Among those refused: `mcp_servers`, `container`,
 *   `context_management` (server-side compaction bills a call of its own),
 *   `fallbacks` (a fallback model can cost more than the one priced), and
 *   `diagnostics`. The 400 says `<field>: Extra inputs are not permitted`,
 *   the API's own wording, which Claude Code matches to retry without
 *   `context_management` (gateway page, same section). `service_tier` may
 *   only be `standard_only`, since `auto` may run at priority prices.
 * - Content blocks in `messages` and `tool_result` content: only the
 *   client-side types in `ALLOWED_BLOCKS`; in `system` and in a
 *   `search_result`'s content, text only. An image's source must be
 *   `base64`, a document's `base64` or `text`. A `url` source would have
 *   Anthropic fetch it, and a `file` source isn't bounded by the body's size.
 * - Tools: client tools only. A `tools` entry with a `type` is a server tool,
 *   refused with its type after `Input tag`, the wording Claude Code matches
 *   to retry once without its advisor tool
 *   (https://code.claude.com/docs/en/llm-gateway-protocol, "Automatic retry
 *   and error forwarding").
 * - A request to `/v1/messages` needs a positive integer `max_tokens`, since
 *   its worst case is priced from it. A token count needs none, and costs
 *   nothing.
 */
import { worstCaseUsd, type RateModifiers } from './model-prices.ts';
import { MAX_DEPTH, parseStrictJson } from './strict-json.ts';

export const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

export const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'model', 'messages', 'max_tokens', 'system', 'metadata', 'stop_sequences', 'stream',
  'temperature', 'top_p', 'top_k', 'thinking', 'tools', 'tool_choice', 'output_config',
  'cache_control', 'speed', 'inference_geo', 'service_tier',
]);

const ALLOWED_SERVICE_TIERS: readonly unknown[] = ['standard_only'];

/** Client-side content blocks. Server tool blocks and their results can't occur, since server tools are refused. */
export const ALLOWED_BLOCKS: ReadonlySet<string> = new Set([
  'text', 'image', 'document', 'search_result', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'tool_reference',
]);

const ALLOWED_SOURCES: Readonly<Record<string, readonly string[]>> = { image: ['base64'], document: ['base64', 'text'] };

/**
 * Tokens allowed for each image or document block beyond its bytes. An image
 * is priced by its size in pixels and a PDF by its pages, and a small,
 * well-compressed file can cost more tokens than it has bytes.
 */
export const MEDIA_ALLOWANCE_TOKENS: Readonly<Record<string, number>> = { image: 10_000, document: 200_000 };

export type BodyRefusalReason = 'body-not-json' | 'too-deep' | 'body-check-failed' | 'duplicate-key' | 'field' | 'service-tier' | 'block' | 'source' | 'server-tool' | 'max-tokens';

export type BodyCheck =
  | { kind: 'allowed'; model: string | undefined; modifiers: RateModifiers; reservedUsd: number }
  | { kind: 'refused'; reason: BodyRefusalReason; status: number; message: string; names: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const refused = (reason: BodyRefusalReason, status: number, message: string, names: string[] = []): BodyCheck =>
  ({ kind: 'refused', reason, status, message, names });

/** A content block's problem, as a refusal, or undefined when the block may go. `where` is its path in the body. */
function blockRefusal(block: unknown, where: string): BodyCheck | undefined {
  if (!isRecord(block)) return undefined;
  const type = String(block.type);
  if (!ALLOWED_BLOCKS.has(type)) return refused('block', 403, `${where} is a ${type} block, which builders may not send`, [`${where}.type=${type}`]);
  const sources = ALLOWED_SOURCES[type];
  const source = isRecord(block.source) ? String(block.source.type) : undefined;
  if (sources !== undefined && (source === undefined || !sources.includes(source))) {
    return refused('source', 403, `${where} has a ${String(source)} source; only ${sources.join(' or ')} is allowed`, [`${where}.source.type=${String(source)}`]);
  }
  if (type === 'tool_result') return blocksRefusal(block.content, `${where}.content`);
  if (type === 'search_result') return textBlocksRefusal(block.content, `${where}.content`);
  return undefined;
}

/** The system prompt and a search result's content take text blocks only. */
function textBlocksRefusal(content: unknown, where: string): BodyCheck | undefined {
  if (!Array.isArray(content)) return undefined;
  const index = content.findIndex((block) => !isRecord(block) || block.type !== 'text');
  if (index === -1) return undefined;
  const type = String((content[index] as { type?: unknown } | null)?.type);
  return refused('block', 403, `${where}[${index}] is a ${type} block; it takes text only`, [`${where}[${index}].type=${type}`]);
}

/** The first refusal among `content`'s blocks, when it is a list of them; a string is plain text. */
function blocksRefusal(content: unknown, where: string): BodyCheck | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const [index, block] of content.entries()) {
    const refusal = blockRefusal(block, `${where}[${index}]`);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function messagesRefusal(messages: unknown): BodyCheck | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const [index, message] of messages.entries()) {
    const refusal = isRecord(message) ? blocksRefusal(message.content, `messages[${index}].content`) : undefined;
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/** The `type` of every `tools` entry that has one: each is a server tool. */
function serverToolTypes(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => (isRecord(tool) && 'type' in tool ? [String(tool.type)] : []));
}

/** Image and document blocks anywhere in the body, each allowed tokens beyond its bytes. */
function mediaAllowanceTokens(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + mediaAllowanceTokens(item), 0);
  if (!isRecord(value)) return 0;
  const own = typeof value.type === 'string' ? MEDIA_ALLOWANCE_TOKENS[value.type] ?? 0 : 0;
  return Object.values(value).reduce((sum: number, item) => sum + mediaAllowanceTokens(item), own);
}

const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** The first problem with the body's shape, before anything is priced. */
function shapeRefusal(message: Record<string, unknown>): BodyCheck | undefined {
  const unknownFields = Object.keys(message).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length > 0) {
    const wording = unknownFields.map((field) => `${field}: Extra inputs are not permitted`).join('; ');
    return refused('field', 400, wording, unknownFields);
  }
  if ('service_tier' in message && !ALLOWED_SERVICE_TIERS.includes(message.service_tier)) {
    return refused('service-tier', 403, 'service_tier may only be standard_only', [`service_tier=${String(message.service_tier)}`]);
  }
  const toolTypes = serverToolTypes(message.tools);
  if (toolTypes.length > 0) {
    const tags = toolTypes.map((type) => `Input tag '${type}'`).join(', ');
    return refused('server-tool', 400, `${tags} is a server tool, and builders get client tools only`, toolTypes);
  }
  return textBlocksRefusal(message.system, 'system') ?? messagesRefusal(message.messages);
}

/** Whether a Messages request to `path` with `body` may go on, and the most it may cost. */
export function checkMessageBody(path: string, body: Buffer): BodyCheck {
  const json = parseStrictJson(body.toString('utf8'));
  if (json.kind === 'too-deep') return refused('too-deep', 400, `the body nests deeper than ${MAX_DEPTH} levels`);
  if (json.kind === 'duplicate-key') return refused('duplicate-key', 400, `the body repeats the key ${json.key}`, [json.key]);
  if (json.kind === 'malformed' || !isRecord(json.value)) return refused('body-not-json', 400, 'the request body is not a JSON object');
  const message = json.value;
  const shape = shapeRefusal(message);
  if (shape !== undefined) return shape;
  const model = typeof message.model === 'string' ? message.model : undefined;
  const modifiers: RateModifiers = { speed: message.speed === 'fast' ? 'fast' : undefined, usOnly: message.inference_geo !== undefined && message.inference_geo !== null };
  if (path === COUNT_TOKENS_PATH) return { kind: 'allowed', model, modifiers, reservedUsd: 0 };
  if (!isPositiveInteger(message.max_tokens)) return refused('max-tokens', 400, 'max_tokens must be a positive integer');
  const extraTokens = mediaAllowanceTokens(message.messages) + mediaAllowanceTokens(message.system);
  const reservedUsd = worstCaseUsd(body.length + extraTokens, model, message.max_tokens, modifiers);
  return { kind: 'allowed', model, modifiers, reservedUsd };
}
