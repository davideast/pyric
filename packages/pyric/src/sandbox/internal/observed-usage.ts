/**
 * What production billed or moved for one observed call, measured from the
 * value the app's own SDK resolved with. The page and Node senders share this
 * one measurement, so a call measures the same on either plane.
 *
 * Counts only: a document, a value or a payload never leaves this function.
 * Listener deliveries are not measured here; they carry `billedDocuments`.
 * AI calls are not measured here; their tokens ride `ObservedCall.ai`.
 */
import type { ObservedUsage } from '../types/observed-call.js';
import { databaseReadUsage, firestoreReadUsage, firestoreWriteUsage, type UsageEvidence } from './usage-evidence.js';
import { coverageMethodOf } from './admin-methods.js';

/** Production bills one read per 1000 index entries a count scans, at least one. */
const COUNT_ENTRIES_PER_READ = 1000;

const FIRESTORE_READS: ReadonlySet<string> = new Set(['getDoc', 'getDocFromServer', 'getDocs', 'getDocsFromServer']);
const FIRESTORE_CACHE_READS: ReadonlySet<string> = new Set(['getDocFromCache', 'getDocsFromCache']);
const STORAGE_UPLOADS: ReadonlySet<string> = new Set(['uploadBytes', 'uploadString', 'uploadBytesResumable']);
const USAGE_KEYS = [
  'documentReads', 'documentWrites', 'documentDeletes', 'payloadBytes', 'uploadedBytes', 'downloadedBytes', 'unmeasured',
] as const;

type Measure = (method: string, value: unknown) => ObservedUsage | undefined;

const MEASURES: ReadonlyMap<string, Measure> = new Map<string, Measure>([
  ['firebase/firestore', firestoreUsage],
  ['firebase/database', databaseUsage],
  ['firebase/storage', storageUsage],
  ['@google-cloud/firestore', adminFirestoreUsage],
  ['@firebase/database-compat/standalone', (method, value) => databaseUsage(coverageMethodOf('rtdb', method), value)],
  ['@google-cloud/storage', (method, value) => storageUsage(coverageMethodOf('storage', method), value)],
]);

/** The usage of a call to `method` of `module` (the specifier the app imported) that resolved with `value`, or undefined when there is none to record. */
export function measureObservedUsage(module: string, method: string, value: unknown): ObservedUsage | undefined {
  return MEASURES.get(module)?.(method, value);
}

function firestoreUsage(method: string, value: unknown): ObservedUsage | undefined {
  if (FIRESTORE_CACHE_READS.has(method)) return { documentReads: 0 };
  if (FIRESTORE_READS.has(method)) return usageOf(firestoreReadUsage(value));
  if (method === 'getCountFromServer') return { documentReads: countReads(value) };
  if (method === 'getAggregateFromServer') return { documentReads: 1, unmeasured: 1 };
  if (method === 'runTransaction') return { documentWrites: 1, unmeasured: 1 };
  const written = firestoreWriteUsage(method);
  return written === undefined ? undefined : usageOf(written);
}

/**
 * An Admin Firestore call, measured as the client method it counts as. Two
 * resolve with an array the client methods don't: `Firestore.getAll`, one
 * snapshot per document read, and `WriteBatch.commit`, one result per write.
 */
function adminFirestoreUsage(method: string, value: unknown): ObservedUsage | undefined {
  const isArray = Array.isArray(value);
  if (isArray && method === 'Firestore.getAll') return { documentReads: Math.max(1, value.length) };
  if (isArray && method === 'WriteBatch.commit') return { documentWrites: value.length };
  return firestoreUsage(coverageMethodOf('firestore', method), value);
}

function databaseUsage(method: string, value: unknown): ObservedUsage | undefined {
  return method === 'get' ? usageOf(databaseReadUsage(value)) : undefined;
}

function storageUsage(method: string, value: unknown): ObservedUsage | undefined {
  if (STORAGE_UPLOADS.has(method)) return bytesOr('uploadedBytes', uploadedSize(value));
  if (method === 'getBytes') return bytesOr('downloadedBytes', numberField(value, 'byteLength'));
  if (method === 'getBlob') return bytesOr('downloadedBytes', numberField(value, 'size'));
  return undefined;
}

/** `ceil(count / 1000)`, at least one, from an `AggregateQuerySnapshot`'s `data().count`. */
function countReads(value: unknown): number {
  const data = (value as { data?: () => { count?: unknown } } | null)?.data?.();
  const count = typeof data?.count === 'number' ? data.count : 0;
  return Math.max(1, Math.ceil(count / COUNT_ENTRIES_PER_READ));
}

/** An `UploadResult` or `UploadTaskSnapshot`'s `metadata.size`. */
function uploadedSize(value: unknown): number | undefined {
  return numberField((value as { metadata?: unknown } | null)?.metadata, 'size');
}

/** A numeric field read by name, so a value needs no `Blob` or `ArrayBuffer` global to be measured. */
function numberField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function bytesOr(key: 'uploadedBytes' | 'downloadedBytes', bytes: number | undefined): ObservedUsage {
  return bytes === undefined ? { unmeasured: 1 } : { [key]: bytes };
}

/** The observed-call fields of a usage evidence record; its AI counters stay behind. */
function usageOf(evidence: UsageEvidence): ObservedUsage {
  const usage: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const count = evidence[key];
    if (count !== undefined) usage[key] = count;
  }
  return usage;
}
