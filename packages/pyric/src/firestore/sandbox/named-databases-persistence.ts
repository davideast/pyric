/**
 * Incremental bucket persistence, metadata declaration stamping, and bundle
 * encoding/decoding for named Firestore databases (ADR-0021 Decision 5).
 */
import type { Sandbox } from 'pyric/sandbox';
import { SandboxError } from 'pyric/sandbox';
import { encodeStateDocument } from '../../sandbox/internal/state-values.js';
import {
  checksumDocs,
  META_RECORD_ID,
  pathToBucketId,
  type BucketRecord,
} from '../../sandbox/persistence/chunk-format.js';
import { isRtdbRecordId } from '../../sandbox/persistence/rtdb-records.js';
import {
  DOC_VALUE_ENCODING,
  rehydrateEncodedDocValue,
  requireDocumentData,
} from '../internal/value-codec.js';
import {
  assertValidFirestoreDatabaseDeclaration,
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  getOrCreateDatabaseRegistry,
  isValidFirestoreDatabaseId,
  listDeclaredFirestoreDatabases,
  MAX_FIRESTORE_DATABASES,
  peekDatabaseRegistry,
} from './named-databases.js';

export interface NamedDatabaseFlushDiff {
  readonly changed: Map<string, BucketRecord>;
  readonly serializedChanged: Map<string, string>;
  readonly removed: string[];
}

export interface NamedFirestorePersistencePlan {
  readonly declared: string[];
  readonly declaredChanged: boolean;
  readonly databases: Map<string, NamedDatabaseFlushDiff>;
  readonly hasWork: boolean;
  commit(): void;
  retry(): void;
}

/** Reset persistence baselines after `clearPersistence()` so the next flush writes full state. */
export function markAllNamedFirestoreDirty(sandbox: Sandbox): void {
  const registry = peekDatabaseRegistry(sandbox);
  if (registry === undefined) return;
  registry.lastPersistedDeclaredJson = '[]';
  registry.declaredGeneration += 1;
  for (const entry of registry.entries.values()) {
    entry.persistedBuckets.clear();
    entry.dirtyAll = true;
    entry.dirtyBuckets.clear();
    entry.generation += 1;
  }
}

/** Serialize a document map into standard `'00'..'ff'` v3 bucket records (no `meta`). */
export function serializeNamedFirestoreDocsToBuckets(
  firestore: Record<string, Record<string, unknown>>,
): Map<string, BucketRecord> {
  const buckets = new Map<string, BucketRecord>();
  for (const [path, data] of Object.entries(firestore)) {
    const bucketId = pathToBucketId(path);
    let bucket = buckets.get(bucketId);
    if (bucket === undefined) {
      bucket = { docs: {}, encoding: DOC_VALUE_ENCODING };
      buckets.set(bucketId, bucket);
    }
    bucket.docs[path] = encodeStateDocument(data);
  }
  for (const bucket of buckets.values()) {
    bucket.checksum = checksumDocs(bucket.docs);
  }
  return buckets;
}

/** Rehydrate a named database's `'00'..'ff'` bucket records into a plain document map. */
export function parseNamedFirestoreBundleRecords(
  records: Iterable<[string, unknown]>,
  options: { skipInvalidDocuments?: boolean } = {},
): Record<string, Record<string, unknown>> {
  const docs: Record<string, Record<string, unknown>> = {};
  for (const [id, raw] of records) {
    if (id === META_RECORD_ID || isRtdbRecordId(id)) {
      continue;
    }
    if (raw === null || typeof raw !== 'object') {
      continue;
    }
    const bucket = raw as Partial<BucketRecord>;
    const bucketDocs = bucket.docs;
    if (bucketDocs === null || typeof bucketDocs !== 'object' || Array.isArray(bucketDocs)) {
      continue;
    }
    if (typeof bucket.checksum === 'number' && checksumDocs(bucketDocs) !== bucket.checksum) {
      console.warn(
        `[sandbox/persistence] checksum mismatch for named Firestore bucket '${id}'; skipping corrupt bucket`,
      );
      continue;
    }
    for (const [docPath, encoded] of Object.entries(bucketDocs)) {
      try {
        docs[docPath] = requireDocumentData(rehydrateEncodedDocValue(encoded, bucket.encoding));
      } catch (error) {
        if (options.skipInvalidDocuments !== true) throw error;
        console.warn(
          `[sandbox/persistence] skipping unreadable named Firestore document '${docPath}' in bucket '${id}':`,
          error,
        );
      }
    }
  }
  return docs;
}

/** Validate and extract `firestoreDeclared` from a persisted `meta` record. */
export function readFirestoreDeclaredFromMeta(meta: unknown): string[] {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return [];
  }
  const raw = (meta as { firestoreDeclared?: unknown }).firestoreDeclared;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new SandboxError('invalid-argument', 'Persisted meta.firestoreDeclared must be an array.');
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(item)) {
      throw new SandboxError(
        'invalid-argument',
        `Persisted meta.firestoreDeclared contains invalid database id "${String(item)}".`,
      );
    }
    seen.add(item);
  }
  if (1 + seen.size > MAX_FIRESTORE_DATABASES) {
    throw new SandboxError(
      'invalid-argument',
      `Persisted meta.firestoreDeclared exceeds the ${MAX_FIRESTORE_DATABASES}-database limit.`,
    );
  }
  return [...seen].sort();
}

/** Stamp `firestoreDeclared` onto a `meta` record (omitting the property when empty). */
export function stampFirestoreDeclaredOnMeta(
  meta: Record<string, unknown>,
  declared: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...meta };
  if (declared.length > 0) {
    next.firestoreDeclared = [...declared];
  } else {
    delete next.firestoreDeclared;
  }
  return next;
}

/** Build an incremental persistence flush plan across all declared named databases. */
export function prepareNamedFirestorePersistence(sandbox: Sandbox): NamedFirestorePersistencePlan {
  const registry = peekDatabaseRegistry(sandbox);
  if (registry === undefined) {
    return {
      declared: [],
      declaredChanged: false,
      databases: new Map(),
      hasWork: false,
      commit() {},
      retry() {},
    };
  }
  const declared = listDeclaredFirestoreDatabases(sandbox);
  const declaredJson = JSON.stringify(declared);
  const declaredChanged = declaredJson !== registry.lastPersistedDeclaredJson;
  const capturedDeclaredGen = registry.declaredGeneration;
  const databases = new Map<string, NamedDatabaseFlushDiff>();
  const commitHooks: Array<() => void> = [];

  for (const dbId of declared) {
    const entry = registry.entries.get(dbId);
    if (entry === undefined) continue;
    if (!entry.dirtyAll && entry.dirtyBuckets.size === 0) continue;

    const capturedGen = entry.generation;
    const snap = entry.env.snapshot();
    const allBuckets = serializeNamedFirestoreDocsToBuckets(snap);
    const changed = new Map<string, BucketRecord>();
    const serializedChanged = new Map<string, string>();
    const removed: string[] = [];
    const nextPersisted = new Set(entry.persistedBuckets);

    if (entry.dirtyAll) {
      for (const [bucketId, record] of allBuckets) {
        changed.set(bucketId, record);
        serializedChanged.set(bucketId, JSON.stringify(record));
        nextPersisted.add(bucketId);
      }
      for (const priorId of entry.persistedBuckets) {
        if (!allBuckets.has(priorId)) {
          removed.push(priorId);
          nextPersisted.delete(priorId);
        }
      }
    } else {
      for (const bucketId of entry.dirtyBuckets) {
        const record = allBuckets.get(bucketId);
        if (record !== undefined) {
          changed.set(bucketId, record);
          serializedChanged.set(bucketId, JSON.stringify(record));
          nextPersisted.add(bucketId);
        } else if (entry.persistedBuckets.has(bucketId)) {
          removed.push(bucketId);
          nextPersisted.delete(bucketId);
        }
      }
    }

    if (changed.size > 0 || removed.length > 0) {
      databases.set(dbId, { changed, serializedChanged, removed });
    }
    commitHooks.push(() => {
      entry.persistedBuckets = nextPersisted;
      if (entry.generation === capturedGen) {
        entry.dirtyAll = false;
        entry.dirtyBuckets.clear();
      }
    });
  }

  return {
    declared,
    declaredChanged,
    databases,
    hasWork: declaredChanged || databases.size > 0,
    commit() {
      if (registry.declaredGeneration === capturedDeclaredGen) {
        registry.lastPersistedDeclaredJson = declaredJson;
      }
      for (const applyCommit of commitHooks) {
        applyCommit();
      }
    },
    retry() {
      // Dirty flags remain set until commit() runs.
    },
  };
}

const VALID_HEX_BUCKET = /^[0-9a-f]{2}$/;

/** Hydrate declared named databases and their bucket records into `sandbox` at boot. */
export function restoreNamedFirestorePersistence(
  sandbox: Sandbox,
  declared: readonly string[],
  databases: ReadonlyMap<string, Iterable<[string, unknown]>>,
): void {
  const registry = getOrCreateDatabaseRegistry(sandbox);
  const validDeclared: string[] = [];
  for (const rawId of declared) {
    const normalized = assertValidFirestoreDatabaseDeclaration(rawId);
    if (normalized === DEFAULT_FIRESTORE_DATABASE) continue;
    declareFirestoreDatabase(sandbox, normalized);
    validDeclared.push(normalized);
  }
  validDeclared.sort();
  registry.lastPersistedDeclaredJson = JSON.stringify(validDeclared);

  for (const dbId of validDeclared) {
    const entry = registry.entries.get(dbId);
    if (entry === undefined) continue;
    const rawRecords = databases.get(dbId);
    const recordList = rawRecords === undefined ? [] : [...rawRecords];
    const persistedBuckets = new Set<string>();
    for (const [recordId] of recordList) {
      if (VALID_HEX_BUCKET.test(recordId)) {
        persistedBuckets.add(recordId);
      }
    }
    const docs = parseNamedFirestoreBundleRecords(recordList, { skipInvalidDocuments: true });
    for (const [docPath, docData] of Object.entries(docs)) {
      entry.env.adminSetDocument(docPath, docData);
    }
    entry.persistedBuckets = persistedBuckets;
    entry.dirtyAll = false;
    entry.dirtyBuckets.clear();
  }
}
