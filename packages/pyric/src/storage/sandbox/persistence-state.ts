import type { FirebaseStorage } from '../service.js';
import { getStorageService } from '../service.js';
import type { StoredMetadata } from '../persistence.js';
import { arrayBufferToBase64, base64ToBytes } from '../base64.js';

/** Lossless object records for a host persisting the handle's bucket. */
export interface StorageStateRecord {
  dataBase64: string;
  blobType: string;
  metadata: StoredMetadata;
}

/**
 * Each record's metadata and bytes are read together, so an object overwritten
 * while the capture runs is recorded as one write's pair. An object deleted
 * after the listing was read is left out.
 */
export async function snapshotStorageState(storage: FirebaseStorage): Promise<StorageStateRecord[]> {
  const service = await getStorageService(storage);
  const records: StorageStateRecord[] = [];
  for (const listed of await service.backend.listByPrefix('')) {
    const object = await service.backend.getObject(listed.fullPath, listed.bucket);
    const deletedSinceListing = object === undefined;
    if (deletedSinceListing) continue;
    const { blob, metadata } = object;
    records.push({
      dataBase64: arrayBufferToBase64(await blob.arrayBuffer()),
      blobType: blob.type,
      metadata: structuredClone(metadata),
    });
  }
  return records;
}

/** An object whose bytes its backend holds in a file named by their SHA-256. */
export interface StorageReferenceRecord {
  sha256: string;
  size: number;
  blobType: string;
  metadata: StoredMetadata;
}

/** Every object in the handle's bucket as a reference; reads no object bytes. */
export async function referenceStorageState(storage: FirebaseStorage): Promise<StorageReferenceRecord[]> {
  const service = await getStorageService(storage);
  const references = service.backend.references;
  const unsupported = references === undefined;
  if (unsupported) throw new Error('This Storage backend keeps no object files to refer to.');
  return references.call(service.backend);
}

/** Restore objects whose bytes the backend already holds, writing only their metadata. */
export async function restoreStorageReferences(storage: FirebaseStorage, records: readonly StorageReferenceRecord[]): Promise<void> {
  const service = await getStorageService(storage);
  const putReference = service.backend.putReference;
  const unsupported = putReference === undefined;
  if (unsupported) throw new Error('This Storage backend keeps no object files to refer to.');
  for (const record of records) {
    await putReference.call(service.backend, record.metadata.fullPath, { sha256: record.sha256, size: record.size }, record.blobType, structuredClone(record.metadata));
  }
}

/** Restore stored metadata directly, retaining generations and timestamps. */
export async function restoreStorageState(storage: FirebaseStorage, records: readonly StorageStateRecord[]): Promise<void> {
  const service = await getStorageService(storage);
  for (const record of records) {
    const bytes = Uint8Array.from(base64ToBytes(record.dataBase64));
    const blob = new Blob([bytes], { type: record.blobType });
    await service.backend.put(record.metadata.fullPath, blob, structuredClone(record.metadata));
  }
}

/** Clear the bucket, including writes already queued but not yet visible to listings. */
export async function resetStorageState(storage: FirebaseStorage): Promise<void> {
  const service = await getStorageService(storage);
  await service.backend.reset();
}
