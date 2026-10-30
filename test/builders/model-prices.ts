/**
 * What a model response costs, as the forwarder meters it. The prices are
 * Anthropic's first-party API rates per million tokens as of 2026-10-06.
 * The meter errs high, never low, since it is what stops a run:
 *
 * - a model the table does not name is charged the highest rate in it;
 * - every cache write is charged at the one-hour rate (twice input), the
 *   higher of the two;
 * - Claude Haiku 5.5 is charged its rate for prompts over 100K tokens;
 * - a response served in fast mode is charged twice.
 *
 * The figure is the harness's estimate. The bill is the account's.
 */
import type { Tokens } from './usage.ts';

export interface Price {
  /** Dollars per million input tokens. */
  input: number;
  /** Dollars per million output tokens. */
  output: number;
}

const PRICES: ReadonlyArray<readonly [string, Price]> = [
  ['claude-fable-5-1', { input: 10, output: 50 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 5, output: 25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-haiku-5-5', { input: 0.5, output: 2.5 }],
  ['claude-haiku-4', { input: 1, output: 5 }],
];

/** The highest rate in the table, for a model it does not name. */
export const UNKNOWN_MODEL_PRICE: Price = { input: 10, output: 50 };

const CACHE_WRITE_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;
const FAST_MULTIPLIER = 2;
const PER_MILLION = 1_000_000;

/** The price of `model`: the longest table entry it starts with, or the highest rate. */
export function priceOf(model: string | undefined): Price {
  if (model === undefined) return UNKNOWN_MODEL_PRICE;
  const matches = PRICES.filter(([prefix]) => model === prefix || model.startsWith(`${prefix}-`) || model.startsWith(`${prefix}[`));
  const longest = [...matches].sort(([a], [b]) => b.length - a.length)[0];
  return longest?.[1] ?? UNKNOWN_MODEL_PRICE;
}

/** Dollars for one response's usage. */
export function costOf(tokens: Tokens, model: string | undefined, speed?: string): number {
  const price = priceOf(model);
  const inputUsd = tokens.input * price.input
    + tokens.cacheCreation * price.input * CACHE_WRITE_MULTIPLIER
    + tokens.cacheRead * price.input * CACHE_READ_MULTIPLIER;
  const outputUsd = tokens.output * price.output;
  const multiplier = speed === 'fast' ? FAST_MULTIPLIER : 1;
  return ((inputUsd + outputUsd) / PER_MILLION) * multiplier;
}
