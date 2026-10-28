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

/** Query the compact browser projection. Claims and their evidence chains
 * remain on the Node-only `@pyric/cli/conformance` entry point; caveats ship
 * whole, including evidence text for registry rows that do not conform. */
export const canIUse = createServedQuery(CONFORMANCE_SUPPORTS, resolveCanIUse<BrowserFeatureSupport>);
