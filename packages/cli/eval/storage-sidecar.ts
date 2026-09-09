/**
 * Storage state as a file beside the headless snapshot.
 *
 * The sandbox's storage service deliberately stays out of the v3 bundle: it
 * owns its own durability through IndexedDB, and blobs are not JSON. In a Node
 * process that IndexedDB is in memory, so nothing a run stores survives the
 * process. The eval needs storage state to cross the process boundary, so it
 * writes its own sidecar next to `headless.json`.
 *
 * Any server that wants storage-shaped tasks scored must call
 * {@link saveStorageSidecar} before it exits, the same way it flushes the
 * headless snapshot. Without that, storage reads back empty and a storage task
 * fails rather than reporting stale seed state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ref as storageRef,
  uploadBytes,
  getBytes,
  getMetadata,
  listAll,
  type FirebaseStorage,
} from 'pyric/storage';

/** Where the sidecar lives, relative to the run directory. */
export const STORAGE_SIDECAR_RELATIVE = join('.pyric', 'state', 'storage.json');

/** One stored object, in the shape the sidecar holds it. */
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

/** Read every object out of the bucket into sidecar records. */
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

/** Write the bucket's contents to `<dir>/.pyric/state/storage.json`. */
export async function saveStorageSidecar(storage: FirebaseStorage, dir: string): Promise<void> {
  const records = await exportStorage(storage);
  const path = join(dir, STORAGE_SIDECAR_RELATIVE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

/** Load a sidecar back into a bucket. Returns the number of objects restored. */
export async function loadStorageSidecar(storage: FirebaseStorage, dir: string): Promise<number> {
  const path = join(dir, STORAGE_SIDECAR_RELATIVE);
  if (!existsSync(path)) return 0;
  const records = JSON.parse(readFileSync(path, 'utf8')) as StorageObjectRecord[];
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
function toCustomMetadata(metadata: Record<string, unknown>): Record<string, string> | null {
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
