/**
 * The storage sidecar codec now lives with the headless server, which reads and
 * writes the file as part of its own session lifecycle. The eval seeds and
 * scores through the same codec, so it imports it from there.
 */
export {
  STORAGE_SIDECAR_RELATIVE,
  listStoredPaths,
  exportStorage,
  saveStorageSidecar,
  loadStorageSidecar,
  type StorageObjectRecord,
} from '../src/bridge/server/storage-sidecar.js';
