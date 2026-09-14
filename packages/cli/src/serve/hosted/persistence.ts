import { recordBackendOverBlob } from 'pyric/sandbox';
import { decodeImportBundle } from 'pyric/sandbox/internal';
import { createStateStore } from '../state-store.js';
import type { FirebaseStorage } from 'pyric/storage';
import { restoreStorageState, snapshotStorageState } from 'pyric/storage/internal';

/** The host writes controller records directly to the existing atomic state file. */
export function createHostedPersistence(projectDir: string) {
  const state = createStateStore(projectDir);
  const records = state.readSection('firestore');
  const hasNoRecords = records === null;
  const initialBlob = hasNoRecords ? null : JSON.stringify(records);
  const hasPersistedRecords = initialBlob !== null;
  if (hasPersistedRecords) decodeImportBundle(initialBlob);
  const backend = recordBackendOverBlob({
    read: async () => initialBlob,
    async write(blob) {
      const records: unknown = JSON.parse(blob);
      state.writeSection('firestore', records);
    },
    async clear() {
      state.writeSection('firestore', null);
    },
  });
  return {
    backend,
    async restoreStorage(storage: FirebaseStorage): Promise<void> {
      const records = state.load()?.storage ?? [];
      await restoreStorageState(storage, records);
    },
    async flushStorage(storage: FirebaseStorage): Promise<void> {
      const records = await snapshotStorageState(storage);
      state.writeSection('storage', records);
    },
  };
}
