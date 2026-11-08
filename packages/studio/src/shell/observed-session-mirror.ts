/**
 * The read-only, memory-only mirror Studio renders observed Live-mode data
 * through (`docs/research/live-mode.md` §§ 4, 6, 9):
 *
 * - Observed Firestore documents are rehydrated into an ephemeral `Sandbox`
 *   that never enables persistence, IndexedDB, or `.pyric/`.
 * - The Firestore API handed to the Data views rejects every mutation
 *   (`setDoc`, `addDoc`, `deleteDoc`) with `PYRIC_LIVE_REFUSED`, matching the
 *   host's `own-writes.ts` guardrail.
 */
import { createAppForSandbox } from 'pyric/app/internal';
import { getAuth } from 'pyric/auth';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  collection,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  query,
  startAfter,
  vector,
  type Firestore,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import type { FirestoreApi } from '@pyric/ui/firestore';
import { listDocumentsForBrowse, type StudioDataHandles } from '../features/data/sandbox.js';
import { FORBIDDEN_KEYS, isPlainRecord } from './observed-session-parse.js';
import { studioAdminContext } from './studio-operation-context.js';

export function createLiveRefusedError(): Error & { code: string } {
  const err = new Error(
    'Pyric Live mode is read-only (PYRIC_LIVE_REFUSED): Studio cannot edit production or implicitly mutate local state. Use "Seed local sandbox…" to explicitly seed observed session data into your local sandbox.',
  ) as Error & { code: string };
  err.code = 'PYRIC_LIVE_REFUSED';
  return err;
}

/** Run `build`, falling back to a plain copy of `value` when the SDK rejects the shape. */
function rehydrateOrCopy(value: Record<string, unknown>, build: () => unknown): unknown {
  try {
    return build();
  } catch {
    return { ...value };
  }
}

function isTimestampShape(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.length === 2 && typeof value.seconds === 'number' && typeof value.nanoseconds === 'number';
}

function isGeoPointShape(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.length === 2 && typeof value.latitude === 'number' && typeof value.longitude === 'number';
}

function isBytesShape(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.length === 2 && value.type === 'firestore/bytes/1.0' && typeof value.bytes === 'string';
}

function isVectorShape(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    keys.length === 2 &&
    value.__type__ === '__vector__' &&
    Array.isArray(value.value) &&
    value.value.every((n) => typeof n === 'number')
  );
}

function isDocumentReferenceShape(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    keys.length === 3 &&
    value.type === 'document' &&
    typeof value.path === 'string' &&
    typeof value.id === 'string'
  );
}

function rehydrateRecord(db: Firestore, value: Record<string, unknown>): unknown {
  const keys = Object.keys(value);
  if (isTimestampShape(value, keys)) {
    return rehydrateOrCopy(value, () => new Timestamp(value.seconds as number, value.nanoseconds as number));
  }
  if (isGeoPointShape(value, keys)) {
    return rehydrateOrCopy(value, () => new GeoPoint(value.latitude as number, value.longitude as number));
  }
  if (isBytesShape(value, keys)) {
    return rehydrateOrCopy(value, () => Bytes.fromBase64String(value.bytes as string));
  }
  if (isVectorShape(value, keys)) {
    return rehydrateOrCopy(value, () => vector(value.value as number[]));
  }
  if (isDocumentReferenceShape(value, keys)) {
    const path = value.path as string;
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return rehydrateOrCopy(value, () => doc(db, normalizedPath));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = rehydrateFirestoreValue(db, v);
  }
  return out;
}

function rehydrateFirestoreValue(db: Firestore, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => rehydrateFirestoreValue(db, item));
  }
  if (isPlainRecord(value)) return rehydrateRecord(db, value);
  return value;
}

/** Turn an observed document's JSON form back into SDK values (Timestamp, GeoPoint, Bytes, vector, references). */
export function rehydrateObservedFirestoreDoc(
  db: Firestore,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return rehydrateFirestoreValue(db, data) as Record<string, unknown>;
}

export const readOnlyFirestoreApi: FirestoreApi = {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  startAfter,
  addDoc: (() => Promise.reject(createLiveRefusedError())) as unknown as FirestoreApi['addDoc'],
  setDoc: (() => Promise.reject(createLiveRefusedError())) as unknown as FirestoreApi['setDoc'],
  deleteDoc: (() =>
    Promise.reject(createLiveRefusedError())) as unknown as FirestoreApi['deleteDoc'],
};

let observedAppSeq = 0;

/** A fresh, purely in-memory sandbox and the Data-view handles over it. */
export function createEphemeralHandles(): StudioDataHandles {
  const sandbox = initializeSandbox();
  const app = createAppForSandbox(
    sandbox,
    { projectId: 'pyric-live-observed' },
    `pyric-live-observed-${observedAppSeq++}`,
  );
  const env = getInternalEnv(sandbox);
  const adminCtx = studioAdminContext(sandbox);
  return {
    sandbox,
    app,
    firestore: getFirestore(sandbox),
    adminFirestore: getAdminFirestore(adminCtx),
    auth: getAuth(sandbox),
    storage: getAdminStorageSandbox(adminCtx),
    listRootCollections: () => env.listRootCollections(),
    listSubcollections: (docPath: string) => env.listSubcollections(docPath),
    listDocuments: (collectionPath: string) => listDocumentsForBrowse(env, collectionPath),
  };
}
