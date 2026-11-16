import { isSingleKeyBackend } from './backends.js';
import { CHUNK_FORMAT_VERSION, META_RECORD_ID } from './chunk-format.js';
import type { PersistenceBackend } from './types.js';

/**
 * Inspect the `meta` record for format-version compatibility.
 *
 * Legacy older versions (`version < CHUNK_FORMAT_VERSION`) are skipped and
 * marked stale so the next flush replaces them cleanly. Future or malformed
 * metadata versions are quarantined to `<key>:corrupt` before marking the live
 * records stale so newer-format data is never silently destroyed.
 */
export async function skipIncompatibleFormat(
  backend: PersistenceBackend,
  key: string,
  records: ReadonlyArray<[string, unknown]>,
  staleIds: Set<string>,
): Promise<boolean> {
  const metaEntry = records.find(([id]) => id === META_RECORD_ID);
  if (metaEntry === undefined) return false;
  const metaRec = metaEntry[1];
  const isObject = metaRec !== null && typeof metaRec === 'object' && !Array.isArray(metaRec);
  const version = isObject ? (metaRec as { version?: unknown }).version : undefined;
  if (version === CHUNK_FORMAT_VERSION) return false;

  const isLegacyVersion =
    typeof version === 'number' && Number.isFinite(version) && version < CHUNK_FORMAT_VERSION;
  if (isLegacyVersion) {
    console.warn(
      `[sandbox/persistence] unsupported persistence format version ${version} (expected ${CHUNK_FORMAT_VERSION}); skipping incompatible persisted state`,
    );
    for (const [id] of records) staleIds.add(id);
    return true;
  }

  const versionLabel = String(version);
  if (isSingleKeyBackend(backend)) {
    console.warn(
      `[sandbox/persistence] unsupported persistence format version ${versionLabel} (expected ${CHUNK_FORMAT_VERSION}); leaving incompatible persisted records untouched`,
    );
    return true;
  }

  const corruptKey = `${key}:corrupt`;
  let quarantined = false;
  try {
    // One forensic slot per key: replace any previous quarantine snapshot.
    await backend.clear(corruptKey);
    await backend.putRecords(corruptKey, new Map(records));
    quarantined = true;
  } catch (error) {
    console.warn(
      `[sandbox/persistence] failed to quarantine incompatible persisted state to '${corruptKey}':`,
      error,
    );
  }
  const outcome = quarantined
    ? `quarantined persisted state to '${corruptKey}'`
    : 'leaving incompatible persisted records untouched';
  console.warn(
    `[sandbox/persistence] unsupported persistence format version ${versionLabel} (expected ${CHUNK_FORMAT_VERSION}); ${outcome}`,
  );
  if (quarantined) {
    for (const [id] of records) staleIds.add(id);
  }
  return true;
}
