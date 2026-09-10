/**
 * The bucket walk and the sidecar file the harness seeds and scores through.
 *
 * Reading a bucket out and writing one back is `bridge/surface/storage-state`,
 * a leaf the whole surface shares. Where that state is stored between in-process
 * sessions is `bridge/server/storage-sidecar`. The harness uses both, and
 * imports each from where it lives.
 */
export {
  listStoredPaths,
  exportStorage,
  type StorageObjectRecord,
} from '../src/bridge/surface/storage-state.js';

export {
  STORAGE_SIDECAR_RELATIVE,
  saveStorageSidecar,
  loadStorageSidecar,
} from '../src/bridge/server/storage-sidecar.js';
