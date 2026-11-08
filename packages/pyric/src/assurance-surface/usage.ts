/**
 * `pyric/rules/internal/usage`: browser-clean TypeScript SDK usage extractor
 * (`extractSdkUsage`, `SdkUsageIndex`, declarative `SdkServiceModel` tables).
 *
 * Lives under `src/assurance-surface` (mapped from `./rules/internal/usage` in
 * `package.json` exports) so `src/rules` preserves its zero-outward-import
 * engine boundary while `pyric/rules` and `pyric/rules/internal` never pull in
 * the TypeScript compiler unless a caller explicitly opts into static analysis.
 */
export { countSites, extractAccessSites } from './code/extractor.js';
export { isWriteOp } from './code/operation-specs.js';
export { isExcludedPath } from './code/program.js';
export { FIRESTORE_SERVICE_MODEL } from './code/service-models/firestore.js';
export { RTDB_SERVICE_MODEL } from './code/service-models/rtdb.js';
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
} from './code/usage-index.js';
export type {
  PatternSegment,
  ResourcePattern,
} from '../sandbox/internal/resource-pattern.js';
