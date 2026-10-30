/**
 * What the forwarder reads in a Messages request's body before it sends the
 * request on: whether it may go, and what it may cost at most.
 *
 * A builder gets client tools only. A request that names `mcp_servers`, or
 * has a `tools` entry with a `type` (a server tool such as `web_search_*`,
 * `web_fetch_*`, `code_execution_*` or `advisor_*`), is refused: a server
 * tool runs on Anthropic's side, out of the sandbox, and bills beyond the
 * tokens the meter can bound. The refusal names the tool type after
 * `Input tag`, the wording Claude Code matches to retry once without its
 * advisor tool (https://code.claude.com/docs/en/llm-gateway-protocol,
 * "Automatic retry and error forwarding").
 *
 * A request to `/v1/messages` needs a numeric `max_tokens`, since its worst
 * case is priced from it. A token count costs nothing and needs none.
 */
import { worstCaseUsd, type RateModifiers } from './model-prices.ts';

export const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

/**
 * Tokens allowed for each image or document block beyond its bytes. An image
 * is priced by its size in pixels and a PDF by its pages, and a small,
 * well-compressed file can cost more tokens than it has bytes.
 */
export const MEDIA_ALLOWANCE_TOKENS: Readonly<Record<string, number>> = { image: 10_000, document: 200_000 };

export type BodyRefusalReason = 'body-not-json' | 'mcp-servers' | 'server-tool' | 'max-tokens';

export type BodyCheck =
  | { kind: 'allowed'; model: string | undefined; modifiers: RateModifiers; reservedUsd: number }
  | { kind: 'refused'; reason: BodyRefusalReason; status: number; message: string; toolTypes: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parsed(body: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
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

const refused = (reason: BodyRefusalReason, status: number, message: string, toolTypes: string[] = []): BodyCheck =>
  ({ kind: 'refused', reason, status, message, toolTypes });

/** Whether a Messages request to `path` with `body` may go on, and the most it may cost. */
export function checkMessageBody(path: string, body: Buffer): BodyCheck {
  const message = parsed(body);
  if (message === undefined) return refused('body-not-json', 400, 'the request body is not a JSON object');
  if ('mcp_servers' in message) return refused('mcp-servers', 403, 'mcp_servers are not allowed: builders get client tools only');
  const toolTypes = serverToolTypes(message.tools);
  if (toolTypes.length > 0) {
    const tags = toolTypes.map((type) => `Input tag '${type}'`).join(', ');
    return refused('server-tool', 400, `${tags} is a server tool, and builders get client tools only`, toolTypes);
  }
  const model = typeof message.model === 'string' ? message.model : undefined;
  const modifiers: RateModifiers = { speed: message.speed === 'fast' ? 'fast' : undefined, usOnly: 'inference_geo' in message };
  if (path === COUNT_TOKENS_PATH) return { kind: 'allowed', model, modifiers, reservedUsd: 0 };
  if (!isPositiveInteger(message.max_tokens)) return refused('max-tokens', 400, 'max_tokens must be a positive integer');
  const extraTokens = mediaAllowanceTokens(message.messages) + mediaAllowanceTokens(message.system);
  const reservedUsd = worstCaseUsd(body.length + extraTokens, model, message.max_tokens, modifiers);
  return { kind: 'allowed', model, modifiers, reservedUsd };
}
