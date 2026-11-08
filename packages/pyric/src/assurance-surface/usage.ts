/**
 * `pyric/rules/internal/usage`: browser-clean TypeScript SDK usage extractor
 * (`extractSdkUsage`, `SdkUsageIndex`, declarative `SdkServiceModel` tables)
 * and unified `RuleSurface` projection (`projectRuleSurface`).
 *
 * Lives under `src/assurance-surface` (mapped from `./rules/internal/usage` in
 * `package.json` exports) so `src/rules` preserves its zero-outward-import
 * engine boundary while `pyric/rules` and `pyric/rules/internal` never pull in
 * the TypeScript compiler unless a caller explicitly opts into static analysis.
 */
export { countSites, extractAccessSites } from './code/extractor.js';
export { isReadOp, isWriteOp } from './code/operation-specs.js';
export { isExcludedPath } from './code/program.js';
export { FIRESTORE_SERVICE_MODEL } from './code/service-models/firestore.js';
export { RTDB_SERVICE_MODEL } from './code/service-models/rtdb.js';
export { STORAGE_SERVICE_MODEL } from './code/service-models/storage.js';
export { extractSdkUsage } from './code/usage-index.js';
export {
  firestoreIndexPass,
  type FirestoreIndexPassOptions,
  type FirestoreIndexPassResult,
} from './passes/firestore-indexes.js';
export {
  rtdbIndexPass,
  type RtdbIndexPassOptions,
  type RtdbIndexPassResult,
  type RtdbIndexRequirement,
  type RtdbIndexWarning,
} from './passes/rtdb-indexes.js';
export { checkRtdbIndexes } from './passes/rtdb-rules-check.js';
export {
  mergeRtdbIndexes,
  type MergeRtdbIndexesResult,
} from './passes/rtdb-rules-merge.js';
export { firestoreOwnerConditions } from './rules/firestore-owners.js';
export { rtdbOwnerConditions } from './rules/rtdb-owners.js';
export { projectRuleSurface } from './rules/rule-surface.js';
export { storageOwnerConditions, storageValueHints } from './rules/storage-owners.js';
export { firestoreValueHints, rtdbValueHints } from './rules/value-hints.js';
export type { EmbeddedRules } from './code/embedded-rules.js';
export type {
  AccessPreset,
  AccessResolution,
  AccessService,
  AccessSite,
  AccessSiteCounts,
  AccessSiteReport,
  AuthProvenance,
  AuthSource,
  ExtractAccessSitesOptions,
  PathVariable,
  PayloadField,
  PayloadShape,
  QueryConstraint,
  StorageUploadMetadata,
} from './code/types.js';
export type {
  AssuranceService,
  ConstraintOperand,
  ConstraintSpec,
  ExtractSdkUsageOptions,
  FieldValueName,
  HandleFactorySpec,
  OpSpec,
  ReceiverFactorySpec,
  RefConstructorSpec,
  RefKind,
  SdkQuery,
  SdkQueryConstraint,
  SdkRef,
  SdkServiceModel,
  SdkUsageIndex,
  SdkUsagePass,
  UploadPayloadSpec,
} from './code/usage-index.js';
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
} from './rules/rule-surface.js';
export type {
  OwnerBinding,
  OwnerCondition,
  OwnerEvidence,
  OwnerKind,
  OwnerRelation,
} from './rules/types.js';
export type { ValueHint } from './rules/value-hints.js';
export type {
  PatternSegment,
  ResourcePattern,
} from '../sandbox/internal/resource-pattern.js';
