import { SandboxImpl, getInternalEnv } from '../internal/sandbox-impl.js';
import type { Sandbox } from '../types/service.js';
import { deserializeFromBuckets, migrateV2ToRecords } from './chunk-format.js';
import { skipIncompatibleFormat } from './incompatible.js';
import type { SkippedDocuments } from './skipped-documents.js';
import type { PersistenceBackend } from './types.js';

/**
 * Stable 32-bit FNV-1a content hash of a bucket record, for detecting which
 * buckets changed between flushes. A genuinely changed record almost never
 * hashes equal to its prior content; in the astronomically rare event of a
 * collision the bucket simply re-persists on its next change. Bucket key order
 * is stable across flushes (snapshot iteration order), so an UNCHANGED bucket
 * always hashes identically.
 */
export function hashSerialized(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function hashRecord(record: unknown): number {
  const s = JSON.stringify(record);
  if (s === undefined) return 0;
  return hashSerialized(s);
}

/**
 * Read the persisted blob for `key` and hydrate every document into
 * the sandbox via the admin write surface, then restore any registered
 * service state from the `services` map.
 *
 * Returns the raw `services` blob map (or `null` if no blob existed)
 * so the controller can apply it to services that register AFTER this
 * call returns (the late-registration case).
 *
 * Restore order: Firestore first, then services. Auth users need to
 * land after Firestore is ready, not before -- matches the natural
 * initialization order.
 *
 * Incompatible newer or malformed formats are quarantined to `<key>:corrupt`
 * when the backend supports distinct keys, or left untouched with flushing
 * paused until an explicit `clear()` when quarantining is not possible.
 *
 * Listeners attached to the sandbox before restore will see each
 * hydrated doc as a fresh notification -- intentional. The natural
 * place to call `enablePersistence` is right after `initializeSandbox`,
 * before any listeners attach, so this rarely matters in practice.
 *
 * Each service restore is wrapped in try/catch -- a failing service
 * restore must not abort Firestore restore (the core data is more
 * critical). A warning is logged but the sandbox stays usable.
 */
export async function restoreSnapshot(
  sandbox: Sandbox,
  backend: PersistenceBackend,
  key: string,
  lastHashes: Map<string, number>,
  staleIds: Set<string>,
  skippedDocuments?: SkippedDocuments,
): Promise<{ services: Record<string, unknown> | null; preserveIncompatible: boolean }> {
  let ids: string[];
  try {
    ids = await backend.listRecords(key);
  } catch (e) {
    console.warn('[sandbox/persistence] backend list failed:', e);
    return { services: null, preserveIncompatible: false };
  }
  if (ids.length === 0) return { services: null, preserveIncompatible: false };
  const records: [string, unknown][] = [];
  for (const id of ids) {
    try {
      const rec = await backend.getRecord(key, id);
      if (rec !== null) records.push([id, rec]);
    } catch (e) {
      console.warn(`[sandbox/persistence] failed to read persisted record '${id}':`, e);
    }
  }
  // C4 migrate-on-open: a legacy v2 record is the old single JSON blob (a
  // string); v3 records are objects. Convert any v2 blob to v3 buckets in place,
  // then delete the legacy record so the next open is pure v3.
  const v3Records: [string, unknown][] = [];
  const legacyIds: string[] = [];
  let migrated: Map<string, unknown> | null = null;
  for (const [id, rec] of records) {
    if (typeof rec === 'string') {
      const m = migrateV2ToRecords(rec);
      if (m) {
        legacyIds.push(id);
        migrated = m;
      }
      // a string that is not a recognizable v2 blob is unrecognized: skip it.
    } else {
      v3Records.push([id, rec]);
    }
  }
  if (migrated) {
    try {
      await backend.putRecords(key, migrated);
      if (legacyIds.length > 0) await backend.deleteRecords(key, legacyIds);
    } catch (e) {
      console.warn('[sandbox/persistence] v2 migration write failed:', e);
    }
    for (const [id, rec] of migrated) v3Records.push([id, rec]);
  }
  const formatOutcome = await skipIncompatibleFormat(backend, key, v3Records, staleIds);
  if (formatOutcome !== 'compatible') {
    return { services: null, preserveIncompatible: formatOutcome === 'preserved' };
  }
  // Seed the flush hash state from the persisted records, so the first flush
  // does not redundantly re-write the just-restored buckets.
  for (const [id, rec] of v3Records) lastHashes.set(id, hashRecord(rec));
  const parsed = deserializeFromBuckets(v3Records, {
    skipInvalidDocuments: true,
    onSkippedDocument: (bucketId, path, rawDocument) => {
      skippedDocuments?.remember(bucketId, path, rawDocument);
    },
  });

  // 1. Restore Firestore documents first. These are the structural data
  //    that services (auth) may depend on being present.
  //    Written through the quiet environment path: a restore is not a session
  //    action, so it must not add admin write events to `history()`.
  const isLocalSandbox = sandbox instanceof SandboxImpl;
  for (const [path, data] of Object.entries(parsed.firestore)) {
    if (isLocalSandbox) getInternalEnv(sandbox).adminSetDocument(path, data);
    else sandbox.admin.setDocument(path, data);
  }

  // 2. Restore registered service state. Only services that are BOTH in
  //    the blob AND currently registered are restored here. Services not
  //    yet registered (late registration: enablePersistence before getAuth)
  //    receive their data when they register via the hook installed by
  //    attachPersistence. Each service restore is isolated so a broken
  //    service does not kill the entire restore.
  if (sandbox instanceof SandboxImpl) {
    const registry = sandbox.getServiceRegistry();
    for (const [name, data] of Object.entries(parsed.services)) {
      const svc = registry.get(name);
      if (!svc) continue; // not yet registered; will be applied via late-restore hook
      try {
        svc.restore(data);
      } catch (e) {
        console.warn(
          `[sandbox/persistence] service '${name}' restore failed -- ` +
            `Firestore state is intact; auth users may need to be re-created:`,
          e,
        );
      }
    }
  }

  // Return the services blob so the controller can apply it to services
  // that register after this call (the late-registration case).
  return { services: parsed.services, preserveIncompatible: false };
}
