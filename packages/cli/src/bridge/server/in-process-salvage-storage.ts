/**
 * Partial recovery helper for the optional `.pyric/state/storage.json`
 * sidecar beside `in-process.json`.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { initializeSandbox } from 'pyric/sandbox';
import {
  BY_REFERENCE_ALTERNATIVE,
  InlineStorageLimitError,
  assertInlineStorageFits,
  base64DecodedLength,
  type InlineStorageDocument,
} from 'pyric/sandbox/internal';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import type { RecoveryReport } from '../../serve/hosted/persistence/salvage.js';
import { restoreStorage, type StorageObjectRecord } from '../surface/storage-state.js';

const SIDECAR_DOCUMENT: InlineStorageDocument = {
  document: 'The in-process storage file `.pyric/state/storage.json`',
  instead: BY_REFERENCE_ALTERNATIVE,
};

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const storageRecordShape = z.object({
  bucket: z.string().min(1).optional(),
  path: z.string().min(1),
  contentBase64: z.string(),
  metadata: z.record(z.unknown()),
  contentType: z.string().optional(),
  cacheControl: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentEncoding: z.string().optional(),
  contentLanguage: z.string().optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export async function salvageStorageSidecar(
  sidecarPath: string,
  hasSnapshotFile: boolean,
  report: RecoveryReport,
): Promise<StorageObjectRecord[]> {
  const raw = readFileSync(sidecarPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (!hasSnapshotFile) {
      throw new Error(
        'In-process storage sidecar is not valid JSON; recovery cannot establish the payload format.',
      );
    }
    report.excluded.push({ namespace: 'storage', id: 'storage.json', reason: 'Invalid JSON' });
    return [];
  }
  if (!Array.isArray(parsed)) {
    if (!hasSnapshotFile) {
      throw new Error(
        'In-process storage sidecar must be a JSON array; recovery cannot establish the payload format.',
      );
    }
    report.excluded.push({
      namespace: 'storage',
      id: 'storage.json',
      reason: 'Storage sidecar must be an array',
    });
    return [];
  }
  const recovered: StorageObjectRecord[] = [];
  const byKey = new Map<string, number>();
  const duplicateKeys = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index];
    const parsedEntry = storageRecordShape.safeParse(entry);
    if (!parsedEntry.success) {
      let fallbackId = `storage.json[${index}]`;
      if (isPlainObject(entry) && typeof entry.path === 'string' && entry.path.length > 0) {
        fallbackId = entry.path;
      }
      report.excluded.push({
        namespace: 'storage',
        id: fallbackId,
        reason: 'Object validation failed',
      });
      continue;
    }
    const candidate = parsedEntry.data as StorageObjectRecord;
    const bucketLabel = candidate.bucket ?? 'default';
    const objectId = `${bucketLabel}/${candidate.path}`;
    if (!STRICT_BASE64.test(candidate.contentBase64)) {
      report.excluded.push({
        namespace: 'storage',
        id: objectId,
        reason: 'Object base64 payload is malformed',
      });
      continue;
    }
    if (duplicateKeys.has(objectId)) continue;
    const existingIndex = byKey.get(objectId);
    if (existingIndex !== undefined) {
      const removed = recovered[existingIndex];
      totalBytes -= base64DecodedLength(removed.contentBase64);
      recovered.splice(existingIndex, 1);
      byKey.clear();
      for (let i = 0; i < recovered.length; i++) {
        const item = recovered[i];
        byKey.set(`${item.bucket ?? 'default'}/${item.path}`, i);
      }
      report.recoveredObjects--;
      duplicateKeys.add(objectId);
      report.excluded.push({
        namespace: 'storage',
        id: objectId,
        reason: 'Duplicate storage object path; all versions excluded',
      });
      continue;
    }
    const nextBytes = totalBytes + base64DecodedLength(candidate.contentBase64);
    try {
      assertInlineStorageFits(nextBytes, SIDECAR_DOCUMENT);
      const probeSandbox = initializeSandbox();
      await restoreStorage(getAdminStorageSandbox(probeSandbox), [candidate]);
    } catch (error) {
      if (error instanceof InlineStorageLimitError) throw error;
      report.excluded.push({
        namespace: 'storage',
        id: objectId,
        reason: 'Object validation failed',
      });
      continue;
    }
    totalBytes = nextBytes;
    byKey.set(objectId, recovered.length);
    recovered.push(candidate);
    report.recoveredObjects++;
  }
  return recovered;
}
