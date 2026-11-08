/**
 * Static SDK usage and access-site extraction over client TypeScript and
 * JavaScript sources.
 */
export { extractAccessSites, countSites } from './extractor.js';
export { isWriteOp } from './operation-specs.js';
export { FIRESTORE_SERVICE_MODEL } from './service-models/firestore.js';
export { RTDB_SERVICE_MODEL } from './service-models/rtdb.js';
export { extractSdkUsage } from './usage-index.js';
export type { EmbeddedRules } from './embedded-rules.js';
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
} from './usage-index.js';
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
} from './types.js';
