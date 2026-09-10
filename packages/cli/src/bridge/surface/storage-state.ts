/**
 * Reading a bucket out, and writing one back.
 *
 * Storage stays out of the sandbox's record bundle: it owns its own durability
 * through IndexedDB, and blobs are not JSON. So every part of the surface that
 * saves or replaces sandbox state has to walk the bucket itself, and this is
 * the one walk they share. A checkpoint captures it, a fixture exports it, a
 * scoped reset clears it, and the in-process server's sidecar file is the same
 * records written to disk.
 *
 * It is a leaf: it knows the SDK and nothing about the server, the surface's
 * context, or where any of this is stored.
 */
import {
  ref as storageRef,
  uploadBytes,
  getBytes,
  getMetadata,
  listAll,
  type FirebaseStorage,
} from 'pyric/storage';

/** One stored object, in the shape a capture holds it. */
export interface StorageObjectRecord {
  path: string;
  contentBase64: string;
  contentType?: string;
  metadata: Record<string, unknown>;
}

/**
 * Every object path in the bucket. `listAll` reports one level, so the walk
 * descends into each prefix it returns.
 */
export async function listStoredPaths(storage: FirebaseStorage): Promise<string[]> {
  const paths: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const prefix = pending.pop() as string;
    const listing = await listAll(storageRef(storage, prefix));
    for (const item of listing.items) paths.push(item.fullPath);
    for (const child of listing.prefixes) pending.push(child.fullPath);
  }
  paths.sort();
  return paths;
}

/** Read every object out of the bucket into records. */
export async function exportStorage(storage: FirebaseStorage): Promise<StorageObjectRecord[]> {
  const records: StorageObjectRecord[] = [];
  for (const path of await listStoredPaths(storage)) {
    const metadata = await getMetadata(storageRef(storage, path));
    const bytes = await getBytes(storageRef(storage, path));
    const record: StorageObjectRecord = {
      path,
      contentBase64: Buffer.from(new Uint8Array(bytes)).toString('base64'),
      metadata: metadata.customMetadata ?? {},
    };
    if (metadata.contentType !== undefined) record.contentType = metadata.contentType;
    records.push(record);
  }
  return records;
}

/** Write every record into a bucket. Returns the number of objects restored. */
export async function restoreStorage(
  storage: FirebaseStorage,
  records: readonly StorageObjectRecord[],
): Promise<number> {
  for (const record of records) {
    const bytes = Uint8Array.from(Buffer.from(record.contentBase64, 'base64'));
    const settable: { contentType?: string; customMetadata?: Record<string, string> } = {};
    if (record.contentType !== undefined) settable.contentType = record.contentType;
    const custom = toCustomMetadata(record.metadata);
    if (custom !== null) settable.customMetadata = custom;
    await uploadBytes(storageRef(storage, record.path), bytes, settable);
  }
  return records.length;
}

/** Storage custom metadata is a string map; anything else is dropped rather than coerced. */
export function toCustomMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> | null {
  const entries: Record<string, string> = {};
  let found = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') continue;
    entries[key] = value;
    found = true;
  }
  if (!found) return null;
  return entries;
}
