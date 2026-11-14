import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { Readable } from 'node:stream';
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
const OTHER_PROJECT = 'canary-other-project';
const HOST_BUCKET = `${HOST_PROJECT}.appspot.com`;
const OTHER_BUCKET = `${OTHER_PROJECT}.appspot.com`;

/**
 * Pure-local / non-RPC prototype methods that never send network traffic or
 * represent ADC project-id discovery (`initializeIfNeeded`, `getProjectId`,
 * `getProjectIdAsync`) / local client teardown (`terminate`).
 *
 * Every method on every reachable Admin SDK prototype MUST either carry
 * `ADMIN_METHOD_GATED` or appear in this explicit per-class allowlist.
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
  'firestore:Transaction': [
    'create', 'set', 'update', 'delete', 'withLazyStartedTransaction',
    'getSingleFn', 'getBatchFn', 'getQueryFn',
  ],
  'firestore:BulkWriter': [
    '_getBufferedOperationsCount', '_setMaxBatchSize', '_setMaxPendingOpCount',
    'onWriteResult', 'onWriteError', '_verifyNotClosed', '_scheduleCurrentBatch',
    '_enqueue', '_processBufferedOps',
  ],
  'storage:Service': ['getRequestInterceptors', 'getProjectId', 'getProjectIdAsync'],
  'storage:ServiceObject': ['getRequestInterceptors'],
  'storage:Storage': ['bucket', 'channel', 'hmacKey'],
  'storage:Bucket': ['file', 'notification', 'setUserProject', 'getId', 'disableAutoRetryConditionallyIdempotent_'],
  'storage:File': [
    'shouldRetryBasedOnPreconditionAndIdempotencyStrat', 'setEncryptionKey',
    'publicUrl', 'setUserProject', 'disableAutoRetryConditionallyIdempotent_', 'getBufferFromReadable',
  ],
  'storage:Acl': ['makeAclObject_'],
  'storage:AclRoleAccessorMethods': ['_assignAccessMethods'],
  'storage:Iam': [],
  'storage:HmacKey': [],
  'storage:Channel': [],
  'storage:Notification': [],
  'storage:TransferManager': ['getPathsFromDirectory'],
};

interface AnyRecord {
  [key: string]: ((...args: unknown[]) => unknown) & AnyRecord;
}

const requireHere = createRequire(import.meta.url);
const authEntry = requireHere.resolve('firebase-admin/auth');
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
const appCheckMod = createRequire(requireHere.resolve('firebase-admin/app-check'))('./app-check') as {
  AppCheck: { prototype: object };
};
const messagingMod = createRequire(requireHere.resolve('firebase-admin/messaging'))('./messaging') as {
  Messaging: { prototype: object };
};
const dbRequire = createRequire(requireHere.resolve('firebase-admin/database'));
const dbSdk = dbRequire('@firebase/database-compat/standalone') as {
  Database: { prototype: object };
  Query: { prototype: object };
  Reference: { prototype: object };
  OnDisconnect: { prototype: object };
};
const fsRequire = createRequire(requireHere.resolve('firebase-admin/firestore'));
const fsEntry = fsRequire.resolve('@google-cloud/firestore');
const fsSdk = fsRequire(fsEntry) as Record<string, { prototype: object }>;
const fsInternalRequire = createRequire(fsEntry);
const { AggregateQuery } = fsInternalRequire('./reference/aggregate-query.js') as {
  AggregateQuery: { prototype: object };
};
const VectorQuery =
  fsSdk.VectorQuery ??
  (fsInternalRequire('./reference/vector-query.js') as { VectorQuery: { prototype: object } }).VectorQuery;

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
const { getFirestore } = requireHere('firebase-admin/firestore') as {
  getFirestore(app: object, databaseId?: string): AnyRecord;
};
const { getStorage } = requireHere('firebase-admin/storage') as { getStorage(app: object): AnyRecord };
const { getDatabase } = requireHere('firebase-admin/database') as { getDatabase(app: object): AnyRecord };

function rejectedCode(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => 'RESOLVED',
    (err: unknown) => String((err as { code?: unknown })?.code ?? (err as Error)?.message),
  );
}

function streamOutcome(stream: Readable): Promise<{ status: 'ok'; items: unknown[] } | { status: 'error'; code: string }> {
  return new Promise((resolve) => {
    const items: unknown[] = [];
    stream.on('data', (chunk: unknown) => items.push(chunk));
    stream.once('error', (err: unknown) => {
      resolve({ status: 'error', code: String((err as { code?: unknown })?.code ?? err) });
    });
    stream.once('end', () => resolve({ status: 'ok', items }));
  });
}

const IS_ISOLATED_WORKER = process.env.PYRIC_CANARY_ISOLATED === '1';

describe.skipIf(IS_ISOLATED_WORKER)('AdminProjectGate structural prototype-reflection canary (isolated)', () => {
  it('verifies prototype reflection completeness and behavioral refusals in a fresh module graph', () => {
    const child = spawnSync(process.execPath, ['test', fileURLToPath(import.meta.url)], {
      env: { ...process.env, PYRIC_CANARY_ISOLATED: '1' },
      encoding: 'utf8',
    });
    if (child.status !== 0) {
      throw new Error(`Isolated canary failed (exit ${String(child.status)}):\n${child.stdout}\n${child.stderr}`);
    }
    expect(child.status).toBe(0);
  });
});

describe.skipIf(!IS_ISOLATED_WORKER)('AdminProjectGate structural prototype-reflection canary', () => {
  const records: LiveCallRecord[] = [];
  const observer: LiveObserver = Object.assign(
    (record: LiveCallRecord) => {
      records.push(record);
    },
    { client: 'node' as const, hostProjectId: HOST_PROJECT },
  );

  let httpServer: HttpServer;
  let grpcHole: NetServer;
  let httpRequests: string[] = [];
  let grpcConnections = 0;
  let hostApp: { delete(): Promise<void> };
  let otherApp: { delete(): Promise<void> };
  let adcOtherApp: { delete(): Promise<void> };
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of [
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'STORAGE_EMULATOR_HOST',
      'FIREBASE_DATABASE_EMULATOR_HOST',
      'GOOGLE_CLOUD_PROJECT',
    ]) {
      prevEnv[key] = process.env[key];
    }

    httpServer = createServer((req, res) => {
      const url = req.url ?? '/';
      httpRequests.push(`${req.method ?? 'GET'} ${url}`);
      res.setHeader('content-type', 'application/json');
      if (url.includes('/tenants')) {
        res.end(JSON.stringify({ tenants: [] }));
        return;
      }
      if (url.includes('/config')) {
        res.end(JSON.stringify({ name: `projects/${HOST_PROJECT}/config` }));
        return;
      }
      if (url.includes('/acl')) {
        res.end(JSON.stringify({ items: [{ entity: 'project-owners-1', role: 'OWNER' }] }));
        return;
      }
      if (url.includes('/b?') || url.endsWith('/b')) {
        res.end(JSON.stringify({ items: [{ id: HOST_BUCKET, name: HOST_BUCKET }] }));
        return;
      }
      if (url.includes('/o?') || url.endsWith('/o')) {
        res.end(JSON.stringify({ items: [{ name: 'docs/readme.txt', bucket: HOST_BUCKET }] }));
        return;
      }
      res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = (httpServer.address() as { port: number }).port;

    grpcHole = createNetServer((socket) => {
      grpcConnections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => grpcHole.listen(0, '127.0.0.1', resolve));
    const grpcPort = (grpcHole.address() as { port: number }).port;

    process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${httpPort}`;
    process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${httpPort}`;
    process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${grpcPort}`;
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = `127.0.0.1:${grpcPort}`;
    process.env.GOOGLE_CLOUD_PROJECT = HOST_PROJECT;

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
      'canary-host',
    );
    otherApp = adminApp.initializeApp(
      {
        projectId: OTHER_PROJECT,
        storageBucket: OTHER_BUCKET,
        databaseURL: `https://${OTHER_PROJECT}-default-rtdb.firebaseio.com`,
      },
      'canary-other',
    );
    adcOtherApp = adminApp.initializeApp(
      {
        credential: {
          getAccessToken: async () => ({ access_token: 'stub', expires_in: 3600 }),
          getProjectId: async () => OTHER_PROJECT,
        },
        databaseURL: `https://${HOST_PROJECT}-default-rtdb.firebaseio.com`,
      },
      'canary-adc-other',
    );
  });

  afterAll(async () => {
    const hostFs = getFirestore(hostApp);
    const otherFs = getFirestore(otherApp);
    await (hostFs.terminate as () => Promise<void>)();
    await (otherFs.terminate as () => Promise<void>)();
    await Promise.all([hostApp?.delete(), otherApp?.delete(), adcOtherApp?.delete()]);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => grpcHole.close(() => resolve()));
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('marks every non-allowlisted method on every reachable Admin SDK prototype with ADMIN_METHOD_GATED', () => {
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

    const hostAuth = getAuth(hostApp);
    const hostFs = getFirestore(hostApp);
    const hostBucket = getStorage(hostApp).bucket!(HOST_BUCKET) as AnyRecord;
    const hostStClient = hostBucket.storage as AnyRecord;
    const reachableHandles: readonly [string, unknown][] = [
      ['auth', hostAuth],
      ['tenantManager', hostAuth.tenantManager!()],
      ['tenantAwareAuth', (hostAuth.tenantManager!() as AnyRecord).authForTenant!('tenant-a')],
      ['projectConfigManager', hostAuth.projectConfigManager!()],
      ['firestore', hostFs],
      ['docRef', hostFs.doc!('items/1')],
      ['colRef', hostFs.collection!('items')],
      ['colGroup', hostFs.collectionGroup!('items')],
      ['aggQuery', (hostFs.collection!('items') as AnyRecord).count!()],
      [
        'vecQuery',
        (hostFs.collection!('items') as AnyRecord).findNearest!('emb', [1, 2], {
          limit: 1,
          distanceMeasure: 'COSINE',
        }),
      ],
      ['batch', hostFs.batch!()],
      ['storage', hostStClient],
      ['bucket', hostBucket],
      ['bucket.acl', hostBucket.acl],
      ['bucket.acl.default', (hostBucket.acl as AnyRecord).default],
      ['bucket.iam', hostBucket.iam],
      ['file', hostBucket.file!('docs/a.txt')],
      ['file.acl', (hostBucket.file!('docs/a.txt') as AnyRecord).acl],
      ['hmacKey', hostStClient.hmacKey!('GOOG1EKEY')],
      ['channel', hostStClient.channel!('ch-1', 'res-1')],
      ['notification', hostBucket.notification!('1')],
      ['onDisconnect', compatOnDisconnect],
    ];

    const unknownPrototypes: string[] = [];
    for (const [label, handle] of reachableHandles) {
      let cursor: object | null = typeof handle === 'object' && handle !== null ? Object.getPrototypeOf(handle) : null;
      while (cursor !== null) {
        if (!knownPrototypes.has(cursor)) {
          unknownPrototypes.push(`${label} -> ${cursor.constructor?.name ?? 'anonymous'}`);
        }
        cursor = Object.getPrototypeOf(cursor);
      }
    }
    expect(unknownPrototypes).toEqual([]);

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

  it('refuses cross-project, named-database, and cross-bucket calls across sub-managers, queries, streams, and handles with zero network traffic', async () => {
    httpRequests = [];
    grpcConnections = 0;
    const beforeRecords = records.length;

    const otherAuth = getAuth(otherApp);
    const otherTm = otherAuth.tenantManager!() as AnyRecord;
    const otherTenantAuth = otherTm.authForTenant!('tenant-alpha') as AnyRecord;
    const otherPcm = otherAuth.projectConfigManager!() as AnyRecord;

    expect(await rejectedCode(otherTm.listTenants!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTm.getTenant!('tenant-alpha') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTm.createTenant!({ displayName: 'Alpha' }) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTm.updateTenant!('tenant-alpha', { displayName: 'Beta' }) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTm.deleteTenant!('tenant-alpha') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTenantAuth.verifyIdToken!('invalid-jwt') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTenantAuth.createSessionCookie!('', { expiresIn: 1000 }) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherTenantAuth.verifySessionCookie!('') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherPcm.getProjectConfig!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherPcm.updateProjectConfig!({}) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');

    const otherFs = getFirestore(otherApp);
    const namedFs = getFirestore(hostApp, 'analytics-db');
    for (const db of [otherFs, namedFs]) {
      const col = db.collection!('items') as AnyRecord;
      const vec = col.findNearest!('emb', [0.1, 0.2], { limit: 2, distanceMeasure: 'COSINE' }) as AnyRecord;
      const agg = col.count!() as AnyRecord;
      const group = db.collectionGroup!('items') as AnyRecord;
      expect(await rejectedCode(vec.get!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(vec.explain!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(col.explain!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(agg.explain!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await streamOutcome(col.stream!() as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
      expect(await streamOutcome(col.explainStream!() as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });

      const partitionGen = group.getPartitions!(4) as AsyncIterable<unknown>;
      const iterCode = await (async () => {
        try {
          for await (const _ of partitionGen) {
            // Unreachable when refused.
          }
          return 'RESOLVED';
        } catch (err) {
          return String((err as { code?: unknown })?.code ?? err);
        }
      })();
      expect(iterCode).toBe('PYRIC_LIVE_REFUSED');
    }
    await (namedFs.terminate as () => Promise<void>)();

    const otherBucket = getStorage(otherApp).bucket!(OTHER_BUCKET) as AnyRecord;
    const otherSt = otherBucket.storage as AnyRecord;
    const crossBucketOnHost = getStorage(hostApp).bucket!(OTHER_BUCKET) as AnyRecord;
    const hostSt = (getStorage(hostApp).bucket!(HOST_BUCKET) as AnyRecord).storage as AnyRecord;

    expect(await rejectedCode(otherSt.getBuckets!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await streamOutcome(otherSt.getBucketsStream!() as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
    expect(await rejectedCode(otherSt.createBucket!('any-bucket') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(hostSt.createBucket!(OTHER_BUCKET) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherSt.getHmacKeys!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await streamOutcome(otherSt.getHmacKeysStream!() as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
    expect(await rejectedCode(otherSt.createHmacKey!('sa@example.iam.gserviceaccount.com') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(otherSt.getServiceAccount!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode((otherSt.hmacKey!('GOOG1E') as AnyRecord).getMetadata!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode((otherSt.hmacKey!('GOOG1E') as AnyRecord).setMetadata!({ state: 'INACTIVE' }) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode((otherSt.channel!('ch', 'res') as AnyRecord).stop!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');

    for (const bucket of [otherBucket, crossBucketOnHost]) {
      expect(await streamOutcome(bucket.getFilesStream!() as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
      expect(await rejectedCode(bucket.makePublic!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(bucket.getNotifications!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode((bucket.acl as AnyRecord).get!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(((bucket.acl as AnyRecord).owners as AnyRecord).addUser!('a@example.com') as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(((bucket.acl as AnyRecord).default as AnyRecord).get!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode((bucket.iam as AnyRecord).getPolicy!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(((bucket.file!('doc.txt') as AnyRecord).acl as AnyRecord).get!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode((bucket.notification!('1') as AnyRecord).getMetadata!() as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
      const tm = new (stSdk.TransferManager as unknown as new (b: unknown) => AnyRecord)(bucket);
      expect(await rejectedCode(tm.downloadManyFiles!(['doc.txt']) as Promise<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    }

    const adcOtherDb = getDatabase(adcOtherApp);
    const adcRef = adcOtherDb.ref!('items/1') as AnyRecord;
    let callbackCode: unknown;
    const odCode = await rejectedCode(
      (adcRef.onDisconnect!() as AnyRecord).set!(1, (err: { code?: unknown } | null) => {
        callbackCode = err?.code;
      }) as Promise<unknown>,
    );
    expect(odCode).toBe('PYRIC_LIVE_REFUSED');
    expect(callbackCode).toBe('PYRIC_LIVE_REFUSED');

    expect(httpRequests).toEqual([]);
    expect(grpcConnections).toBe(0);
    expect(records.slice(beforeRecords)).toEqual([]);
  });

  it('allows and observes host-project calls across TenantManager, ProjectConfigManager, and Storage streams', async () => {
    const beforeRecords = records.length;
    const hostAuth = getAuth(hostApp);
    const hostTm = hostAuth.tenantManager!() as AnyRecord;
    const hostPcm = hostAuth.projectConfigManager!() as AnyRecord;

    const tenants = (await hostTm.listTenants!()) as { tenants: unknown[] };
    expect(tenants.tenants).toEqual([]);
    const config = await hostPcm.getProjectConfig!();
    expect(config).toBeDefined();

    const hostBucket = getStorage(hostApp).bucket!(HOST_BUCKET) as AnyRecord;
    const hostSt = hostBucket.storage as AnyRecord;
    const [buckets] = (await hostSt.getBuckets!()) as [unknown[]];
    expect(buckets).toHaveLength(1);
    const [aclEntries] = (await (hostBucket.acl as AnyRecord).get!()) as [unknown[]];
    expect(aclEntries).toHaveLength(1);

    const bucketsStream = await streamOutcome(hostSt.getBucketsStream!() as Readable);
    expect(bucketsStream.status).toBe('ok');
    const filesStream = await streamOutcome(hostBucket.getFilesStream!() as Readable);
    expect(filesStream.status).toBe('ok');

    await new Promise((resolve) => setTimeout(resolve, 15));
    const observedNames = records.slice(beforeRecords).map((r) => r.name);
    expect(observedNames).toEqual([
      'TenantManager.listTenants',
      'ProjectConfigManager.getProjectConfig',
      'Storage.getBuckets',
      'Storage.getBucketsStream',
      'Bucket.getFilesStream',
    ]);
  });
});
