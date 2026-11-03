/**
 * What one media provider call may cost, as the provider forwarder
 * (`provider-forwarder.ts`) meters it. Every call is charged a fixed price
 * per call, reserved before the call is sent and never lowered by what the
 * response says it used.
 *
 * The prices are placeholders that err high. None is read from a dated
 * source yet: each rate must be confirmed with a dated source link, like
 * `../model-prices.ts`, before a run sends a real call. A model that isn't
 * in the table, including a near miss or a suffix, is refused.
 *
 * The figure is the harness's estimate. The bill is the account's.
 */

/** The one host provider calls go to. */
export const PROVIDER_HOST = 'generativelanguage.googleapis.com';

export type ProviderCallKind = 'image' | 'music' | 'text';

export interface ProviderPrice {
  kind: ProviderCallKind;
  /** Dollars charged for one call, whatever it returns. */
  usdPerCall: number;
}

export const PROVIDER_PRICES: Readonly<Record<string, ProviderPrice>> = {
  // Placeholder, erring high: confirm the image rate with a dated source before the run.
  'gemini-nano-banana-2.1': { kind: 'image', usdPerCall: 0.134 },
  // Placeholder, erring high: confirm the music rate with a dated source before the run.
  'lyria-3.5': { kind: 'music', usdPerCall: 1 },
  // Placeholder, erring high: confirm the music clip rate with a dated source before the run.
  'lyria-3-clip-preview': { kind: 'music', usdPerCall: 1 },
  // Placeholder, erring high: confirm the text rate with a dated source before the run.
  'gemini-3.5-flash-lite': { kind: 'text', usdPerCall: 0.02 },
};

/** The model id a request names, without the API's `models/` prefix. */
export function bareModel(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

/** The price of one call to `model`, or undefined when the table doesn't name it exactly. */
export function priceOf(model: string): ProviderPrice | undefined {
  const bare = bareModel(model);
  return Object.hasOwn(PROVIDER_PRICES, bare) ? PROVIDER_PRICES[bare] : undefined;
}
