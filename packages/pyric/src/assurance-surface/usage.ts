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
  coverageMatrixPass,
  type ConcretizedPatternResult,
  type CoverageMatrixRuleInput,
  type CoverageMatrixRuntimeInput,
  type RuntimePathObservation,
  type SandboxHistoryEvent,
} from './passes/coverage-matrix.js';
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
export {
  staticQueryProofPass,
  type StaticQueryProofPassOptions,
  type StaticQueryProofRulesConfig,
} from './passes/static-query-proof.js';
export {
  storageContractPass,
  type StorageContractPassConfig,
  type StorageContractPassOptions,
} from './passes/storage-contract.js';
export { firestoreOwnerConditions } from './rules/firestore-owners.js';
export {
  analyzeOwners,
  ownerConditionsFrom,
  withEmbeddedRules,
  type OwnerAnalysis,
} from './rules/analyze-owners.js';
export { inferOwnerBindings } from './rules/cross-check.js';
export { rtdbOwnerConditions } from './rules/rtdb-owners.js';
export {
  loadRuleSources,
  parseRtdbRulesText,
  type FirestoreRuleSource,
  type RtdbRuleSource,
  type RuleSources,
  type StorageRuleSource,
} from './rules/rule-sources.js';
export { projectRuleSurface } from './rules/rule-surface.js';
export { storageOwnerConditions, storageValueHints } from './rules/storage-owners.js';
export { firestoreValueHints, rtdbValueHints } from './rules/value-hints.js';
export { planProbes } from './probes/plan.js';
export {
  probeActors,
  runProbes,
  type ProbeReport,
  type ProbeUser,
  type RunProbesInput,
} from './probes/run-probes.js';
export type {
  Finding,
  FindingKind,
  FindingOp,
  Probe,
  ProbeActor,
  ProbeOutcome,
  ProbeResult,
  ProbeStep,
  StepResult,
} from './probes/types.js';
export type { WorldState } from './probes/world.js';
export {
  loadDiskProject,
  type LoadDiskProjectResult,
  type LoadedDiskFile,
} from '../indexes/disk-project.js';
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
