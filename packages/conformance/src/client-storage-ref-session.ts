import { deleteApp, initializeApp } from 'firebase/app';
import { getStorage, type FirebaseStorage, type StorageReference } from 'firebase/storage';

let sessionCounter = 0;

export async function withIsolatedClientStorage<T>(
  storageBucket: string,
  label: string,
  run: (storage: FirebaseStorage) => T | Promise<T>,
): Promise<T> {
  sessionCounter += 1;
  const app = initializeApp(
    { projectId: 'demo-storage-ref', storageBucket },
    `client-storage-ref-${label}-${Date.now()}-${sessionCounter}`,
  );
  try {
    const storage = getStorage(app);
    return await run(storage);
  } finally {
    await deleteApp(app);
  }
}

export function snapshotStorageReference(reference: StorageReference): Record<string, unknown> {
  let parentFullPath: string | null = null;
  if (reference.parent !== null) {
    parentFullPath = reference.parent.fullPath;
  }
  return {
    bucket: reference.bucket,
    fullPath: reference.fullPath,
    name: reference.name,
    hasParent: reference.parent !== null,
    parentFullPath,
    rootFullPath: reference.root.fullPath,
    toStringValue: reference.toString(),
  };
}
