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

export async function snapshotStorageState(storage: FirebaseStorage): Promise<StorageStateRecord[]> {
  const service = await getStorageService(storage);
  const records: StorageStateRecord[] = [];
  for (const metadata of await service.backend.listByPrefix('')) {
    const blob = await service.backend.getBlob(metadata.fullPath, metadata.bucket);
    const isMissingBlob = blob === undefined;
    if (isMissingBlob) throw new Error(`Storage object '${metadata.fullPath}' has metadata without bytes.`);
    records.push({
      dataBase64: arrayBufferToBase64(await blob.arrayBuffer()),
      blobType: blob.type,
      metadata: structuredClone(metadata),
    });
  }
  return records;
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
