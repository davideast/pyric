/**
 * Query Pyric's build-time conformance model by developer-facing feature name.
 * Results keep availability, behavior fidelity, and assurance eligibility as
 * separate trust axes.
 */
export {
  canIUse,
  normalizeFeature,
  type Assurance,
  type Availability,
  type DeveloperSurface,
  type FeatureClaim,
  type FeatureSupport,
  type Fidelity,
} from './.generated/can-i-use.js';

export { createConformanceTools } from './tools.js';
