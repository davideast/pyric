export { AUTH_SESSION_SCOPE, FOLLOWS_CURRENT_USER } from './listener-routing.js';
export { monitorFirebaseActivity } from '../sandbox/activity-monitor.js';
export {
  ACTIVITY_CONTRACT,
  hasGeneratedActivitySemantics,
} from '../sandbox/activity-contract.js';
export type {
  ActivityFeed,
  ActivityIncident,
  ActivityMonitor,
  ActivityPattern,
  ActivityReport,
  ActivitySourceAttribution,
} from '../sandbox/activity-monitor.js';

// Diagnostic projections do not invoke arbitrary query-operand getters.
export { activityValue } from '../sandbox/activity-query-value.js';
export { activityStructuralIdentity } from '../sandbox/activity-structural-identity.js';

// Served aliases preserve their existing backend path and public observation name.
export { readDocumentAs, readQueryAs } from '../reads.js';
export { atomicWriterCreate } from './atomic-create.js';
export { markHandlePersistentCache } from '../cache-index-manager.js';
export {
  applySettingsCacheMode,
  assertAndRecordAppFirestoreSettings,
  clearAppFirestoreSettings,
  recordImplicitAppFirestoreSettings,
} from '../init-settings.js';
export {
  decodeBundleBytes,
  type BundledFilterSpec,
  type BundledQuerySourceSpec,
  type BundledWhereOp,
} from '../sandbox/bundle-wire.js';
export {
  encodeDocumentSnapshotJson,
  encodeQuerySnapshotJson,
} from '../sandbox/ssr-bundle-encoder.js';
export {
  LoadBundleTask,
  assertBundleInputSupported,
  readBundleSourceBytes,
  type LoadBundleTaskProgress,
} from '../bundles.js';
export { documentId } from '../field-values.js';
export { parseValidatedSnapshotEnvelope, wrapInitialCachedSnapshotArgs } from '../ssr-snapshots.js';
export {
  executeQuery,
  type QueryCursor,
  type QueryExecutionSpec,
  type QueryFilter,
  type QueryOrderClause,
  type QueryWhereFilterOp,
} from '../sandbox/query-execution.js';
export { firestoreValuesEqual } from '../sandbox/value-equality.js';
export {
  DEFAULT_FIRESTORE_DATABASE,
  MAX_FIRESTORE_DATABASES,
  assertValidFirestoreDatabaseDeclaration,
  declareFirestoreDatabase,
  firestoreRecordSpaceKey,
  firestoreRecordSpacePrefix,
  getAdminHandleEnv,
  getClientHandleEnv,
  getDatabaseAdmin,
  getDatabaseEnv,
  getFirestoreDatabaseEnv,
  isFirestoreDatabaseDeclared,
  isValidFirestoreDatabaseId,
  listDeclaredFirestoreDatabases,
  logMissingFirestoreDatabaseNoticeOnce,
  missingFirestoreDatabaseNotFoundMessage,
  normalizeFirestoreDatabaseId,
  onNamedFirestorePersistenceChange,
  parseFirestoreRecordSpaceKey,
  undeclareFirestoreDatabase,
  type DeclareFirestoreDatabaseOptions,
} from '../sandbox/named-databases.js';
export {
  markAllNamedFirestoreDirty,
  parseNamedFirestoreBundleRecords,
  prepareNamedFirestorePersistence,
  readFirestoreDeclaredFromMeta,
  restoreNamedFirestorePersistence,
  serializeNamedFirestoreDocsToBuckets,
  stampFirestoreDeclaredOnMeta,
  type NamedDatabaseFlushDiff,
  type NamedFirestorePersistencePlan,
} from '../sandbox/named-databases-persistence.js';
export {
  getDatabaseChainableAdminFirestore,
  getDatabaseChainableFirestore,
} from '../sandbox/named-compat-handle.js';
