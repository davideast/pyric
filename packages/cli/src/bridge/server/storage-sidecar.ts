/**
 * Storage state as a file beside the in-process snapshot.
 *
 * The sandbox's storage service deliberately stays out of the v3 bundle: it
 * owns its own durability through IndexedDB, and blobs are not JSON. In a Node
 * process that IndexedDB is in memory, so nothing a run stores survives the
 * process. Storage state has to cross that boundary for an in-process session to
 * be worth reopening, so it gets its own sidecar next to `in-process.json`.
 *
 * The in-process server loads the sidecar before it serves and writes it in the
 * same final flush that writes the snapshot. Without that, storage reads back
 * empty on the next start and an object uploaded in one session is gone in the
 * next.
 *
 * What a bucket's contents are, and how they are read out and written back, is
 * `bridge/surface/storage-state.ts`. This module is the file: where it lives
 * and when it is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FirebaseStorage } from 'pyric/storage';
import {
  exportStorage,
  restoreStorage,
  type StorageObjectRecord,
} from '../surface/storage-state.js';

/** Where the sidecar lives, relative to the run directory. */
export const STORAGE_SIDECAR_RELATIVE = join('.pyric', 'state', 'storage.json');

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
  return restoreStorage(storage, records);
}
