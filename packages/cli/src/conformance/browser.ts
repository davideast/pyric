import {
  CONFORMANCE_SUPPORTS,
  resolveCanIUse,
  type BrowserFeatureSupport,
  type CanIUseOptions,
} from './.generated/can-i-use-browser.js';

export type {
  Assurance,
  Availability,
  BrowserFeatureSupport,
  CanIUseMatch,
  CanIUseOptions,
  CanIUseResult,
  DeveloperSurface,
  Fidelity,
} from './.generated/can-i-use-browser.js';

/** Query the compact browser projection. Full claims and evidence remain on
 * the Node-only `@pyric/cli/conformance` entry point. */
export function canIUse(query: string, options?: CanIUseOptions) {
  return resolveCanIUse<BrowserFeatureSupport>(CONFORMANCE_SUPPORTS, query, options);
}
