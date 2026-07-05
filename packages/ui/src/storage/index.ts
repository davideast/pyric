export * from './hooks/index.js';

// Injectable Storage API bundle (Pyric Studio data-backend swap): defaults to
// in-process `pyric/storage`; a consumer can provide the SharedWorker client.
export { StorageApiProvider, useStorageApi, type StorageApi } from './storageApi.js';

// M2: navigation shell
export {
  PathBreadcrumb,
  type PathBreadcrumbProps,
} from './components/PathBreadcrumb.js';
export {
  ObjectBrowser,
  type ObjectBrowserProps,
} from './components/ObjectBrowser.js';

// M3: upload
export {
  UploadDropzone,
  type UploadDropzoneProps,
  type DroppedFile,
} from './components/UploadDropzone.js';

// M4: inspection, content-type preview registry + inspector
export {
  defaultStoragePreviews,
  imagePreview,
  textPreview,
  selectStoragePreview,
  TEXT_PREVIEW_MAX_BYTES,
  type StoragePreview,
  type StoragePreviewContext,
} from './previews.js';
export {
  ObjectInspector,
  type ObjectInspectorProps,
} from './components/ObjectInspector.js';

// M6: bulk ops
export {
  DeleteSelectionWithConfirm,
  type DeleteSelectionWithConfirmProps,
} from './components/DeleteSelectionWithConfirm.js';
