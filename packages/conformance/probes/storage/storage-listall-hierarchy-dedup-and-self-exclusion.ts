import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

export interface StorageListAllHierarchySubject {
  uploadMarker(subpath: string): Promise<void>;
  readObjectSize(subpath: string): Promise<number>;
  listNames(subpath: string): Promise<{
    scannedFullPath: string;
    itemFullPaths: string[];
    itemNames: string[];
    prefixNames: string[];
  }>;
}

export async function observeListAllHierarchyDedupAndSelfExclusion(
  subject: StorageListAllHierarchySubject,
): Promise<Record<string, unknown>> {
  // Upload an object at the exact scanned prefix path itself (`scan-tree`),
  // two direct children, three siblings under one subfolder, and a grandchild.
  await subject.uploadMarker('scan-tree');
  await subject.uploadMarker('scan-tree/direct-two.bin');
  await subject.uploadMarker('scan-tree/direct-one.bin');
  await subject.uploadMarker('scan-tree/shared-folder/part-a.bin');
  await subject.uploadMarker('scan-tree/shared-folder/part-b.bin');
  await subject.uploadMarker('scan-tree/shared-folder/part-c.bin');
  await subject.uploadMarker('scan-tree/deep-folder/nested/grandchild.bin');

  const exactPrefixObjectSize = await subject.readObjectSize('scan-tree');
  const listed = await subject.listNames('scan-tree');

  const scannedRefIncludedInItems = listed.itemFullPaths.includes(listed.scannedFullPath);
  const grandchildrenIncludedInItems = listed.itemFullPaths.some((fullPath) => {
    const relative = fullPath.slice(listed.scannedFullPath.length + 1);
    return relative.includes('/');
  });

  return {
    exactPrefixObjectExists: exactPrefixObjectSize > 0,
    scannedRefIncludedInItems,
    grandchildrenIncludedInItems,
    itemNames: listed.itemNames,
    prefixNames: listed.prefixNames,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'listAll(ref) hierarchy, deduplication, and self-exclusion: excludes an object stored at the exact scanned prefix path, excludes grandchildren from items, and deduplicates multiple files under one subfolder into a single prefix entry.',
  async observe() {
    return withStorageProbeSession(async ({ storage, objectPath, objectRef, storageSdk }) => {
      return observeListAllHierarchyDedupAndSelfExclusion({
        async uploadMarker(subpath) {
          await storageSdk.uploadBytes(objectRef(subpath), new Uint8Array([0x41, 0x42, 0x43]));
        },
        async readObjectSize(subpath) {
          const md = await storageSdk.getMetadata(objectRef(subpath));
          return md.size;
        },
        async listNames(subpath) {
          const scannedFullPath = objectPath(subpath);
          const scannedRef = storageSdk.ref(storage, scannedFullPath);
          const result = await storageSdk.listAll(scannedRef);
          return {
            scannedFullPath,
            itemFullPaths: result.items.map((item) => item.fullPath),
            itemNames: result.items.map((item) => item.name),
            prefixNames: result.prefixes.map((prefix) => prefix.name),
          };
        },
      });
    });
  },
};
