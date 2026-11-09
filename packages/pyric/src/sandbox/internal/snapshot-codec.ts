/**
 * Canonical multi-service `SandboxSnapshot` capture and fork.
 *
 * Browser-clean (`AGENTS.md` Boundary #5): zero `node:*` imports and zero
 * `Buffer` calls so identical code runs in Node/Bun and browser/SharedWorker.
 */
import {
  getAuth,
  sandbox as authSandbox,
  type ProviderUserInfo,
} from '../../auth/index.js';
import type { RtdbBackend } from '../../database/sandbox/backend.js';
import {
  getOrCreateBackend,
  heldDatabaseInstances,
} from '../../database/sandbox/backend-for.js';
import { pathSegments, type JsonValue } from '../../database/sandbox/data-tree.js';
import {
  withPriorities,
  type InlinePriority,
} from '../../rules/internal/rtdb.js';
import type { FirebaseStorage } from '../../storage/index.js';
import {
  DEFAULT_BUCKET,
  getAdminStorageSandbox,
  getStorageCrossServiceIam,
  getStorageService,
  storageBucketsWithRules,
  targetOf,
} from '../../storage/internal.js';
import { getClock } from '../clock.js';
import { initializeSandbox } from '../index.js';
import type { LocalSandbox, Sandbox } from '../types/service.js';
import {
  assertInlineStorageFits,
  type InlineStorageDocument,
} from './inline-storage-limit.js';
import { databaseInstanceNamed } from './instances.js';
import { getInternalEnv } from './sandbox-impl.js';
import { restoreSandboxSnapshot } from './snapshot-restore.js';
import {
  encodeBytesToBase64,
  encodeSnapshotMap,
  type EncodedMap,
} from './snapshot-value-codec.js';

export { restoreSandboxSnapshot };
export {
  summarizeSandboxSnapshot,
  type AuthInspectionSummary,
  type AuthUserSummaryEntry,
  type DatabaseInspectionSummary,
  type FirestoreInspectionSummary,
  type MultiServiceInspectionSummary,
  type StorageInspectionSummary,
  type StorageObjectSummaryEntry,
  type SummarizeSnapshotOptions,
} from './snapshot-summary.js';

export const DEFAULT_SNAPSHOT_RESOURCE = '(default)';

export interface SnapshotUserRecord {
  readonly uid: string;
  readonly email?: string;
  readonly password?: string;
  readonly displayName?: string;
  readonly photoUrl?: string;
  readonly phoneNumber?: string;
  readonly emailVerified?: boolean;
  readonly disabled?: boolean;
  readonly customClaims?: Readonly<Record<string, unknown>>;
  readonly tenantId?: string;
  readonly providerId?: string;
  readonly providerUserInfo?: readonly ProviderUserInfo[];
  readonly createdAt?: string;
  readonly lastLoginAt?: string | null;
}

export interface SnapshotStorageObject {
  readonly path: string;
  readonly contentBase64: string;
  readonly size: number;
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly contentLanguage?: string;
  readonly timeCreated?: string;
  readonly updated?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface SnapshotStorageConfig {
  readonly crossServiceIam?: 'granted' | 'denied';
  readonly undeployedBucketPolicy?: 'allow' | 'deny';
}

export interface SandboxSnapshot {
  readonly version: 1;
  readonly rules: {
    readonly firestore?: Readonly<Record<string, string>>;
    readonly rtdb?: Readonly<Record<string, string>>;
    readonly storage?: Readonly<Record<string, string>>;
  };
  readonly auth: {
    readonly users: readonly SnapshotUserRecord[];
    readonly providers?: Readonly<Record<string, boolean>>;
  };
  /** Encoded with lossless ValueCodec tags for Timestamp, Bytes, GeoPoint, and DocumentReference. */
  readonly firestore: Readonly<Record<string, Readonly<Record<string, EncodedMap>>>>;
  /** Preserves `{ '.value', '.priority' }` nodes across export and restore. */
  readonly rtdb: Readonly<Record<string, unknown>>;
  /** Keyed by bucket (`'(default)'` or bucket name) to sorted object records. */
  readonly storage: Readonly<Record<string, readonly SnapshotStorageObject[]>>;
  /** Optional Storage service posture (cross-service IAM and undeployed bucket lock policy). */
  readonly storageConfig?: SnapshotStorageConfig;
}

export interface CaptureSnapshotOptions {
  readonly excludePasswords?: boolean;
  readonly inlineStorageDocument?: InlineStorageDocument;
}

export interface RestoreSnapshotOptions {
  readonly merge?: boolean;
}

const STORAGE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

export interface StorageServiceCachesView {
  readonly openServices: WeakMap<Sandbox, { readonly rulesSource: string | null }>;
  readonly hostBackends: WeakMap<Sandbox, unknown>;
  readonly scopedServices: WeakMap<Sandbox, Map<string, Promise<unknown>>>;
  readonly bucketRules?: WeakMap<Sandbox, Map<string, { readonly source: string }>>;
  readonly undeployedPolicies?: WeakMap<Sandbox, 'allow' | 'deny'>;
}

export function readStorageCaches(): StorageServiceCachesView | undefined {
  const holder = globalThis as { [STORAGE_CACHES_KEY]?: StorageServiceCachesView };
  return holder[STORAGE_CACHES_KEY];
}

export function hasOpenStorage(sandbox: Sandbox): boolean {
  const caches = readStorageCaches();
  if (caches === undefined) return false;
  return caches.openServices.has(sandbox) || caches.hostBackends.has(sandbox);
}

function exportBackendTreeWithPriorities(backend: RtdbBackend): unknown {
  const persisted = backend.exportPersistenceState();
  if (persisted === null || typeof persisted !== 'object' || Array.isArray(persisted)) {
    return persisted;
  }
  const envelope = persisted as Record<string, unknown>;
  if (envelope['.pyricRtdbPersistence'] !== 1) {
    return persisted;
  }
  const rawData = (envelope.data ?? null) as JsonValue;
  const rawPriorities = envelope.priorities;
  const inlineEntries: InlinePriority[] = [];
  if (rawPriorities !== null && typeof rawPriorities === 'object' && !Array.isArray(rawPriorities)) {
    for (const [path, priority] of Object.entries(rawPriorities as Record<string, unknown>)) {
      if (typeof priority === 'string' || typeof priority === 'number') {
        inlineEntries.push({ segments: pathSegments(path), priority });
      }
    }
  }
  return withPriorities(rawData, inlineEntries);
}

function setOwnField<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function extractCustomMetadata(
  raw: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, string> = {};
  let hasEntry = false;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    setOwnField(out, key, value);
    hasEntry = true;
  }
  if (!hasEntry) return undefined;
  return out;
}

function compareByPath(left: { fullPath: string }, right: { fullPath: string }): number {
  if (left.fullPath < right.fullPath) return -1;
  if (left.fullPath > right.fullPath) return 1;
  return 0;
}

async function captureStorageBuckets(
  sandbox: LocalSandbox,
  inlineDocument: InlineStorageDocument | undefined,
): Promise<{
  storage: Record<string, readonly SnapshotStorageObject[]>;
  storageRules: Record<string, string>;
  storageConfig?: SnapshotStorageConfig;
}> {
  const caches = readStorageCaches();
  const storageRules: Record<string, string> = {};

  const crossServiceIam = getStorageCrossServiceIam(sandbox);
  let undeployedBucketPolicy: 'allow' | 'deny' | undefined;
  if (caches?.bucketRules?.has(sandbox) === true) {
    undeployedBucketPolicy = caches.undeployedPolicies?.get(sandbox) ?? 'deny';
  }
  let storageConfig: SnapshotStorageConfig | undefined;
  if (crossServiceIam === 'denied' || undeployedBucketPolicy !== undefined) {
    const cfg: {
      crossServiceIam?: 'granted' | 'denied';
      undeployedBucketPolicy?: 'allow' | 'deny';
    } = {};
    if (crossServiceIam === 'denied') cfg.crossServiceIam = 'denied';
    if (undeployedBucketPolicy !== undefined) {
      cfg.undeployedBucketPolicy = undeployedBucketPolicy;
    }
    storageConfig = cfg;
  }

  const openEntry = caches?.openServices.get(sandbox);
  if (openEntry?.rulesSource !== null && openEntry?.rulesSource !== undefined) {
    setOwnField(storageRules, DEFAULT_SNAPSHOT_RESOURCE, openEntry.rulesSource);
  }
  for (const bucketName of storageBucketsWithRules(sandbox)) {
    const deployedSource = caches?.bucketRules?.get(sandbox)?.get(bucketName)?.source;
    if (deployedSource === undefined) continue;
    let ruleKey = bucketName;
    if (bucketName === DEFAULT_BUCKET) {
      ruleKey = DEFAULT_SNAPSHOT_RESOURCE;
    }
    setOwnField(storageRules, ruleKey, deployedSource);
  }

  if (!hasOpenStorage(sandbox)) {
    if (inlineDocument !== undefined) {
      assertInlineStorageFits(0, inlineDocument);
    }
    return storageConfig !== undefined
      ? { storage: {}, storageRules, storageConfig }
      : { storage: {}, storageRules };
  }

  const rawBuckets = new Set<string>([DEFAULT_BUCKET]);
  for (const scopedKey of caches?.scopedServices.get(sandbox)?.keys() ?? []) {
    rawBuckets.add(scopedKey);
  }

  const bucketListings: Array<{
    bucketKey: string;
    bucketName: string;
    service: Awaited<ReturnType<typeof getStorageService>>;
    paths: string[];
  }> = [];
  let listedTotalBytes = 0;

  for (const rawBucket of rawBuckets) {
    let handle: FirebaseStorage;
    let bucketKey = rawBucket;
    if (rawBucket === DEFAULT_BUCKET) {
      handle = getAdminStorageSandbox(sandbox);
      bucketKey = DEFAULT_SNAPSHOT_RESOURCE;
    } else {
      handle = getAdminStorageSandbox(sandbox, { bucket: rawBucket });
    }
    const service = await getStorageService(handle);
    const { bucket } = targetOf(handle);
    const listed = [...(await service.backend.listByPrefix(''))];
    listed.sort(compareByPath);
    for (const item of listed) {
      listedTotalBytes += item.size;
    }
    bucketListings.push({
      bucketKey,
      bucketName: bucket,
      service,
      paths: listed.map((entry) => entry.fullPath),
    });
  }

  if (inlineDocument !== undefined) {
    assertInlineStorageFits(listedTotalBytes, inlineDocument);
  }

  const storage: Record<string, readonly SnapshotStorageObject[]> = {};
  let readTotalBytes = 0;

  for (const entry of bucketListings) {
    const objects: SnapshotStorageObject[] = [];
    for (const path of entry.paths) {
      const stored = await entry.service.backend.getObject(path, entry.bucketName);
      if (stored === undefined) continue;
      const bytes = new Uint8Array(await stored.blob.arrayBuffer());
      readTotalBytes += bytes.byteLength;
      if (inlineDocument !== undefined) {
        assertInlineStorageFits(readTotalBytes, inlineDocument);
      }
      const record: {
        path: string;
        contentBase64: string;
        size: number;
        contentType?: string;
        cacheControl?: string;
        contentDisposition?: string;
        contentEncoding?: string;
        contentLanguage?: string;
        timeCreated?: string;
        updated?: string;
        customMetadata?: Record<string, string>;
      } = {
        path,
        contentBase64: encodeBytesToBase64(bytes),
        size: bytes.byteLength,
      };
      if (stored.metadata.contentType !== undefined) {
        record.contentType = stored.metadata.contentType;
      }
      if (stored.metadata.cacheControl !== undefined) {
        record.cacheControl = stored.metadata.cacheControl;
      }
      if (stored.metadata.contentDisposition !== undefined) {
        record.contentDisposition = stored.metadata.contentDisposition;
      }
      if (stored.metadata.contentEncoding !== undefined) {
        record.contentEncoding = stored.metadata.contentEncoding;
      }
      if (stored.metadata.contentLanguage !== undefined) {
        record.contentLanguage = stored.metadata.contentLanguage;
      }
      if (stored.metadata.timeCreated !== undefined) {
        record.timeCreated = stored.metadata.timeCreated;
      }
      if (stored.metadata.updated !== undefined) {
        record.updated = stored.metadata.updated;
      }
      const custom = extractCustomMetadata(stored.metadata.customMetadata);
      if (custom !== undefined) {
        record.customMetadata = custom;
      }
      objects.push(record);
    }
    if (entry.bucketKey === DEFAULT_SNAPSHOT_RESOURCE || objects.length > 0) {
      setOwnField(storage, entry.bucketKey, objects);
    }
  }

  return storageConfig !== undefined
    ? { storage, storageRules, storageConfig }
    : { storage, storageRules };
}

function captureAuthUsers(
  sandbox: LocalSandbox,
  excludePasswords: boolean,
): SnapshotUserRecord[] {
  const exported = authSandbox.exportUsers(getAuth(sandbox));
  return exported.map((user): SnapshotUserRecord => {
    const record: {
      uid: string;
      email?: string;
      password?: string;
      displayName?: string;
      photoUrl?: string;
      phoneNumber?: string;
      emailVerified?: boolean;
      disabled?: boolean;
      customClaims?: Record<string, unknown>;
      tenantId?: string;
      providerId?: string;
      providerUserInfo?: ProviderUserInfo[];
      createdAt?: string;
      lastLoginAt?: string | null;
    } = { uid: user.uid };
    if (user.email !== undefined) record.email = user.email;
    if (!excludePasswords && user.password !== undefined) record.password = user.password;
    if (user.displayName !== undefined) record.displayName = user.displayName;
    if (user.photoUrl !== undefined) record.photoUrl = user.photoUrl;
    if (user.phoneNumber !== undefined) record.phoneNumber = user.phoneNumber;
    record.emailVerified = user.emailVerified === true;
    if (user.disabled !== undefined) record.disabled = user.disabled;
    if (user.customClaims !== undefined) {
      record.customClaims = structuredClone(user.customClaims);
    }
    if (user.tenantId !== undefined) record.tenantId = user.tenantId;
    if (user.providerId !== undefined) record.providerId = user.providerId;
    if (user.providerUserInfo !== undefined) {
      record.providerUserInfo = user.providerUserInfo.map((info) => ({ ...info }));
    }
    if (user.createdAt !== undefined) record.createdAt = user.createdAt;
    if (user.lastLoginAt !== undefined) record.lastLoginAt = user.lastLoginAt;
    return record;
  });
}

/** Capture a lossless, JSON-serializable multi-service `SandboxSnapshot`. */
export async function captureSandboxSnapshot(
  sandbox: LocalSandbox,
  options?: CaptureSnapshotOptions,
): Promise<SandboxSnapshot> {
  const env = getInternalEnv(sandbox);
  const firestoreRulesSource = env.getRules();
  const firestoreDocs: Record<string, EncodedMap> = {};
  const rawDocs = env.snapshot();
  for (const path of Object.keys(rawDocs).sort()) {
    setOwnField(firestoreDocs, path, encodeSnapshotMap(rawDocs[path]!));
  }

  const rtdb: Record<string, unknown> = {};
  const rtdbRules: Record<string, string> = {};
  const defaultBackend = getOrCreateBackend(sandbox);
  const defaultTree = exportBackendTreeWithPriorities(defaultBackend);
  if (defaultTree !== null && defaultTree !== undefined) {
    setOwnField(rtdb, DEFAULT_SNAPSHOT_RESOURCE, defaultTree);
  }
  const defaultRtdbRules = defaultBackend.getActiveRules();
  if (defaultRtdbRules !== null) {
    setOwnField(rtdbRules, DEFAULT_SNAPSHOT_RESOURCE, JSON.stringify(defaultRtdbRules));
  }
  for (const instanceName of heldDatabaseInstances(sandbox)) {
    const namedBackend = getOrCreateBackend(sandbox, databaseInstanceNamed(instanceName));
    const namedTree = exportBackendTreeWithPriorities(namedBackend);
    if (namedTree !== null && namedTree !== undefined) {
      setOwnField(rtdb, instanceName, namedTree);
    }
    const namedActiveRules = namedBackend.getActiveRules();
    if (namedActiveRules !== null) {
      setOwnField(rtdbRules, instanceName, JSON.stringify(namedActiveRules));
    }
  }

  const { storage, storageRules, storageConfig } = await captureStorageBuckets(
    sandbox,
    options?.inlineStorageDocument,
  );
  const users = captureAuthUsers(sandbox, options?.excludePasswords === true);
  const providers = authSandbox.exportProviderConfig(getAuth(sandbox));

  const rules: {
    firestore?: Record<string, string>;
    rtdb?: Record<string, string>;
    storage?: Record<string, string>;
  } = {};
  if (firestoreRulesSource.length > 0) {
    rules.firestore = { [DEFAULT_SNAPSHOT_RESOURCE]: firestoreRulesSource };
  }
  if (Object.keys(rtdbRules).length > 0) {
    rules.rtdb = rtdbRules;
  }
  if (Object.keys(storageRules).length > 0) {
    rules.storage = storageRules;
  }

  const snapshot: SandboxSnapshot = {
    version: 1,
    rules,
    auth: { users, providers },
    firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: firestoreDocs },
    rtdb,
    storage,
    ...(storageConfig !== undefined ? { storageConfig } : {}),
  };
  return snapshot;
}

let nextForkStorageSequence = 1;

function isolateForkStorage(sandbox: LocalSandbox): void {
  const suffix = `${nextForkStorageSequence++}-${Math.random().toString(36).slice(2, 10)}`;
  getAdminStorageSandbox(sandbox, { dbName: `pyric-fork-storage:${suffix}` });
}

/**
 * Fork `sandbox` into an isolated `LocalSandbox` seeded with a lossless
 * `SandboxSnapshot` across Firestore, RTDB, Storage, and Auth.
 */
export async function forkSandbox(
  sandbox: LocalSandbox,
): Promise<{ sandbox: LocalSandbox; snapshot: SandboxSnapshot }> {
  const snapshot = await captureSandboxSnapshot(sandbox);
  const forked = initializeSandbox();
  getClock(forked).restore(getClock(sandbox).capture());
  isolateForkStorage(forked);
  await restoreSandboxSnapshot(forked, snapshot);
  return { sandbox: forked, snapshot };
}
