import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeAdminAppCheck } from '../../src/admin/app-check.js';
import { observeAdminAuth } from '../../src/admin/auth.js';
import { observeAdminDatabase } from '../../src/admin/database.js';
import { observeAdminFirestore } from '../../src/admin/firestore.js';
import { observeAdminMessaging } from '../../src/admin/messaging.js';
import { isAdminMethodGated } from '../../src/admin/patch.js';
import { adminProjectGate } from '../../src/admin/project-gate.js';
import { observeAdminStorage } from '../../src/admin/storage.js';
import type { LiveCallRecord, LiveObserver } from '../../src/observe.js';

const HOST_PROJECT = 'canary-host-project';
const HOST_BUCKET = `${HOST_PROJECT}.appspot.com`;
const IS_ISOLATED_WORKER = process.env.PYRIC_CANARY_ISOLATED === '1';

/**
 * Pure-local / non-RPC prototype methods that never send network traffic or
 * represent ADC project-id discovery (`initializeIfNeeded`, `getProjectId`,
 * `getProjectIdAsync`) / local client teardown (`terminate`, `close`).
 */
const PURE_LOCAL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'auth:BaseAuth': [],
  'auth:Auth': ['tenantManager', 'projectConfigManager'],
  'auth:TenantAwareAuth': [],
  'auth:TenantManager': ['authForTenant'],
  'auth:ProjectConfigManager': [],
  'app-check:AppCheck': ['validateVerifyAppCheckTokenOptions'],
  'messaging:Messaging': [
    'enableLegacyHttpTransport', 'parseSendResponses', 'getUrlPath',
    'validateRegistrationTokensType', 'validateRegistrationTokens',
    'validateTopicType', 'validateTopic', 'normalizeTopic',
  ],
  'database:Database': ['useEmulator', 'goOffline'],
  'database:Query': [
    'off', 'limitToFirst', 'limitToLast', 'orderByChild', 'orderByKey',
    'orderByPriority', 'orderByValue', 'startAt', 'startAfter', 'endAt',
    'endBefore', 'equalTo', 'toString', 'toJSON', 'isEqual',
  ],
  'database:Reference': ['getKey', 'child', 'getParent', 'getRoot', 'onDisconnect'],
  'database:OnDisconnect': [],
  'database:ModularOnDisconnect': [],
  'firestore:Firestore': [
    'getBulkWriter', 'settings', 'validateAndApplySettings', 'newTraceUtilInstance',
    'doc', 'collection', 'collectionGroup', 'batch', 'bulkWriter', 'snapshot_',
    'bundle', 'registerListener', 'unregisterListener', '_incrementBulkWritersCount',
    '_decrementBulkWritersCount', 'terminate', 'toJSON', 'initializeIfNeeded', 'createCallOptions',
  ],
  'firestore:DocumentReference': ['collection', 'isEqual', 'toProto', 'withConverter'],
  'firestore:CollectionReference': ['doc', 'isEqual', 'withConverter'],
  'firestore:Query': [
    'where', '_parseFilter', '_parseFieldFilter', '_parseCompositeFilter',
    'select', 'orderBy', 'limit', 'limitToLast', 'offset', 'count', 'aggregate',
    'findNearest', '_findNearest', 'isEqual', 'getInequalityFilterFields',
    'createImplicitOrderBy', 'createCursor', 'validateReference', 'startAt',
    'startAfter', 'endBefore', 'endAt', 'toCursor', 'toProto', '_toBundledQuery',
    'toStructuredQuery', '_isPermanentRpcError', '_hasRetryTimedOut', 'comparator',
    'withConverter', '_createSnapshot',
  ],
  'firestore:CollectionGroup': ['withConverter'],
  'firestore:AggregateQuery': ['decodeResult', 'toProto', 'isEqual'],
  'firestore:VectorQuery': ['toProto', '_createSnapshot', 'startAfter', 'isEqual'],
  'firestore:WriteBatch': ['verifyNotCommitted', 'create', 'delete', 'set', 'update', '_reset'],
  'firestore:Transaction': ['create', 'set', 'update', 'delete'],
  'firestore:BulkWriter': [
    '_getBufferedOperationsCount', '_setMaxBatchSize', '_setMaxPendingOpCount',
    'onWriteResult', 'onWriteError', '_verifyNotClosed', '_scheduleCurrentBatch',
    '_enqueue', '_processBufferedOps',
  ],
  'firestore:v1.FirestoreClient': ['initialize', 'getProjectId', 'close'],
  'firestore:v1.FirestoreAdminClient': [
    'initialize', 'getProjectId', 'close',
    'backupPath', 'matchProjectFromBackupName', 'matchLocationFromBackupName', 'matchBackupFromBackupName',
    'backupSchedulePath', 'matchProjectFromBackupScheduleName', 'matchDatabaseFromBackupScheduleName', 'matchBackupScheduleFromBackupScheduleName',
    'collectionGroupPath', 'matchProjectFromCollectionGroupName', 'matchDatabaseFromCollectionGroupName', 'matchCollectionFromCollectionGroupName',
    'databasePath', 'matchProjectFromDatabaseName', 'matchDatabaseFromDatabaseName',
    'fieldPath', 'matchProjectFromFieldName', 'matchDatabaseFromFieldName', 'matchCollectionFromFieldName', 'matchFieldFromFieldName',
    'indexPath', 'matchProjectFromIndexName', 'matchDatabaseFromIndexName', 'matchCollectionFromIndexName', 'matchIndexFromIndexName',
    'locationPath', 'matchProjectFromLocationName', 'matchLocationFromLocationName',
    'projectPath', 'matchProjectFromProjectName',
  ],
  'firestore:v1beta1.FirestoreClient': ['initialize', 'getProjectId', 'close'],
  'storage:AdminStorageWrapper': ['bucket'],
  'storage:Service': ['getRequestInterceptors', 'getProjectId', 'getProjectIdAsync'],
  'storage:ServiceObject': ['getRequestInterceptors'],
  'storage:Storage': ['bucket', 'channel', 'hmacKey'],
  'storage:Bucket': ['file', 'notification', 'getId', 'disableAutoRetryConditionallyIdempotent_'],
  'storage:File': [
    'shouldRetryBasedOnPreconditionAndIdempotencyStrat', 'setEncryptionKey',
    'publicUrl', 'disableAutoRetryConditionallyIdempotent_', 'getBufferFromReadable',
  ],
  'storage:Acl': ['makeAclObject_'],
  'storage:AclRoleAccessorMethods': ['_assignAccessMethods'],
  'storage:Iam': [],
  'storage:HmacKey': [],
  'storage:Channel': [],
  'storage:Notification': [],
  'storage:TransferManager': ['getPathsFromDirectory'],
};

/**
 * Pure value, data-model, snapshot, checksum, and error constructors exported by
 * the Admin SDK packages that hold no network client or RPC transport.
 */
const PURE_VALUE_CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set([
  'Tenant', 'ProjectConfig', 'MultiFactorInfo', 'MultiFactorSettings',
  'PhoneMultiFactorInfo', 'UserInfo', 'UserMetadata', 'UserRecord',
  'FirebaseAuthError', 'AuthClientErrorCode',
  'Aggregate', 'AggregateField', 'AggregateQuerySnapshot', 'BundleBuilder',
  'DocumentChange', 'DocumentSnapshot', 'FieldPath', 'FieldValue', 'Filter',
  'FirebaseFirestoreError', 'GeoPoint', 'QueryDocumentSnapshot', 'QueryPartition',
  'QuerySnapshot', 'Timestamp', 'VectorValue', 'WriteResult',
  'ApiError', 'CRC32C', 'CRC32C_DEFAULT_VALIDATOR_GENERATOR', 'HashStreamValidator',
  'MultiPartUploadError', 'RETRYABLE_ERR_FN_DEFAULT',
  'INVALID_INIT_BASE64_RANGE', 'INVALID_INIT_BUFFER_LENGTH', 'INVALID_INIT_INTEGER',
  'DataSnapshot', 'FirebaseDatabaseError',
  'FirebaseMessagingError', 'MessagingClientErrorCode',
]);

/** Instance-own pure-local or delegating helper functions assigned in constructors. */
const INSTANCE_FUNCTION_ALLOWLIST: ReadonlySet<string> = new Set([
  'crc32cGenerator',
  'createMethod',
]);

interface AnyRecord {
  [key: string]: ((...args: unknown[]) => AnyRecord) & AnyRecord;
}

const requireHere = createRequire(import.meta.url);
const authEntry = requireHere.resolve('firebase-admin/auth');
const authPkg = requireHere('firebase-admin/auth') as Record<string, unknown>;
const authRequire = createRequire(authEntry);
const baseAuthMod = authRequire('./base-auth') as { BaseAuth: { prototype: object } };
const authMod = authRequire('./auth') as { Auth: { prototype: object } };
const tenantManagerMod = authRequire('./tenant-manager') as {
  TenantAwareAuth: { prototype: object };
  TenantManager: { prototype: object };
};
const projectConfigMod = authRequire('./project-config-manager') as {
  ProjectConfigManager: { prototype: object };
};
const appCheckPkg = requireHere('firebase-admin/app-check') as Record<string, unknown>;
const appCheckMod = createRequire(requireHere.resolve('firebase-admin/app-check'))('./app-check') as {
  AppCheck: { prototype: object };
};
const messagingPkg = requireHere('firebase-admin/messaging') as Record<string, unknown>;
const messagingMod = createRequire(requireHere.resolve('firebase-admin/messaging'))('./messaging') as {
  Messaging: { prototype: object };
};
const dbPkg = requireHere('firebase-admin/database') as Record<string, unknown>;
const dbRequire = createRequire(requireHere.resolve('firebase-admin/database'));
const dbSdk = dbRequire('@firebase/database-compat/standalone') as {
  Database: { prototype: object };
  Query: { prototype: object };
  Reference: { prototype: object };
  OnDisconnect: { prototype: object };
} & Record<string, unknown>;
const fsPkg = requireHere('firebase-admin/firestore') as Record<string, unknown>;
const fsRequire = createRequire(requireHere.resolve('firebase-admin/firestore'));
const fsEntry = fsRequire.resolve('@google-cloud/firestore');
const fsSdk = fsRequire(fsEntry) as Record<string, { prototype: object }> & {
  v1: { FirestoreClient: { prototype: object }; FirestoreAdminClient: { prototype: object } };
  v1beta1: { FirestoreClient: { prototype: object } };
};
const fsInternalRequire = createRequire(fsEntry);
const { AggregateQuery } = fsInternalRequire('./reference/aggregate-query.js') as {
  AggregateQuery: { prototype: object };
};
const VectorQuery =
  fsSdk.VectorQuery ??
  (fsInternalRequire('./reference/vector-query.js') as { VectorQuery: { prototype: object } }).VectorQuery;

const stPkg = requireHere('firebase-admin/storage') as Record<string, unknown> & {
  Storage: { prototype: object };
};
const stRequire = createRequire(requireHere.resolve('firebase-admin/storage'));
const stEntry = stRequire.resolve('@google-cloud/storage');
const stSdk = stRequire(stEntry) as Record<string, { prototype: object }>;
const stInternalRequire = createRequire(stEntry);
const { Acl, AclRoleAccessorMethods } = stInternalRequire('./acl.js') as {
  Acl: { prototype: object };
  AclRoleAccessorMethods: { prototype: object };
};
const ServiceObjectProto = Object.getPrototypeOf(stSdk.Bucket!.prototype) as object;
const ServiceProto = Object.getPrototypeOf(stSdk.Storage!.prototype) as object;

const adminApp = requireHere('firebase-admin/app') as {
  initializeApp(options: object, name: string): { delete(): Promise<void> };
};
const { getAuth } = requireHere('firebase-admin/auth') as { getAuth(app: object): AnyRecord };
const { getFirestore } = requireHere('firebase-admin/firestore') as { getFirestore(app: object): AnyRecord };
const { getStorage } = requireHere('firebase-admin/storage') as { getStorage(app: object): AnyRecord };
const { getDatabase } = requireHere('firebase-admin/database') as { getDatabase(app: object): AnyRecord };

function collectExportedConstructors(
  pkgLabel: string,
  mod: unknown,
  visited = new Set<unknown>(),
): Array<{ label: string; name: string; proto: object }> {
  if ((typeof mod !== 'object' && typeof mod !== 'function') || mod === null || visited.has(mod)) {
    return [];
  }
  visited.add(mod);
  const found: Array<{ label: string; name: string; proto: object }> = [];
  for (const prop of Object.getOwnPropertyNames(mod)) {
    if (
      prop === 'default' || prop === 'prototype' || prop === 'length' || prop === 'name' ||
      prop === 'caller' || prop === 'arguments' || prop === 'servicePath' ||
      prop === 'apiEndpoint' || prop === 'port' || prop === 'scopes' || prop === 'dnsPath'
    ) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(mod, prop);
    if (desc === undefined) continue;
    const val: unknown = 'value' in desc ? desc.value : Reflect.get(mod as object, prop);
    if (typeof val === 'function') {
      const proto: unknown = Reflect.get(val, 'prototype');
      let protoMethods: string[] = [];
      if (typeof proto === 'object' && proto !== null) {
        protoMethods = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor');
      }
      if (typeof proto === 'object' && proto !== null && (protoMethods.length > 0 || /^[A-Z]/.test(prop))) {
        found.push({ label: `${pkgLabel}.${prop}`, name: prop, proto });
      }
      found.push(...collectExportedConstructors(`${pkgLabel}.${prop}`, val, visited));
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      found.push(...collectExportedConstructors(`${pkgLabel}.${prop}`, val, visited));
    }
  }
  return found;
}

describe.skipIf(IS_ISOLATED_WORKER)('AdminProjectGate structural prototype-reflection canary (isolated)', () => {
  it('verifies dynamic export/namespace discovery and prototype reflection completeness in a fresh module graph', () => {
    const cleanHome = mkdtempSync(join(tmpdir(), 'pyric-canary-home-'));
    try {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: cleanHome,
        NO_GCE_CHECK: 'true',
        PYRIC_CANARY_ISOLATED: '1',
      };
      delete childEnv.GOOGLE_APPLICATION_CREDENTIALS;
      delete childEnv.CLOUDSDK_CONFIG;
      const child = spawnSync(process.execPath, ['test', fileURLToPath(import.meta.url)], {
        env: childEnv,
        encoding: 'utf8',
      });
      if (child.status !== 0) {
        throw new Error(`Isolated canary failed (exit ${String(child.status)}):\n${child.stdout}\n${child.stderr}`);
      }
      expect(child.status).toBe(0);
    } finally {
      rmSync(cleanHome, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(!IS_ISOLATED_WORKER)('AdminProjectGate structural prototype-reflection canary', () => {
  let hostApp: { delete(): Promise<void> };

  beforeAll(() => {
    const observer: LiveObserver = Object.assign(
      (_record: LiveCallRecord) => undefined,
      { client: 'node' as const, hostProjectId: HOST_PROJECT },
    );
    const gate = adminProjectGate(HOST_PROJECT, () => undefined, {});
    observeAdminAuth(baseAuthMod, { observer, gate, hostProjectId: HOST_PROJECT }, authEntry);
    observeAdminAppCheck(appCheckMod, { gate });
    observeAdminMessaging(messagingMod, { observer, gate });
    observeAdminDatabase(dbSdk, { observer, gate, hostProjectId: HOST_PROJECT });
    observeAdminFirestore(fsSdk, fsEntry, { observer, gate });
    observeAdminStorage(stSdk, stEntry, { observer, gate });

    hostApp = adminApp.initializeApp(
      {
        projectId: HOST_PROJECT,
        storageBucket: HOST_BUCKET,
        databaseURL: `https://${HOST_PROJECT}-default-rtdb.firebaseio.com`,
      },
      'canary-reflection-host',
    );
  });

  afterAll(async () => {
    const hostFs = getFirestore(hostApp);
    await hostFs.terminate!();
    await hostApp?.delete();
  });

  it('discovers all exported constructors/namespaces and marks every non-allowlisted method with ADMIN_METHOD_GATED', () => {
    const hostDb = getDatabase(hostApp);
    (hostDb.goOffline as () => void)();
    const compatOnDisconnect = (hostDb.ref!('items/1') as AnyRecord).onDisconnect!() as object;
    const compatOnDisconnectProto = Object.getPrototypeOf(compatOnDisconnect) as object;

    const prototypes: readonly [string, object][] = [
      ['auth:BaseAuth', baseAuthMod.BaseAuth.prototype],
      ['auth:Auth', authMod.Auth.prototype],
      ['auth:TenantAwareAuth', tenantManagerMod.TenantAwareAuth.prototype],
      ['auth:TenantManager', tenantManagerMod.TenantManager.prototype],
      ['auth:ProjectConfigManager', projectConfigMod.ProjectConfigManager.prototype],
      ['app-check:AppCheck', appCheckMod.AppCheck.prototype],
      ['messaging:Messaging', messagingMod.Messaging.prototype],
      ['database:Database', dbSdk.Database.prototype],
      ['database:Query', dbSdk.Query.prototype],
      ['database:Reference', dbSdk.Reference.prototype],
      ['database:OnDisconnect', compatOnDisconnectProto],
      ['database:ModularOnDisconnect', dbSdk.OnDisconnect.prototype],
      ['firestore:Firestore', fsSdk.Firestore!.prototype],
      ['firestore:DocumentReference', fsSdk.DocumentReference!.prototype],
      ['firestore:CollectionReference', fsSdk.CollectionReference!.prototype],
      ['firestore:Query', fsSdk.Query!.prototype],
      ['firestore:CollectionGroup', fsSdk.CollectionGroup!.prototype],
      ['firestore:AggregateQuery', AggregateQuery.prototype],
      ['firestore:VectorQuery', VectorQuery.prototype],
      ['firestore:WriteBatch', fsSdk.WriteBatch!.prototype],
      ['firestore:Transaction', fsSdk.Transaction!.prototype],
      ['firestore:BulkWriter', fsSdk.BulkWriter!.prototype],
      ['firestore:v1.FirestoreClient', fsSdk.v1.FirestoreClient.prototype],
      ['firestore:v1.FirestoreAdminClient', fsSdk.v1.FirestoreAdminClient.prototype],
      ['firestore:v1beta1.FirestoreClient', fsSdk.v1beta1.FirestoreClient.prototype],
      ['storage:AdminStorageWrapper', stPkg.Storage.prototype],
      ['storage:Service', ServiceProto],
      ['storage:ServiceObject', ServiceObjectProto],
      ['storage:Storage', stSdk.Storage!.prototype],
      ['storage:Bucket', stSdk.Bucket!.prototype],
      ['storage:File', stSdk.File!.prototype],
      ['storage:Acl', Acl.prototype],
      ['storage:AclRoleAccessorMethods', AclRoleAccessorMethods.prototype],
      ['storage:Iam', stSdk.Iam!.prototype],
      ['storage:HmacKey', stSdk.HmacKey!.prototype],
      ['storage:Channel', stSdk.Channel!.prototype],
      ['storage:Notification', stSdk.Notification!.prototype],
      ['storage:TransferManager', stSdk.TransferManager!.prototype],
    ];

    const knownPrototypes = new Set<object>([
      Object.prototype,
      EventEmitter.prototype,
      ...prototypes.map(([, proto]) => proto),
    ]);

    // 1. Dynamic export & sub-namespace walk across all 6 Admin packages and underlying SDKs.
    const moduleRoots: readonly [string, unknown][] = [
      ['firebase-admin/auth', authPkg],
      ['firebase-admin/app-check', appCheckPkg],
      ['firebase-admin/messaging', messagingPkg],
      ['firebase-admin/database', dbPkg],
      ['@firebase/database-compat/standalone', dbSdk],
      ['firebase-admin/firestore', fsPkg],
      ['@google-cloud/firestore', fsSdk],
      ['firebase-admin/storage', stPkg],
      ['@google-cloud/storage', stSdk],
    ];
    const unauditedExports: string[] = [];
    for (const [pkgLabel, mod] of moduleRoots) {
      for (const item of collectExportedConstructors(pkgLabel, mod)) {
        if (knownPrototypes.has(item.proto) || PURE_VALUE_CONSTRUCTOR_NAMES.has(item.name)) {
          continue;
        }
        unauditedExports.push(item.label);
      }
    }
    expect(unauditedExports).toEqual([]);

    // 2. Reachable instance prototype chain & constructor-assigned own function audit.
    const hostAuth = getAuth(hostApp);
    const hostFs = getFirestore(hostApp);
    const hostBucket = getStorage(hostApp).bucket!(HOST_BUCKET) as AnyRecord;
    const hostStClient = hostBucket.storage;
    const reachableHandles: readonly [string, unknown][] = [
      ['auth', hostAuth],
      ['tenantManager', hostAuth.tenantManager!()],
      ['tenantAwareAuth', hostAuth.tenantManager!().authForTenant!('tenant-a')],
      ['projectConfigManager', hostAuth.projectConfigManager!()],
      ['firestore', hostFs],
      ['docRef', hostFs.doc!('items/1')],
      ['colRef', hostFs.collection!('items')],
      ['colGroup', hostFs.collectionGroup!('items')],
      ['aggQuery', hostFs.collection!('items').count!()],
      ['vecQuery', hostFs.collection!('items').findNearest!('emb', [1, 2], { limit: 1, distanceMeasure: 'COSINE' })],
      ['batch', hostFs.batch!()],
      ['storage', hostStClient],
      ['bucket', hostBucket],
      ['bucket.acl', hostBucket.acl],
      ['bucket.acl.default', hostBucket.acl!.default],
      ['bucket.iam', hostBucket.iam],
      ['file', hostBucket.file!('docs/a.txt')],
      ['file.acl', hostBucket.file!('docs/a.txt').acl],
      ['hmacKey', hostStClient!.hmacKey!('GOOG1EKEY')],
      ['channel', hostStClient!.channel!('ch-1', 'res-1')],
      ['notification', hostBucket.notification!('1')],
      ['onDisconnect', compatOnDisconnect],
    ];

    const unknownPrototypes: string[] = [];
    const ungatedOwnFunctions: string[] = [];
    for (const [label, handle] of reachableHandles) {
      if (typeof handle !== 'object' || handle === null) continue;
      for (const ownKey of Object.getOwnPropertyNames(handle)) {
        const desc = Object.getOwnPropertyDescriptor(handle, ownKey);
        if (typeof desc?.value !== 'function') continue;
        if (!isAdminMethodGated(desc.value) && !INSTANCE_FUNCTION_ALLOWLIST.has(ownKey)) {
          ungatedOwnFunctions.push(`${label}.${ownKey}`);
        }
      }
      let cursor: object | null = Object.getPrototypeOf(handle);
      while (cursor !== null) {
        if (!knownPrototypes.has(cursor)) {
          unknownPrototypes.push(`${label} -> ${cursor.constructor?.name ?? 'anonymous'}`);
        }
        cursor = Object.getPrototypeOf(cursor);
      }
    }
    expect(unknownPrototypes).toEqual([]);
    expect(ungatedOwnFunctions).toEqual([]);

    // 3. Prototype method completeness & stale-allowlist audit.
    const ungated: string[] = [];
    const redundantAllowlist: string[] = [];
    for (const [key, proto] of prototypes) {
      const allowed = new Set(PURE_LOCAL_ALLOWLIST[key] ?? []);
      const ownNames = new Set(Object.getOwnPropertyNames(proto));
      for (const name of ownNames) {
        if (name === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor === undefined) continue;
        const isMethod = typeof descriptor.value === 'function';
        const isGatedAccessor = isAdminMethodGated(descriptor.get);
        if (!isMethod && !isGatedAccessor) continue;
        const gated = isMethod ? isAdminMethodGated(descriptor.value) : isGatedAccessor;
        if (gated && allowed.has(name)) {
          redundantAllowlist.push(`${key}.${name} (both gated and allowlisted)`);
        } else if (!gated && !allowed.has(name)) {
          ungated.push(`${key}.${name}`);
        }
      }
      for (const allowlisted of allowed) {
        if (!ownNames.has(allowlisted)) {
          redundantAllowlist.push(`${key}.${allowlisted} (missing from prototype)`);
        }
      }
    }

    expect(redundantAllowlist).toEqual([]);
    expect(ungated).toEqual([]);

    for (const rulesMethod of ['getRules', 'getRulesJSON', 'setRules']) {
      const desc = Object.getOwnPropertyDescriptor(dbSdk.Database.prototype, rulesMethod);
      expect(isAdminMethodGated(desc?.get)).toBe(true);
    }
  });
});
