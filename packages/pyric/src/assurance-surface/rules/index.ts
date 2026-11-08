/**
 * Rules owner-inference barrel: re-exports condition extractors, cross-check,
 * rule-source loaders, and top-level owner analysis.
 */
export { analyzeOwners, ownerConditionsFrom, withEmbeddedRules } from './analyze-owners.js';
export type { OwnerAnalysis } from './analyze-owners.js';
export { inferOwnerBindings } from './cross-check.js';
export { firestoreOwnerConditions } from './firestore-owners.js';
export { rtdbOwnerConditions } from './rtdb-owners.js';
export { loadRuleSources, parseRtdbRulesText } from './rule-sources.js';
export type { FirestoreRuleSource, RtdbRuleSource, RuleSources } from './rule-sources.js';
export type { OwnerBinding, OwnerCondition, OwnerEvidence, OwnerKind, OwnerRelation } from './types.js';
