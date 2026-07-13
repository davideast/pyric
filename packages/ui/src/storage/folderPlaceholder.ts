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
    // GCS semantics: the segment after the final slash — empty for a
    // placeholder.
    name: '',
    parent: folder,
    root: folder.root,
    toString: () => `${folder.toString()}/`,
  };
}
