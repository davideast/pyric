/**
 * The limits a billable body must keep to for its model's price to hold
 * (`provider-prices.ts`). The provider bills by tokens, so a body is refused
 * when it could be billed more tokens than its price covers:
 *
 * - `output-tokens`: no `maxOutputTokens`, or one above the model's cap;
 * - `thinking`: a thinking level the model doesn't allow, a thinking budget
 *   above its cap (or the unbounded `-1`), or an unknown thinking field;
 * - `input`: more text bytes or image parts than the model allows, or a
 *   part carrying data that isn't an image;
 * - `body-too-large`: a body over the model's request bytes.
 *
 * Refused, not capped: the body sent on is the body checked.
 */
import type { ProviderLimits } from './provider-prices.ts';

export type LimitRefusal = 'output-tokens' | 'thinking' | 'input' | 'body-too-large';

export interface LimitProblem {
  reason: LimitRefusal;
  message: string;
}

/** A field name in either case the API reads, `generation_config` or `generationConfig`. */
export function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The value of `name` in `fields`, in either spelling. */
export function entryOf(fields: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(fields).find((candidate) => camel(candidate) === name);
  return key === undefined ? undefined : fields[key];
}

const THINKING_CONFIG_FIELDS = new Set(['thinkingBudget', 'thinkingLevel', 'includeThoughts']);

function isCount(value: unknown, least: number, most: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most;
}

interface DataParts {
  count: number;
  dataBytes: number;
  /** A part whose data is not an image, if any. */
  notImage: boolean;
}

/** Every part that carries inline data, at any level of the body. */
function dataParts(value: unknown, found: DataParts = { count: 0, dataBytes: 0, notImage: false }): DataParts {
  if (Array.isArray(value)) {
    for (const item of value) dataParts(item, found);
    return found;
  }
  const fields = fieldsOf(value);
  if (fields === undefined) return found;
  const data = entryOf(fields, 'data');
  if (typeof data === 'string') {
    const mimeType = entryOf(fields, 'mimeType');
    const type = entryOf(fields, 'type');
    const isImage = typeof mimeType === 'string' && mimeType.startsWith('image/') && (type === undefined || type === 'image');
    found.count += 1;
    found.dataBytes += Buffer.byteLength(data);
    found.notImage ||= !isImage;
  }
  for (const inner of Object.values(fields)) dataParts(inner, found);
  return found;
}

function outputProblem(config: Record<string, unknown>, limits: ProviderLimits): LimitProblem | undefined {
  const tokens = entryOf(config, 'maxOutputTokens');
  if (tokens === undefined) return { reason: 'output-tokens', message: 'a billable body must set generationConfig.maxOutputTokens' };
  if (isCount(tokens, 1, limits.maxOutputTokens)) return undefined;
  return { reason: 'output-tokens', message: `maxOutputTokens must be a whole number from 1 to ${limits.maxOutputTokens}` };
}

function levelProblem(level: unknown, limits: ProviderLimits): LimitProblem | undefined {
  if (level === undefined) return undefined;
  const isAllowed = typeof level === 'string' && limits.thinkingLevels.includes(level);
  if (isAllowed) return undefined;
  const allowed = limits.thinkingLevels.length === 0 ? 'none' : limits.thinkingLevels.join(', ');
  return { reason: 'thinking', message: `the thinking level must be one this model allows (${allowed})` };
}

function thinkingProblem(config: Record<string, unknown>, limits: ProviderLimits): LimitProblem | undefined {
  const level = levelProblem(entryOf(config, 'thinkingLevel'), limits);
  if (level !== undefined) return level;
  const rawThinking = entryOf(config, 'thinkingConfig');
  if (rawThinking === undefined) return undefined;
  const thinking = fieldsOf(rawThinking);
  const unknown = thinking === undefined ? 'thinkingConfig' : Object.keys(thinking).find((key) => !THINKING_CONFIG_FIELDS.has(camel(key)));
  if (thinking === undefined || unknown !== undefined) return { reason: 'thinking', message: `the body's ${unknown} is not a thinking setting the forwarder can price` };
  const nested = levelProblem(entryOf(thinking, 'thinkingLevel'), limits);
  if (nested !== undefined) return nested;
  const budget = entryOf(thinking, 'thinkingBudget');
  const isPricedBudget = budget === undefined || isCount(budget, 0, limits.maxThinkingTokens);
  if (isPricedBudget) return undefined;
  return { reason: 'thinking', message: `the thinking budget must be a whole number from 0 to ${limits.maxThinkingTokens}` };
}

function inputProblem(fields: Record<string, unknown>, sentBytes: number, limits: ProviderLimits): LimitProblem | undefined {
  if (sentBytes > limits.maxRequestBytes) return { reason: 'body-too-large', message: `the body is over this model's ${limits.maxRequestBytes} bytes` };
  const parts = dataParts(fields);
  if (parts.notImage) return { reason: 'input', message: 'a part carrying data must be an image' };
  if (parts.count > limits.maxImageParts) return { reason: 'input', message: `the body carries more than this model's ${limits.maxImageParts} image parts` };
  const textBytes = sentBytes - parts.dataBytes;
  if (textBytes > limits.maxTextBytes) return { reason: 'input', message: `the body's text is over this model's ${limits.maxTextBytes} bytes` };
  return undefined;
}

/**
 * Why a billable body could be billed more than its model's price, if it
 * could. `fields` has passed the field allowlist; `sentBytes` is the length
 * of the body as it is sent on.
 */
export function limitProblem(fields: Record<string, unknown>, sentBytes: number, limits: ProviderLimits): LimitProblem | undefined {
  const input = inputProblem(fields, sentBytes, limits);
  if (input !== undefined) return input;
  const config = fieldsOf(entryOf(fields, 'generationConfig')) ?? {};
  return outputProblem(config, limits) ?? thinkingProblem(config, limits);
}
