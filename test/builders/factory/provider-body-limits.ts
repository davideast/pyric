/**
 * The limits a billable body must keep to for its model's price to hold
 * (`provider-prices.ts`). The provider bills by tokens, so a body is refused
 * when it could be billed more tokens than its price covers:
 *
 * - `output-tokens`: a `maxOutputTokens` that isn't a whole number from 1 to
 *   the model's cap (the forwarder sets the cap on a token-billed body that
 *   has none, `withOutputCap`);
 * - `thinking`: a thinking level the model doesn't allow, a thinking budget
 *   above its cap (or the unbounded `-1`), or an unknown thinking field;
 * - `input`: more text bytes or image parts than the model allows, or an
 *   image part whose mime type isn't an image;
 * - `field`: content the price can't cover (`provider-body-parts.ts`): a
 *   part other than text or an image, data outside an image part, or a
 *   response schema on a media model;
 * - `body-too-large`: a body over the model's request bytes.
 *
 * Refused, not capped: the body sent on is the body checked.
 */
import { camel, checkParts, entryOf, fieldsOf } from './provider-body-parts.ts';
import type { ProviderLimits, ProviderPrice } from './provider-prices.ts';

export type LimitRefusal = 'output-tokens' | 'thinking' | 'input' | 'field' | 'body-too-large';

export interface LimitProblem {
  reason: LimitRefusal;
  message: string;
}

const THINKING_CONFIG_FIELDS = new Set(['thinkingBudget', 'thinkingLevel', 'includeThoughts']);

function isCount(value: unknown, least: number, most: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most;
}

function outputProblem(config: Record<string, unknown>, price: ProviderPrice): LimitProblem | undefined {
  const { limits } = price;
  const tokens = entryOf(config, 'maxOutputTokens');
  // The forwarder sets the cap on a token-billed body that has none, so only a per-call model gets here without one.
  if (tokens === undefined) return price.rates.billedPer === 'call' ? undefined : { reason: 'output-tokens', message: 'a body to a model billed per token must set maxOutputTokens' };
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

function inputProblem(fields: Record<string, unknown>, sentBytes: number, price: ProviderPrice): LimitProblem | undefined {
  const { limits } = price;
  if (sentBytes > limits.maxRequestBytes) return { reason: 'body-too-large', message: `the body is over this model's ${limits.maxRequestBytes} bytes` };
  const parts = checkParts(fields, price.kind);
  if (!parts.ok) return { reason: parts.reason, message: `the body's ${parts.field} is not content the forwarder can price` };
  if (parts.images.count > limits.maxImageParts) return { reason: 'input', message: `the body carries more than this model's ${limits.maxImageParts} image parts` };
  const textBytes = sentBytes - parts.images.dataBytes;
  if (textBytes > limits.maxTextBytes) return { reason: 'input', message: `the body's text is over this model's ${limits.maxTextBytes} bytes` };
  return undefined;
}

/**
 * Why a billable body could be billed more than its model's price, if it
 * could. `fields` has passed the field allowlist; `sentBytes` is the length
 * of the body as it is sent on.
 */
export function limitProblem(fields: Record<string, unknown>, sentBytes: number, price: ProviderPrice): LimitProblem | undefined {
  const input = inputProblem(fields, sentBytes, price);
  if (input !== undefined) return input;
  const config = fieldsOf(entryOf(fields, 'generationConfig')) ?? {};
  return outputProblem(config, price) ?? thinkingProblem(config, price.limits);
}

/**
 * `fields` with `maxOutputTokens` set to the model's cap when a token-billed
 * body doesn't set it, in the spelling each API reads: `generationConfig.
 * maxOutputTokens` for generateContent, `generation_config.max_output_tokens`
 * for an interaction. The result is what is checked and sent. A body that
 * sets it, in either spelling, and a per-call model's body are unchanged.
 */
export function withOutputCap(fields: Record<string, unknown>, price: ProviderPrice, api: 'generate' | 'interactions'): Record<string, unknown> {
  if (price.rates.billedPer === 'call') return fields;
  const fallbackKey = api === 'generate' ? 'generationConfig' : 'generation_config';
  const configKey = Object.keys(fields).find((key) => camel(key) === 'generationConfig') ?? fallbackKey;
  const raw = fields[configKey];
  const config = raw === undefined ? {} : fieldsOf(raw);
  if (config === undefined || entryOf(config, 'maxOutputTokens') !== undefined) return fields;
  const tokenKey = api === 'generate' ? 'maxOutputTokens' : 'max_output_tokens';
  return { ...fields, [configKey]: { ...config, [tokenKey]: price.limits.maxOutputTokens } };
}
