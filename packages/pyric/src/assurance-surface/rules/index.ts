/**
 * Rules owner-inference and `RuleSurface` projection barrel: pure re-exports.
 */
export { analyzeOwners, ownerConditionsFrom, withEmbeddedRules } from './analyze-owners.js';
export type { OwnerAnalysis } from './analyze-owners.js';
export { firestoreRequiredClaims, rtdbRequiredClaims, storageRequiredClaims } from './claims.js';
export type { Claims, ClaimTarget } from './claims.js';
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
  StorageSurfaceInput,
  StorageSurfaceSource,
} from './rule-surface.js';
export { loadRuleSources, parseRtdbRulesText } from './rule-sources.js';
export type {
  FirestoreRuleSource,
  RtdbRuleSource,
  RuleSources,
  StorageRuleSource,
} from './rule-sources.js';
export type { OwnerBinding, OwnerCondition, OwnerEvidence, OwnerKind, OwnerRelation } from './types.js';
export { firestoreValueHints, rtdbValueHints } from './value-hints.js';
export type { ValueHint } from './value-hints.js';
