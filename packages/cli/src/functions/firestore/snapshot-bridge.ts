/**
 * Bridges `firebase-functions` (`lib/common/providers/firestore.{js,mjs}`)
 * `firestoreInstance.snapshot_(...)` onto `pyric-admin/firestore` inside the
 * isolated Functions child process, without modifying `packages/pyric-admin`.
 *
 * Unchanged `firebase-functions/v2/firestore` handlers call `getFirestore(getApp(), db).snapshot_(...)`
 * to materialize `QueryDocumentSnapshot` / `DocumentSnapshot` instances whose `.ref`
 * points back at the swapped `firebase-admin/firestore` handle so `event.data.ref.update(...)`
 * writes directly into the live Pyric sandbox.
 */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FirestoreTimestampProto } from './proto-encoder.js';

const RESOURCE_NAME_RE = /^projects\/([^/]*)\/databases\/([^/]*)\/documents\/([\s\S]+)$/;

interface AdminTimestampInstance {
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
  isEqual(other: unknown): boolean;
}

interface AdminTimestampConstructor {
  new (seconds: number, nanoseconds: number): AdminTimestampInstance;
  now(): AdminTimestampInstance;
}

interface AdminGeoPointConstructor {
  new (latitude: number, longitude: number): unknown;
}

interface AdminFieldPathInstance {
  toArray?(): string[];
  readonly _segments?: readonly string[];
  readonly _internalPath?: {
    readonly segments?: readonly string[];
    readonly offset?: number;
    readonly len?: number;
  };
}

interface AdminDocRef {
  readonly id: string;
  readonly path: string;
  isEqual?(other: unknown): boolean;
}

interface SwappedAdminFirestoreHandle {
  readonly databaseId?: string;
  doc(path: string): AdminDocRef;
  snapshot_?: (
    documentOrName: unknown,
    readTime: unknown,
    encoding?: string,
  ) => unknown;
}

interface SwappedAdminFirestoreModule {
  Timestamp: AdminTimestampConstructor;
  GeoPoint: AdminGeoPointConstructor;
  VectorValue?: { create?: (values: number[]) => unknown } | (new (values: number[]) => unknown);
  FieldValue?: { vector?: (values: number[]) => unknown };
  getFirestore(app?: unknown, databaseId?: string): SwappedAdminFirestoreHandle;
}

interface SwappedAdminAppModule {
  getApps(): Array<{ name?: string; sandbox?: { close?: () => void } }>;
  initializeApp(options?: Record<string, unknown>, name?: string): { name?: string };
}

function longOrNumberToNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') return Number(raw);
  if (typeof raw === 'object' && raw !== null) {
    const withToNumber = raw as { toNumber?: unknown; low?: unknown; high?: unknown };
    if (typeof withToNumber.toNumber === 'function') {
      return (withToNumber.toNumber as () => number)();
    }
    if (typeof withToNumber.low === 'number' && typeof withToNumber.high === 'number') {
      const combined =
        (BigInt(withToNumber.high >>> 0) << 32n) | BigInt(withToNumber.low >>> 0);
      return Number(BigInt.asIntN(64, combined));
    }
  }
  return 0;
}

function parseTimestampInput(raw: unknown): FirestoreTimestampProto | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const date = new Date(raw);
    const seconds = Math.floor(date.getTime() / 1_000);
    let nanos = 0;
    if (raw.length > 20) {
      const fraction = raw.slice(20, -1);
      const scale = 10 ** Math.max(0, 9 - fraction.length);
      nanos = Number.parseInt(fraction, 10) * scale;
    }
    return { seconds, nanos };
  }
  if (typeof raw === 'object') {
    const record = raw as { seconds?: unknown; nanos?: unknown };
    const seconds = longOrNumberToNumber(record.seconds ?? 0);
    const nanos = longOrNumberToNumber(record.nanos ?? 0);
    return { seconds, nanos };
  }
  return undefined;
}

function parseQualifiedDocumentResource(resourceName: string): {
  projectId: string;
  databaseId: string;
  documentPath: string;
} {
  const match = RESOURCE_NAME_RE.exec(resourceName);
  if (match === null) {
    throw new Error(`Resource name '${resourceName}' is not valid.`);
  }
  const projectId = match[1] ?? '';
  const databaseId = match[2] ?? '(default)';
  const documentPath = (match[3] ?? '').split('/').filter(Boolean).join('/');
  return { projectId, databaseId, documentPath };
}

function activeProtoValueType(proto: Record<string, unknown>): string {
  if (typeof proto.valueType === 'string' && proto.valueType.length > 0) {
    return proto.valueType;
  }
  const candidates = [
    'nullValue',
    'booleanValue',
    'integerValue',
    'doubleValue',
    'timestampValue',
    'stringValue',
    'bytesValue',
    'referenceValue',
    'geoPointValue',
    'arrayValue',
    'mapValue',
  ];
  for (const key of candidates) {
    if (Object.hasOwn(proto, key) && proto[key] !== undefined) {
      return key;
    }
  }
  throw new Error(`Unable to infer Firestore proto valueType from ${JSON.stringify(proto)}`);
}

function isVectorProtoMap(fields: Record<string, unknown>): boolean {
  const typeEntry = fields.__type__;
  if (typeof typeEntry !== 'object' || typeEntry === null) return false;
  const typeRecord = typeEntry as Record<string, unknown>;
  const kind = activeProtoValueType(typeRecord);
  return kind === 'stringValue' && typeRecord.stringValue === '__vector__';
}

function decodeProtoValue(
  rawProto: unknown,
  encoding: 'protobufJS' | 'json',
  adminFirestore: SwappedAdminFirestoreModule,
  dbHandle: SwappedAdminFirestoreHandle,
): unknown {
  if (typeof rawProto !== 'object' || rawProto === null) return null;
  const proto = rawProto as Record<string, unknown>;
  const valueType = activeProtoValueType(proto);

  switch (valueType) {
    case 'nullValue':
      return null;
    case 'booleanValue':
      return Boolean(proto.booleanValue);
    case 'integerValue':
      return longOrNumberToNumber(proto.integerValue);
    case 'doubleValue':
      return Number(proto.doubleValue);
    case 'stringValue':
      return String(proto.stringValue ?? '');
    case 'bytesValue': {
      const rawBytes = proto.bytesValue;
      if (typeof rawBytes === 'string') {
        return Buffer.from(rawBytes, 'base64');
      }
      if (rawBytes instanceof Uint8Array) {
        return Buffer.from(Uint8Array.prototype.slice.call(rawBytes));
      }
      return Buffer.alloc(0);
    }
    case 'timestampValue': {
      const parsed = parseTimestampInput(proto.timestampValue) ?? { seconds: 0, nanos: 0 };
      return new adminFirestore.Timestamp(parsed.seconds, parsed.nanos);
    }
    case 'geoPointValue': {
      const geo = (proto.geoPointValue ?? {}) as { latitude?: unknown; longitude?: unknown };
      const lat = typeof geo.latitude === 'number' ? geo.latitude : 0;
      const lng = typeof geo.longitude === 'number' ? geo.longitude : 0;
      return new adminFirestore.GeoPoint(lat, lng);
    }
    case 'referenceValue': {
      const refString = String(proto.referenceValue ?? '');
      const parsedRef = parseQualifiedDocumentResource(refString);
      return dbHandle.doc(parsedRef.documentPath);
    }
    case 'arrayValue': {
      const arrContainer = (proto.arrayValue ?? {}) as { values?: unknown };
      if (!Array.isArray(arrContainer.values)) return [];
      return arrContainer.values.map((item) =>
        decodeProtoValue(item, encoding, adminFirestore, dbHandle),
      );
    }
    case 'mapValue': {
      const mapContainer = (proto.mapValue ?? {}) as { fields?: unknown };
      let rawFields: Record<string, unknown> = {};
      if (typeof mapContainer.fields === 'object' && mapContainer.fields !== null) {
        rawFields = mapContainer.fields as Record<string, unknown>;
      }
      if (isVectorProtoMap(rawFields)) {
        const vecEntry = rawFields.value;
        const decodedNums = decodeProtoValue(vecEntry, encoding, adminFirestore, dbHandle);
        let numericList: number[] = [];
        if (Array.isArray(decodedNums)) {
          numericList = decodedNums.map((item) => Number(item));
        }
        if (typeof adminFirestore.FieldValue?.vector === 'function') {
          return adminFirestore.FieldValue.vector(numericList);
        }
        return numericList;
      }
      const out: Record<string, unknown> = {};
      for (const [key, childProto] of Object.entries(rawFields)) {
        out[key] = decodeProtoValue(childProto, encoding, adminFirestore, dbHandle);
      }
      return out;
    }
    default:
      return null;
  }
}

function splitFieldPathArgument(fieldPath: string | AdminFieldPathInstance): string[] {
  if (typeof fieldPath === 'string') {
    if (fieldPath.length === 0) {
      throw new Error('Value for argument "fieldPath" must be a non-empty string or FieldPath.');
    }
    return fieldPath.split('.');
  }
  if (typeof fieldPath === 'object' && fieldPath !== null) {
    if (typeof fieldPath.toArray === 'function') {
      return fieldPath.toArray();
    }
    if (Array.isArray(fieldPath._segments)) {
      return [...fieldPath._segments];
    }
    const internalPath = fieldPath._internalPath;
    if (
      typeof internalPath === 'object' &&
      internalPath !== null &&
      Array.isArray(internalPath.segments)
    ) {
      const start = typeof internalPath.offset === 'number' ? internalPath.offset : 0;
      let count = internalPath.segments.length - start;
      if (typeof internalPath.len === 'number') {
        count = internalPath.len;
      }
      return internalPath.segments.slice(start, start + count);
    }
  }
  throw new Error('Value for argument "fieldPath" is not a valid field path.');
}

function readNestedField(
  data: Record<string, unknown> | undefined,
  segments: readonly string[],
): unknown {
  if (data === undefined) return undefined;
  let cursor: unknown = data;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    const record = cursor as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      return undefined;
    }
    cursor = record[segment];
  }
  return cursor;
}

const SNAPSHOT_BRAND = Symbol.for('pyric.functions.firestore.snapshot');

interface BrandedSnapshot {
  readonly [SNAPSHOT_BRAND]: {
    readonly resourceName: string;
    readonly exists: boolean;
    readonly rawFieldsJson: string;
  };
  readonly exists: boolean;
  readonly id: string;
  readonly ref: AdminDocRef;
  readonly createTime: AdminTimestampInstance | undefined;
  readonly updateTime: AdminTimestampInstance | undefined;
  readonly readTime: AdminTimestampInstance;
  data(): Record<string, unknown> | undefined;
  get(fieldPath: string | AdminFieldPathInstance): unknown;
  isEqual(other: unknown): boolean;
}

const DEFAULT_FIRESTORE_DATABASE_ID = '(default)';

function resolveSnapshotDbHandle(
  dbHandle: SwappedAdminFirestoreHandle,
  adminFirestore: SwappedAdminFirestoreModule,
  ownerApp: unknown,
  resourceDatabaseId: string,
): SwappedAdminFirestoreHandle {
  if (
    ownerApp === undefined ||
    resourceDatabaseId.length === 0 ||
    dbHandle.databaseId === resourceDatabaseId
  ) {
    return dbHandle;
  }
  const targetDb =
    resourceDatabaseId === DEFAULT_FIRESTORE_DATABASE_ID
      ? adminFirestore.getFirestore(ownerApp)
      : adminFirestore.getFirestore(ownerApp, resourceDatabaseId);
  attachSnapshotFactoryToFirestore(targetDb, adminFirestore, ownerApp);
  return targetDb;
}

/** Attach a `snapshot_` factory onto a `pyric-admin/firestore` handle if absent. */
export function attachSnapshotFactoryToFirestore(
  dbHandle: SwappedAdminFirestoreHandle,
  adminFirestore: SwappedAdminFirestoreModule,
  ownerApp?: unknown,
): void {
  if (typeof dbHandle.snapshot_ === 'function') return;

  dbHandle.snapshot_ = (
    documentOrName: unknown,
    rawReadTime: unknown,
    rawEncoding?: string,
  ): BrandedSnapshot => {
    const encoding: 'protobufJS' | 'json' =
      rawEncoding === 'json' ? 'json' : 'protobufJS';

    if (typeof documentOrName === 'string') {
      const parsedResource = parseQualifiedDocumentResource(documentOrName);
      const refDb = resolveSnapshotDbHandle(
        dbHandle,
        adminFirestore,
        ownerApp,
        parsedResource.databaseId,
      );
      const ref = refDb.doc(parsedResource.documentPath);
      const parsedRead = parseTimestampInput(rawReadTime);
      let readTime = adminFirestore.Timestamp.now();
      if (parsedRead !== undefined) {
        readTime = new adminFirestore.Timestamp(parsedRead.seconds, parsedRead.nanos);
      }
      const snapshot: BrandedSnapshot = {
        [SNAPSHOT_BRAND]: {
          resourceName: documentOrName,
          exists: false,
          rawFieldsJson: '',
        },
        exists: false,
        id: ref.id,
        ref,
        createTime: undefined,
        updateTime: undefined,
        readTime,
        data: () => undefined,
        get: (fieldPath) => {
          splitFieldPathArgument(fieldPath);
          return undefined;
        },
        isEqual(other: unknown): boolean {
          if (other === snapshot) return true;
          if (typeof other !== 'object' || other === null || !(SNAPSHOT_BRAND in other)) {
            return false;
          }
          const otherMeta = (other as BrandedSnapshot)[SNAPSHOT_BRAND];
          return !otherMeta.exists && otherMeta.resourceName === documentOrName;
        },
      };
      return snapshot;
    }

    if (typeof documentOrName !== 'object' || documentOrName === null) {
      throw new Error('Invalid Firestore document payload passed to snapshot_.');
    }

    const docProto = documentOrName as {
      name?: unknown;
      fields?: unknown;
      createTime?: unknown;
      updateTime?: unknown;
    };
    const resourceName = String(docProto.name ?? '');
    const parsedResource = parseQualifiedDocumentResource(resourceName);
    const refDb = resolveSnapshotDbHandle(
      dbHandle,
      adminFirestore,
      ownerApp,
      parsedResource.databaseId,
    );
    const ref = refDb.doc(parsedResource.documentPath);
    let rawFields: Record<string, unknown> = {};
    if (typeof docProto.fields === 'object' && docProto.fields !== null) {
      rawFields = docProto.fields as Record<string, unknown>;
    }

    const createProto = parseTimestampInput(docProto.createTime) ?? { seconds: 0, nanos: 0 };
    const updateProto = parseTimestampInput(docProto.updateTime) ?? createProto;
    const readProto = parseTimestampInput(rawReadTime) ?? updateProto;

    const createTime = new adminFirestore.Timestamp(createProto.seconds, createProto.nanos);
    const updateTime = new adminFirestore.Timestamp(updateProto.seconds, updateProto.nanos);
    const readTime = new adminFirestore.Timestamp(readProto.seconds, readProto.nanos);

    const decodeDocumentFields = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, fieldProto] of Object.entries(rawFields)) {
        out[key] = decodeProtoValue(fieldProto, encoding, adminFirestore, refDb);
      }
      return out;
    };

    const fingerprint = JSON.stringify(
      Object.entries(rawFields).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      }),
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    );

    const snapshot: BrandedSnapshot = {
      [SNAPSHOT_BRAND]: {
        resourceName,
        exists: true,
        rawFieldsJson: fingerprint,
      },
      exists: true,
      id: ref.id,
      ref,
      createTime,
      updateTime,
      readTime,
      data: () => decodeDocumentFields(),
      get: (fieldPath) => {
        const segments = splitFieldPathArgument(fieldPath);
        return readNestedField(decodeDocumentFields(), segments);
      },
      isEqual(other: unknown): boolean {
        if (other === snapshot) return true;
        if (typeof other !== 'object' || other === null || !(SNAPSHOT_BRAND in other)) {
          return false;
        }
        const otherMeta = (other as BrandedSnapshot)[SNAPSHOT_BRAND];
        return (
          otherMeta.exists &&
          otherMeta.resourceName === resourceName &&
          otherMeta.rawFieldsJson === fingerprint
        );
      },
    };
    return snapshot;
  };
}

const ADMIN_APP_TARGET = Symbol.for('pyric.admin.app.target');

function normalizeBridgeDatabases(databases?: Iterable<string>): string[] {
  const seen = new Set<string>([DEFAULT_FIRESTORE_DATABASE_ID]);
  if (databases !== undefined) {
    for (const raw of databases) {
      if (typeof raw === 'string' && raw.length > 0) {
        seen.add(raw);
      }
    }
  }
  return [...seen];
}

function attachSnapshotFactoriesForDatabases(
  adminFirestore: SwappedAdminFirestoreModule,
  apps: readonly unknown[],
  databases: readonly string[],
): void {
  for (const app of apps) {
    attachSnapshotFactoryToFirestore(adminFirestore.getFirestore(app), adminFirestore, app);
    for (const databaseId of databases) {
      attachSnapshotFactoryToFirestore(
        adminFirestore.getFirestore(app, databaseId),
        adminFirestore,
        app,
      );
    }
  }
}

/**
 * Configure `firebase-functions/v2` (both CJS and ESM module graphs if installed)
 * with an unregistered `SandboxAdminApp` bound to `sandbox` whose Firestore handles
 * (for `(default)` and every discovered named database) implement `snapshot_`.
 * Keeps `getApps().length === 0`, opens 0 extra sockets, and emits 0 extra `stderr` lines.
 */
export async function installChildFirestoreSnapshotBridge(
  entryPath: string,
  projectId: string,
  sandbox: unknown,
  databases?: Iterable<string>,
): Promise<void> {
  const requireFromEntry = createRequire(entryPath);
  const adminApp = requireFromEntry('firebase-admin/app') as SwappedAdminAppModule;
  const adminFirestore = requireFromEntry(
    'firebase-admin/firestore',
  ) as SwappedAdminFirestoreModule;

  const emulatedApp = {
    [ADMIN_APP_TARGET]: 'sandbox' as const,
    sandbox,
    name: '__FIREBASE_FUNCTIONS_SDK__',
    options: { projectId },
  };
  const targetApps: unknown[] = [...adminApp.getApps(), emulatedApp];
  const targetDatabases = normalizeBridgeDatabases(databases);

  attachSnapshotFactoriesForDatabases(adminFirestore, targetApps, targetDatabases);

  try {
    const adminFirestoreSpecifier = 'firebase-admin/firestore';
    const esmAdminFirestore = (await import(
      adminFirestoreSpecifier
    )) as SwappedAdminFirestoreModule;
    attachSnapshotFactoriesForDatabases(esmAdminFirestore, targetApps, targetDatabases);
  } catch {
    // Non-registered unit environments without ESM firebase-admin continue via CJS.
  }

  let cjsFunctionsV2Path: string | undefined;
  try {
    cjsFunctionsV2Path = requireFromEntry.resolve('firebase-functions/v2');
  } catch {
    return;
  }

  const cjsFunctionsV2 = requireFromEntry(cjsFunctionsV2Path) as {
    app?: { setEmulatedAdminApp?: (app: unknown) => void };
  };
  cjsFunctionsV2.app?.setEmulatedAdminApp?.(emulatedApp);

  const esmFunctionsV2Path = join(dirname(cjsFunctionsV2Path), '../esm/v2/index.mjs');
  if (existsSync(esmFunctionsV2Path)) {
    const canonicalEsmPath = realpathSync(esmFunctionsV2Path);
    const esmFunctionsV2 = (await import(pathToFileURL(canonicalEsmPath).href)) as {
      app?: { setEmulatedAdminApp?: (app: unknown) => void };
    };
    esmFunctionsV2.app?.setEmulatedAdminApp?.(emulatedApp);
  }
}
