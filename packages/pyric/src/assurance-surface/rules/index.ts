/**
 * Rules owner-inference and `RuleSurface` projection barrel: pure re-exports.
 */
export { analyzeOwners, ownerConditionsFrom, withEmbeddedRules } from './analyze-owners.js';
export type { OwnerAnalysis } from './analyze-owners.js';
export {
  firestoreRequiredClaims,
  rtdbRequiredClaims,
  storageRequiredClaims,
  type Claims,
  type ClaimTarget,
  type RequiredClaimsOptions,
} from './claims.js';
export { inferOwnerBindings } from './cross-check.js';
export { firestoreOwnerConditions } from './firestore-owners.js';
export { rtdbOwnerConditions } from './rtdb-owners.js';
export { projectRuleSurface } from './rule-surface.js';
export { storageOwnerConditions, storageValueHints } from './storage-owners.js';
export type {
  CrossServiceLookup,
  FirestoreSurfaceInput,
  FirestoreSurfaceSource,
  ProjectRuleSurfaceInput,
  RtdbSurfaceInput,
  RtdbSurfaceSource,
  RuleSurface,
  RuleSurfaceEntry,
  StorageMetadataConstraint,
  StorageMetadataConstraintArm,
  StorageSurfaceInput,
  StorageSurfaceSource,
} from './rule-surface.js';
export {
  bundleRulesSource,
  loadRuleSources,
  parseRtdbRulesText,
  type BundleRulesSourceOptions,
  type FirestoreRuleSource,
  type RtdbRuleSource,
  type RuleSources,
  type StorageRuleSource,
} from './rule-sources.js';
export {
  parseRulesAstWithMultiMatchOrError,
  validateRulesSourceSyntax,
} from './rules-ast-utils.js';
export type { OwnerBinding, OwnerCondition, OwnerEvidence, OwnerKind, OwnerRelation } from './types.js';
export { firestoreValueHints, rtdbValueHints } from './value-hints.js';
export type { ValueHint } from './value-hints.js';
