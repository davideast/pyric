/**
 * Snapshot serialization for sandbox persistence.
 *
 * Goes in two directions:
 *
 *   serialize: SandboxSnapshot → string
 *     `JSON.stringify` already does most of the work. Each wrapper
 *     type (Timestamp, Bytes, LatLng, Duration, Reference, Path,
 *     Vector) ships a `toJSON()` that emits a marker shape — those
 *     come for free.
 *
 *   deserialize: string → SandboxSnapshot
 *     Parse, then walk the tree and re-wrap any marker shape back into
 *     its wrapper class instance. Rule evaluation depends on `instanceof
 *     Timestamp` checks etc., so restored docs must carry the class
 *     instances, not the marker objects.
 *
 * Schema version is captured in the blob so future format changes can
 * be detected and reported (rather than corrupting silently).
 */

// The marker-based value codec lives in a STANDALONE leaf module
// (`firestore-values`) so the SharedWorker client can rehydrate doc values
// WITHOUT pulling the rules engine. `serialize.ts` re-uses that same codec so
// there is exactly one rehydrate implementation — the IDB persistence format
// and the MessagePort wire format can't drift.
import { rehydrateDocValue } from '../../firestore-values/index.js';

// Re-exported so existing consumers (`sandbox/persistence/index.ts` →
// `pyric/sandbox`) keep their import path; the implementation now lives in the
// leaf codec.
export { rehydrateDocValue };

/**
 * Current on-disk format version.
 *
 * v1 → v2 (this release): added `services: Record<string, unknown>` to
 * persist plugged-in service state (auth users, etc.). v1 blobs are
 * accepted on read with `services` defaulted to `{}` — the forward-
 * compatible choice for a pre-release library where old blobs are
 * dev-only and disposable. New writes always emit v2.
 */
const SCHEMA_VERSION = 2 as const;

interface SerializedBlob {
  version: 1 | 2;
  savedAt: number;
  firestore: Record<string, Record<string, unknown>>;
  /** Present in v2+. Absent in v1 blobs (pre-service-registry). */
  services?: Record<string, unknown>;
}

export class PersistenceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceSchemaError';
  }
}

/** Serialize a sandbox snapshot to a string blob ready for storage. */
export function serializeSnapshot(
  firestore: Record<string, Record<string, unknown>>,
  services: Record<string, unknown> = {},
): string {
  const payload: SerializedBlob = {
    version: SCHEMA_VERSION,
    savedAt: Date.now(),
    firestore,
    services,
  };
  return JSON.stringify(payload);
}

/**
 * Parsed result of a persisted blob.
 *
 * `firestore` is the rehydrated Firestore document map — class
 * instances (Timestamp, Bytes, etc.) are restored from their marker
 * shapes. `services` is the raw (no rehydration needed) per-service
 * state map; each entry is whatever the service's
 * `PersistableService.snapshot()` emitted.
 */
export interface DeserializedSnapshot {
  firestore: Record<string, Record<string, unknown>>;
  services: Record<string, unknown>;
}

/**
 * Parse a stored blob back into a snapshot. Throws
 * {@link PersistenceSchemaError} on an unrecognized version or
 * malformed input.
 *
 * **v1 compatibility:** v1 blobs (no `services` field) are accepted
 * and treated as having an empty services map. This is the clean
 * forward-compatible choice for a pre-release library: old dev blobs
 * just don't have auth users, which is correct — the user hadn't opted
 * into auth persistence yet. New writes always emit v2.
 */
export function deserializeSnapshot(raw: string): DeserializedSnapshot {
  let parsed: SerializedBlob;
  try {
    parsed = JSON.parse(raw) as SerializedBlob;
  } catch (e) {
    throw new PersistenceSchemaError(
      `Persisted blob is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PersistenceSchemaError('Persisted blob is not an object');
  }
  // Accept v1 (no services) and v2 (with services). Any other version
  // is unrecognized — quarantine it so we don't silently corrupt state.
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new PersistenceSchemaError(
      `Persisted blob has version ${String(parsed.version)}, expected 1 or 2`,
    );
  }
  if (typeof parsed.firestore !== 'object' || parsed.firestore === null) {
    throw new PersistenceSchemaError('Persisted blob has no firestore field');
  }
  const firestore: Record<string, Record<string, unknown>> = {};
  for (const [path, data] of Object.entries(parsed.firestore)) {
    firestore[path] = rehydrateDocValue(data) as Record<string, unknown>;
  }
  // v1 blobs lack `services` — default to {} so the restore path
  // proceeds without error. No auth users in the blob = no auth restore.
  const services = (parsed.services !== undefined && typeof parsed.services === 'object' && parsed.services !== null)
    ? (parsed.services as Record<string, unknown>)
    : {};
  return { firestore, services };
}
