import {
  CONFORMANCE_SUPPORTS,
  resolveCanIUse,
  type BrowserFeatureSupport,
} from './.generated/can-i-use-browser.js';
import { createServedQuery } from './served-query.js';

export { createCanIUseTool, type CanIUseToolOptions } from './can-i-use-tool.js';
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
export const canIUse = createServedQuery(CONFORMANCE_SUPPORTS, resolveCanIUse<BrowserFeatureSupport>);
