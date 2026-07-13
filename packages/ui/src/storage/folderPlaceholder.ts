import { ref as refFn, type FirebaseStorage, type StorageReference } from 'pyric/storage';

/**
 * Internal — build a reference to the trailing-slash folder
 * placeholder (`<path>/`, the GCS create-folder convention).
 *
 * `StorageReference` is a documented structural value object (two
 * refs with the same `(storage, fullPath)` are equal), so a plain
 * object is a legal reference — the only way to express a `<path>/`
 * name past `ref()`'s slash normalization. This helper is specific to
 * the Pyric sandbox mirror.
 */
export function folderPlaceholderRef(
  storage: FirebaseStorage,
  folderPath: string,
): StorageReference {
  const folder = refFn(storage, folderPath);
  return {
    storage,
    bucket: folder.bucket,
    fullPath: `${folder.fullPath}/`,
    name: '',
    parent: folder,
    root: folder.root,
    toString: () => `${folder.toString()}/`,
  };
}

/** Preserve whichever backend identity a reference carries (in-process
 *  storage handle or worker MessagePort) while targeting its trailing-slash
 *  GCS folder placeholder. */
export function asFolderPlaceholder<T extends { fullPath: string; name: string }>(
  folder: T,
): T {
  return {
    ...folder,
    fullPath: `${folder.fullPath}/`,
    name: '',
  };
}
