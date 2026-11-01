/**
 * What a model request may cost and what a response did cost, as the
 * forwarder meters them. The prices are Anthropic's first-party API rates in
 * dollars per million tokens, read on 2026-10-29 from
 * https://platform.claude.com/docs/en/about-claude/pricing ("Model pricing",
 * "Fast mode pricing", "Data residency pricing", "Long context pricing"),
 * with the model ids from the models overview
 * (https://platform.claude.com/docs/en/about-claude/models/overview).
 *
 * The meter is what stops a run, so every figure errs high, never low:
 *
 * - a model is priced only by an exact id in the table; any other id,
 *   including a near miss or a suffix, is charged the highest rate in it;
 * - every cache write is charged at the one-hour rate (twice input), and
 *   every cache read at a tenth of input, the highest read rate on the page;
 * - Claude Haiku 5.5 is always charged its rate for prompts over 100K tokens;
 * - a model with a long-context premium the page doesn't price is charged
 *   the highest rate once its prompt passes 200K tokens;
 * - fast mode is charged twice, and US-only inference 1.1 times.
 *
 * The figure is the harness's estimate. The bill is the account's.
 */
import type { Tokens } from './usage.ts';

export interface Price {
  /** Dollars per million input tokens. */
  input: number;
  /** Dollars per million output tokens. */
  output: number;
  /** A prompt longer than this many tokens is charged the highest rate. */
  standardUpTo?: number;
}

const FABLE: Price = { input: 10, output: 50 };
const OPUS_5_5: Price = { input: 4, output: 20 };
const OPUS_5: Price = { input: 5, output: 25 };
const OPUS_4_1: Price = { input: 15, output: 75 };
const SONNET_5: Price = { input: 2, output: 10 };
const SONNET_4_6: Price = { input: 3, output: 15 };
const SONNET_4: Price = { input: 3, output: 15, standardUpTo: 200_000 };
const HAIKU_5_5_LONG: Price = { input: 0.5, output: 2.5 };
const HAIKU_4_5: Price = { input: 1, output: 5 };
const HAIKU_3_5: Price = { input: 0.8, output: 4 };

/** Every model id the table prices, alias and dated id alike. */
const PRICES: ReadonlyMap<string, Price> = new Map([
  ['claude-fable-5-1', FABLE],
  ['claude-mythos-5-1', FABLE],
  ['claude-fable-5', FABLE],
  ['claude-mythos-5', FABLE],
  ['claude-opus-5-5', OPUS_5_5],
  ['claude-opus-5', OPUS_5],
  ['claude-opus-4-8', OPUS_5],
  ['claude-opus-4-7', OPUS_5],
  ['claude-opus-4-6', OPUS_5],
  ['claude-opus-4-5', OPUS_5],
  ['claude-opus-4-5-20251101', OPUS_5],
  ['claude-opus-4-1', OPUS_4_1],
  ['claude-opus-4-1-20250805', OPUS_4_1],
  ['claude-opus-4-0', OPUS_4_1],
  ['claude-opus-4-20250514', OPUS_4_1],
  ['claude-sonnet-5-5', SONNET_5],
  ['claude-sonnet-5', SONNET_5],
  ['claude-sonnet-4-6', SONNET_4_6],
  ['claude-sonnet-4-5', SONNET_4],
  ['claude-sonnet-4-5-20250929', SONNET_4],
  ['claude-sonnet-4-0', SONNET_4],
  ['claude-sonnet-4-20250514', SONNET_4],
  ['claude-haiku-5-5', HAIKU_5_5_LONG],
  ['claude-haiku-4-5', HAIKU_4_5],
  ['claude-haiku-4-5-20251001', HAIKU_4_5],
  ['claude-3-5-haiku-20241022', HAIKU_3_5],
]);

/** The highest rate in the table (Claude Opus 4 and 4.1), for any model it does not name. */
export const UNKNOWN_MODEL_PRICE: Price = { input: 15, output: 75 };

const CACHE_WRITE_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;
const FAST_MULTIPLIER = 2;
const US_ONLY_MULTIPLIER = 1.1;
const PER_MILLION = 1_000_000;

/** The price of `model` for a prompt of `promptTokens`: its exact row, or the highest rate. */
export function priceOf(model: string | undefined, promptTokens = 0): Price {
  const price = model === undefined ? undefined : PRICES.get(model);
  if (price === undefined) return UNKNOWN_MODEL_PRICE;
  const pastStandard = price.standardUpTo !== undefined && promptTokens > price.standardUpTo;
  return pastStandard ? UNKNOWN_MODEL_PRICE : price;
}

/** What raises every rate of one request. */
export interface RateModifiers {
  /** `fast` when the response or request says fast mode. */
  speed?: string;
  /** The request asked for US-only inference (`inference_geo`). */
  usOnly?: boolean;
}

const multiplierOf = (modifiers: RateModifiers) =>
  (modifiers.speed === 'fast' ? FAST_MULTIPLIER : 1) * (modifiers.usOnly === true ? US_ONLY_MULTIPLIER : 1);

/** Dollars for one response's usage. */
export function costOf(tokens: Tokens, model: string | undefined, modifiers: RateModifiers = {}): number {
  const price = priceOf(model, tokens.input + tokens.cacheCreation + tokens.cacheRead);
  const inputUsd = tokens.input * price.input
    + tokens.cacheCreation * price.input * CACHE_WRITE_MULTIPLIER
    + tokens.cacheRead * price.input * CACHE_READ_MULTIPLIER;
  const outputUsd = tokens.output * price.output;
  return ((inputUsd + outputUsd) / PER_MILLION) * multiplierOf(modifiers);
}

/**
 * Tokens added to a prompt beyond its body: the tool-use system prompt and
 * the like, a few hundred on the pricing page ("Tool use pricing"), rounded up.
 */
export const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * The most one request can cost before it is sent: its prompt, estimated
 * from the body (`message-body.ts`: a token per byte, plus an allowance per
 * image or document) and the overhead, all counted as tokens written to the
 * cache, plus `max_tokens` of output, at the model's rate for a prompt that
 * long. Text tokens are never shorter than a byte of UTF-8.
 */
export function worstCaseUsd(bodyTokens: number, model: string | undefined, maxTokens: number, modifiers: RateModifiers = {}): number {
  const promptTokens = bodyTokens + PROMPT_OVERHEAD_TOKENS;
  const price = priceOf(model, promptTokens);
  const inputUsd = promptTokens * price.input * CACHE_WRITE_MULTIPLIER;
  const outputUsd = maxTokens * price.output;
  return ((inputUsd + outputUsd) / PER_MILLION) * multiplierOf(modifiers);
}
