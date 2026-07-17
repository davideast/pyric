/**
 * Query Pyric's build-time conformance model by developer-facing feature name.
 * Results keep availability, behavior fidelity, and assurance eligibility as
 * separate trust axes.
 */
export {
  type Assurance,
  type Availability,
  type DeveloperSurface,
  type FeatureClaim,
  type FeatureClaimKind,
  type FeatureSupport,
  type Fidelity,
  type ImportEvidence,
  type CanIUseMatch,
  type CanIUseOptions,
  type CanIUseResult,
} from './.generated/can-i-use.js';

export { canIUse, canIUseImport } from './can-i-use.js';
