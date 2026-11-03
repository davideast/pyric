/**
 * What one media provider call may cost, as the provider forwarder
 * (`provider-forwarder.ts`) meters it, and the limits a body must keep to
 * for that price to hold. The provider bills by tokens, so each model's
 * price is its worst case under its limits (`worstCaseUsd`), reserved before
 * the call is sent and never lowered by what the response says it used.
 *
 * A body is refused unless it sets `maxOutputTokens` at or under the
 * model's cap, names only a thinking level the model allows, sets a
 * thinking budget at or under the model's cap, and stays under the model's
 * request bytes, text bytes and image parts (`provider-body-limits.ts`).
 *
 * The worst case, in tokens:
 *
 * - input: one token per byte of the body outside its image parts' data (a
 *   token is never shorter than one byte, and the body's JSON is never
 *   shorter than the text it carries), plus `IMAGE_PART_TOKENS` for each
 *   image part where the API reads one (`provider-body-parts.ts`);
 * - output: `maxOutputTokens` plus the thinking cap, every token at the
 *   model's output rate (the image rate for an image model).
 *
 * Two assumptions to confirm before the run: that image and music output,
 * and thoughts, obey `maxOutputTokens`, since a thinking level, or no
 * thinking setting, gets the provider's default thinking, which only
 * `maxOutputTokens` bounds (the thinking cap added on top is margin); and
 * that one image part is billed at most `IMAGE_PART_TOKENS`.
 *
 * The dollar figure is the larger of that and the model's per-call floor,
 * rounded up to the cent.
 *
 * The per-token rates and the floors are placeholders that err high. None
 * is read from a dated source yet: each rate must be confirmed with a dated
 * source link, like `../model-prices.ts`, before a run sends a real call. A
 * model that isn't in the table, including a near miss or a suffix, is
 * refused.
 *
 * The figure is the harness's estimate. The bill is the account's.
 */

/** The one host provider calls go to. */
export const PROVIDER_HOST = 'generativelanguage.googleapis.com';

/**
 * Input tokens charged for one image part, whatever its bytes. A
 * placeholder that errs high: confirm it against the provider's token count
 * for one input image before the run.
 */
export const IMAGE_PART_TOKENS = 5_000;

export type ProviderCallKind = 'image' | 'music' | 'text';

/** What one body to a model may ask for. */
export interface ProviderLimits {
  /** The largest `maxOutputTokens` a body may set. Every billable body must set it. */
  maxOutputTokens: number;
  /** The largest thinking budget a body may set, in tokens; 0 refuses any budget above 0. */
  maxThinkingTokens: number;
  /** The thinking levels a body may name; empty refuses any level. */
  thinkingLevels: readonly string[];
  /** The largest request body, in bytes, images included. */
  maxRequestBytes: number;
  /** The largest body outside its image parts' data, in bytes. */
  maxTextBytes: number;
  /** The most image parts one body may carry. */
  maxImageParts: number;
}

/** Placeholder rates, erring high, until each is confirmed with a dated source. */
export interface ProviderRates {
  /** Dollars per million input tokens. */
  usdPerMillionInput: number;
  /** Dollars per million output tokens, thoughts included. */
  usdPerMillionOutput: number;
  /** The least one call is charged, for a model billed per item rather than per token. */
  usdFloor: number;
}

export interface ProviderPrice {
  kind: ProviderCallKind;
  limits: ProviderLimits;
  rates: ProviderRates;
  /** Dollars charged for one call: its worst case under `limits`. */
  usdPerCall: number;
}

/** The most input tokens a body within `limits` can be billed. */
export function worstInputTokens(limits: ProviderLimits): number {
  return limits.maxTextBytes + limits.maxImageParts * IMAGE_PART_TOKENS;
}

/** The most output tokens a body within `limits` can be billed. */
export function worstOutputTokens(limits: ProviderLimits): number {
  return limits.maxOutputTokens + limits.maxThinkingTokens;
}

/** A call's worst case in dollars, rounded up to the cent. */
export function worstCaseUsd(limits: ProviderLimits, rates: ProviderRates): number {
  const byTokens = (worstInputTokens(limits) * rates.usdPerMillionInput + worstOutputTokens(limits) * rates.usdPerMillionOutput) / 1_000_000;
  return Math.ceil(Math.max(byTokens, rates.usdFloor) * 100 - 1e-9) / 100;
}

function priced(kind: ProviderCallKind, limits: ProviderLimits, rates: ProviderRates): ProviderPrice {
  return { kind, limits, rates, usdPerCall: worstCaseUsd(limits, rates) };
}

const MIB = 1024 * 1024;
const KIB = 1024;

// One image at 2K is about 1,100 output tokens; the cap leaves room for text.
const IMAGE_LIMITS: ProviderLimits = {
  maxOutputTokens: 4_096, maxThinkingTokens: 4_096, thinkingLevels: ['minimal', 'medium', 'high'],
  maxRequestBytes: 8 * MIB, maxTextBytes: 16 * KIB, maxImageParts: 4,
};

const MUSIC_LIMITS: ProviderLimits = {
  maxOutputTokens: 8_192, maxThinkingTokens: 0, thinkingLevels: [],
  maxRequestBytes: 8 * MIB, maxTextBytes: 16 * KIB, maxImageParts: 4,
};

const TEXT_LIMITS: ProviderLimits = {
  maxOutputTokens: 2_048, maxThinkingTokens: 2_048, thinkingLevels: ['minimal', 'low'],
  maxRequestBytes: 128 * KIB, maxTextBytes: 64 * KIB, maxImageParts: 0,
};

export const PROVIDER_PRICES: Readonly<Record<string, ProviderPrice>> = {
  // Placeholder rates, erring high: confirm the image model's per-token rates with a dated source before the run.
  // Worst case: (16,384 + 4 x 5,000) input x $2/M + (4,096 + 4,096) output x $120/M = $1.0558, so $1.06.
  'gemini-nano-banana-2.1': priced('image', IMAGE_LIMITS, { usdPerMillionInput: 2, usdPerMillionOutput: 120, usdFloor: 0.134 }),
  // Placeholder rates and floor, erring high: confirm the music rate with a dated source before the run.
  // Worst case: (16,384 + 4 x 5,000) input x $2/M + 8,192 output x $120/M = $1.0558, so $1.06 (above the $1 floor).
  'lyria-3.5': priced('music', MUSIC_LIMITS, { usdPerMillionInput: 2, usdPerMillionOutput: 120, usdFloor: 1 }),
  // Placeholder rates and floor, erring high: confirm the music clip rate with a dated source before the run.
  // Worst case: as `lyria-3.5`, $1.06.
  'lyria-3-clip-preview': priced('music', MUSIC_LIMITS, { usdPerMillionInput: 2, usdPerMillionOutput: 120, usdFloor: 1 }),
  // Placeholder rates, erring high: confirm the text model's per-token rates with a dated source before the run.
  // Worst case: 65,536 input x $0.50/M + (2,048 + 2,048) output x $4/M = $0.0492, so $0.05.
  'gemini-3.5-flash-lite': priced('text', TEXT_LIMITS, { usdPerMillionInput: 0.5, usdPerMillionOutput: 4, usdFloor: 0 }),
};

/** The largest request body any model in the table accepts; the forwarder stops reading past it. */
export const MAX_PROVIDER_REQUEST_BYTES = Math.max(...Object.values(PROVIDER_PRICES).map((price) => price.limits.maxRequestBytes));

/** The model id a request names, without the API's `models/` prefix. */
export function bareModel(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

/** The price of one call to `model`, or undefined when the table doesn't name it exactly. */
export function priceOf(model: string): ProviderPrice | undefined {
  const bare = bareModel(model);
  return Object.hasOwn(PROVIDER_PRICES, bare) ? PROVIDER_PRICES[bare] : undefined;
}
