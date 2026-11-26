/**
 * Branching from a saved state, which is all Studio ever has.
 *
 * The branch engine forks from a {@link FullSandboxState}, which is read off a
 * live sandbox. Studio does not hold one: the sandbox lives in the worker and
 * what crosses the port is the saved state of it that the worker hands back.
 * So every Studio feature that stages a change on a copy, the proposals panel
 * and the rules rerun, goes through here.
 *
 * A branch forked this way stands on a fresh sandbox with the saved state
 * loaded into it, so it reads what that state held in every service the state
 * carried. When a saved state carries Cloud Storage objects, `forkFromSavedState`
 * converts and seeds them strictly as SHA-256 byte references (ADR 0018) so a
 * Studio branch shares parent Storage hashes instead of copying object bytes
 * inline. The candidate ruleset is installed after the load, because loading a
 * saved state replaces the rules with the ones it carries.
 *
 * `documentDivergences` compares Firestore documents alone, while `savedStateOf`
 * lifts Firestore documents plus any SHA-256 Storage reference slice the saved
 * state explicitly describes. A service the saved state does not describe stays
 * empty on both sides rather than reporting itself as a difference.
 */
import {
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  getDatabaseEnv,
  isFirestoreDatabaseDeclared,
  isFirestoreDatabaseLockedByDefault,
  listDeclaredFirestoreDatabases,
  normalizeFirestoreDatabaseId,
} from 'pyric/firestore/internal';
import {
  diffFullStates,
  fork,
  holdsBytesInline,
  type Branch,
  type BranchDivergence,
  type FullSandboxState,
  type LocalSandbox,
  type SandboxSnapshot,
  type StorageObjectState,
} from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';

import type { WorkspaceBranchStorageReference } from '../ports.js';

const DEFAULT_STORAGE_BUCKET = 'pyric-default';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

export interface SavedNamedFirestoreSnapshot extends SandboxSnapshot {
  firestoreDeclared?: string[];
  firestoreDatabases?: Record<string, Record<string, Record<string, unknown>>>;
  firestoreDatabaseRules?: Record<string, string>;
  firestoreLocked?: string[];
  /** Optional Cloud Storage entries carried with the saved state (by SHA-256 reference or inline). */
  storage?: readonly StorageObjectState[];
}

/** A state holding nothing at all, the baseline a saved state is loaded over. */
function emptyState(): FullSandboxState {
  return {
    firestore: {},
    database: null,
    storage: [],
    auth: { users: [], providers: {} },
    rules: { firestore: '', database: null, storage: null },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBucket(bucket: unknown): string | undefined {
  if (typeof bucket !== 'string' || bucket === '' || bucket === DEFAULT_STORAGE_BUCKET) {
    return undefined;
  }
  return bucket;
}

function objectBaseName(fullPath: string): string {
  const slashIndex = fullPath.lastIndexOf('/');
  if (slashIndex === -1) return fullPath;
  return fullPath.slice(slashIndex + 1);
}

function cloneStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function decodeBase64Bytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function ensureReferenceMetadata(
  rawMetadata: unknown,
  bucket: string | undefined,
  fullPath: string,
  size: number,
): NonNullable<StorageObjectState['metadata']> {
  const targetBucket = bucket ?? DEFAULT_STORAGE_BUCKET;
  if (isPlainObject(rawMetadata)) {
    const {
      fullPath: _ignoredPath,
      contentType: _ignoredContentType,
      customMetadata: _ignoredCustom,
      ...rest
    } = rawMetadata;
    const timeCreated = typeof rest.timeCreated === 'string' ? rest.timeCreated : EPOCH_ISO;
    const updated = typeof rest.updated === 'string' ? rest.updated : timeCreated;
    const generation = typeof rest.generation === 'string' ? rest.generation : '1';
    const metageneration = typeof rest.metageneration === 'string' ? rest.metageneration : '1';
    const name = typeof rest.name === 'string' ? rest.name : objectBaseName(fullPath);
    return {
      ...(structuredClone(rest) as NonNullable<StorageObjectState['metadata']>),
      bucket: targetBucket,
      name,
      size,
      timeCreated,
      updated,
      generation,
      metageneration,
    };
  }
  return {
    bucket: targetBucket,
    name: objectBaseName(fullPath),
    size,
    timeCreated: EPOCH_ISO,
    updated: EPOCH_ISO,
    generation: '1',
    metageneration: '1',
  };
}

function rawStorageSliceOf(saved: SandboxSnapshot): readonly unknown[] | null {
  const withStorage = saved as SavedNamedFirestoreSnapshot;
  if (Array.isArray(withStorage.storage)) {
    return withStorage.storage;
  }
  const serviceSlice = saved.services?.storage;
  if (Array.isArray(serviceSlice)) {
    return serviceSlice;
  }
  return null;
}

/** Whether `saved` explicitly describes a Cloud Storage object slice. */
export function hasSavedStorage(saved: SandboxSnapshot): boolean {
  return rawStorageSliceOf(saved) !== null;
}

/**
 * Lift a `WorkspaceBranchStorageReference` or saved reference entry into the
 * normalized SHA-256 comparison shape used by `diffFullStates` (omitting clock
 * and generation fields that `WorkspaceBranchStorageReference` does not carry).
 */
export function comparableStorageReferenceOf(
  reference: WorkspaceBranchStorageReference,
): StorageObjectState {
  const bucket = normalizeBucket(reference.bucket);
  const entry: StorageObjectState = {
    path: reference.path,
    sha256: reference.sha256,
    size: reference.size,
    customMetadata: { ...reference.customMetadata },
  };
  if (bucket !== undefined) entry.bucket = bucket;
  if (reference.contentType !== undefined) entry.contentType = reference.contentType;
  if (reference.blobType !== undefined) entry.blobType = reference.blobType;
  return entry;
}

function trySyncReferenceFromRaw(raw: unknown): StorageObjectState | null {
  if (!isPlainObject(raw)) return null;
  const sha256 = raw.sha256;
  const size = raw.size;
  if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;

  const metaObj = isPlainObject(raw.metadata) ? raw.metadata : undefined;
  let path: string | null = null;
  if (typeof raw.path === 'string') {
    path = raw.path;
  } else if (typeof metaObj?.fullPath === 'string') {
    path = metaObj.fullPath;
  }
  if (path === null || path.length === 0) return null;

  const bucket = normalizeBucket(raw.bucket ?? metaObj?.bucket);
  let contentType: string | undefined;
  if (typeof raw.contentType === 'string') {
    contentType = raw.contentType;
  } else if (typeof metaObj?.contentType === 'string') {
    contentType = metaObj.contentType;
  }
  let customMetadata: Record<string, string>;
  if (isPlainObject(raw.customMetadata)) {
    customMetadata = cloneStringRecord(raw.customMetadata);
  } else {
    customMetadata = cloneStringRecord(metaObj?.customMetadata);
  }
  const blobType = typeof raw.blobType === 'string' ? raw.blobType : undefined;

  return comparableStorageReferenceOf({
    bucket,
    path,
    sha256,
    size,
    contentType,
    customMetadata,
    blobType,
  });
}

async function resolveStorageReferenceForFork(raw: unknown): Promise<StorageObjectState | null> {
  if (!isPlainObject(raw)) return null;
  const metaObj = isPlainObject(raw.metadata) ? raw.metadata : undefined;

  if ('contentBase64' in raw || 'sha256' in raw) {
    const candidate = raw as unknown as StorageObjectState;
    if (typeof candidate.path === 'string' && candidate.path.length > 0) {
      const bucket = normalizeBucket(candidate.bucket ?? metaObj?.bucket);
      let sha256: string;
      let size: number;
      if (holdsBytesInline(candidate)) {
        const bytes = decodeBase64Bytes(candidate.contentBase64);
        sha256 = await sha256Hex(bytes);
        size = bytes.byteLength;
      } else {
        if (!SHA256_HEX_PATTERN.test(candidate.sha256)) {
          throw new Error(`Saved Storage object '${candidate.path}' has an invalid SHA-256 reference.`);
        }
        sha256 = candidate.sha256;
        size = candidate.size;
      }
      let contentType: string | undefined;
      if (typeof candidate.contentType === 'string') {
        contentType = candidate.contentType;
      } else if (typeof metaObj?.contentType === 'string') {
        contentType = metaObj.contentType;
      }
      let customMetadata: Record<string, string>;
      if (isPlainObject(candidate.customMetadata)) {
        customMetadata = cloneStringRecord(candidate.customMetadata);
      } else {
        customMetadata = cloneStringRecord(metaObj?.customMetadata);
      }
      let blobType = contentType ?? '';
      if (typeof candidate.blobType === 'string') {
        blobType = candidate.blobType;
      }
      const entry: StorageObjectState = {
        path: candidate.path,
        sha256,
        size,
        customMetadata,
        metadata: ensureReferenceMetadata(metaObj, bucket, candidate.path, size),
        blobType,
      };
      if (bucket !== undefined) entry.bucket = bucket;
      if (contentType !== undefined) entry.contentType = contentType;
      return entry;
    }
  }

  if (typeof raw.dataBase64 === 'string' && metaObj !== undefined && typeof metaObj.fullPath === 'string') {
    const bytes = decodeBase64Bytes(raw.dataBase64);
    const sha256 = await sha256Hex(bytes);
    const size = bytes.byteLength;
    const bucket = normalizeBucket(metaObj.bucket);
    const contentType = typeof metaObj.contentType === 'string' ? metaObj.contentType : undefined;
    const blobType = typeof raw.blobType === 'string' ? raw.blobType : contentType ?? '';
    const entry: StorageObjectState = {
      path: metaObj.fullPath,
      sha256,
      size,
      customMetadata: cloneStringRecord(metaObj.customMetadata),
      metadata: ensureReferenceMetadata(metaObj, bucket, metaObj.fullPath, size),
      blobType,
    };
    if (bucket !== undefined) entry.bucket = bucket;
    if (contentType !== undefined) entry.contentType = contentType;
    return entry;
  }

  return null;
}

/** Capture `sandbox.snapshot()` enriched with any declared named Firestore databases, rules, and locked defaults. */
export function snapshotWithNamedFirestore(sandbox: LocalSandbox): SavedNamedFirestoreSnapshot {
  const base = sandbox.snapshot();
  const declared = listDeclaredFirestoreDatabases(sandbox);
  if (declared.length === 0) {
    return base;
  }
  const firestoreDatabases: Record<string, Record<string, Record<string, unknown>>> = {};
  const firestoreDatabaseRules: Record<string, string> = {};
  const firestoreLocked: string[] = [];
  let hasNamedRules = false;
  for (const dbId of declared) {
    const env = getDatabaseEnv(sandbox, dbId);
    firestoreDatabases[dbId] = structuredClone(env.snapshot());
    const explicitRules = env.getExplicitRules();
    if (explicitRules !== null && explicitRules.length > 0) {
      firestoreDatabaseRules[dbId] = explicitRules;
      hasNamedRules = true;
    }
    if (isFirestoreDatabaseLockedByDefault(sandbox, dbId)) {
      firestoreLocked.push(dbId);
    }
  }
  const enriched: SavedNamedFirestoreSnapshot = {
    ...base,
    firestoreDeclared: declared,
    firestoreDatabases,
  };
  if (hasNamedRules) {
    enriched.firestoreDatabaseRules = firestoreDatabaseRules;
  }
  if (firestoreLocked.length > 0) {
    enriched.firestoreLocked = firestoreLocked;
  }
  return enriched;
}

/**
 * The full-state view of one saved state: its Firestore documents plus any
 * SHA-256 Storage object references the saved state explicitly carries.
 * Services the saved state does not describe stay empty so they cancel out.
 */
export function savedStateOf(saved: SandboxSnapshot): FullSandboxState {
  const rawStorage = rawStorageSliceOf(saved);
  const storage: StorageObjectState[] = [];
  if (rawStorage !== null) {
    for (const item of rawStorage) {
      const lifted = trySyncReferenceFromRaw(item);
      if (lifted !== null) storage.push(lifted);
    }
  }
  return { ...emptyState(), firestore: saved.firestore, storage };
}

function hydrateNamedFirestoreOntoSandbox(
  sandbox: LocalSandbox,
  saved: SavedNamedFirestoreSnapshot,
  targetDatabaseId?: string,
): void {
  const lockedSet = new Set(saved.firestoreLocked ?? []);
  const ids = new Set<string>(saved.firestoreDeclared ?? []);
  for (const dbId of Object.keys(saved.firestoreDatabases ?? {})) {
    if (dbId !== DEFAULT_FIRESTORE_DATABASE) ids.add(dbId);
  }
  for (const dbId of Object.keys(saved.firestoreDatabaseRules ?? {})) {
    if (dbId !== DEFAULT_FIRESTORE_DATABASE) ids.add(dbId);
  }
  for (const dbId of lockedSet) {
    if (dbId !== DEFAULT_FIRESTORE_DATABASE) ids.add(dbId);
  }
  const normalizedTarget = normalizeFirestoreDatabaseId(targetDatabaseId);
  if (normalizedTarget !== DEFAULT_FIRESTORE_DATABASE) {
    ids.add(normalizedTarget);
  }
  for (const dbId of [...ids].sort()) {
    declareFirestoreDatabase(sandbox, dbId, { locked: lockedSet.has(dbId) });
    const env = getDatabaseEnv(sandbox, dbId);
    const ruleSource = saved.firestoreDatabaseRules?.[dbId];
    if (typeof ruleSource === 'string' && ruleSource.length > 0) {
      env.deployRules(ruleSource);
    }
    const docs = saved.firestoreDatabases?.[dbId];
    if (docs !== undefined) {
      for (const [docPath, docData] of Object.entries(docs)) {
        env.adminSetDocument(docPath, structuredClone(docData));
      }
    }
  }
}

/**
 * A branch standing on one saved state, under an optional candidate ruleset.
 * Any Cloud Storage objects carried on `saved` are converted to and seeded as
 * SHA-256 byte references rather than inline payloads.
 *
 * @param saved The state to stand the branch on, loaded whole.
 * @param candidateRules Firestore rules the branch runs under. The empty
 *                       source leaves the saved state's own rules in place.
 * @param databaseId Optional Firestore database id `candidateRules` targets.
 */
export async function forkFromSavedState(
  saved: SandboxSnapshot,
  candidateRules = '',
  databaseId?: string,
): Promise<Branch> {
  const rawStorage = rawStorageSliceOf(saved);
  const storageReferences: StorageObjectState[] = [];
  if (rawStorage !== null) {
    for (const item of rawStorage) {
      const resolved = await resolveStorageReferenceForFork(item);
      if (resolved !== null) storageReferences.push(resolved);
    }
  }
  const baseState: FullSandboxState = {
    ...emptyState(),
    firestore: structuredClone(saved.firestore),
    storage: storageReferences,
  };
  if (typeof saved.firestoreRules === 'string') {
    baseState.rules = { ...baseState.rules, firestore: saved.firestoreRules };
  }
  const branch = await fork(baseState);
  // Preserve `'storage'` in `services` when Storage references were seeded so
  // `loadSnapshot` does not invoke the unregistered-service reset on Storage.
  let snapshotForLoad = saved;
  if (storageReferences.length > 0 && !('storage' in saved.services)) {
    snapshotForLoad = {
      ...saved,
      services: { ...saved.services, storage: null },
    };
  }
  branch.sandbox.loadSnapshot(snapshotForLoad);
  hydrateNamedFirestoreOntoSandbox(
    branch.sandbox,
    saved as SavedNamedFirestoreSnapshot,
    databaseId,
  );
  if (candidateRules !== '') {
    const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
    let targetDbArg: string | undefined;
    if (normalizedDb !== DEFAULT_FIRESTORE_DATABASE) {
      targetDbArg = normalizedDb;
    }
    setFirestoreRules(branch.sandbox as unknown as LocalSandbox, candidateRules, targetDbArg);
  }
  return branch;
}

/**
 * The documents one branch and one saved state disagree on. Both sides lift
 * Firestore documents alone so rules and Storage references never read as
 * document drift.
 */
export function documentDivergences(
  branch: Branch,
  reference: SandboxSnapshot,
  databaseId?: string,
): BranchDivergence[] {
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  if (normalizedDb === DEFAULT_FIRESTORE_DATABASE) {
    const branchFirestore = branch.sandbox.snapshot().firestore;
    return diffFullStates(
      { ...emptyState(), firestore: reference.firestore },
      { ...emptyState(), firestore: branchFirestore },
    );
  }
  const referenceNamed = reference as SavedNamedFirestoreSnapshot;
  const referenceDocs = referenceNamed.firestoreDatabases?.[normalizedDb] ?? {};
  let branchDocs: Record<string, Record<string, unknown>> = {};
  if (isFirestoreDatabaseDeclared(branch.sandbox, normalizedDb)) {
    branchDocs = getDatabaseEnv(branch.sandbox, normalizedDb).snapshot();
  }
  return diffFullStates(
    { ...emptyState(), firestore: referenceDocs },
    { ...emptyState(), firestore: branchDocs },
  );
}
