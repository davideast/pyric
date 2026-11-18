import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

export interface StorageListAllOrderSubject {
  uploadMarker(subpath: string): Promise<void>;
  listItemAndPrefixNames(subpath: string): Promise<{
    itemNames: string[];
    prefixNames: string[];
  }>;
}

export async function observeListAllLexicographicOrder(
  subject: StorageListAllOrderSubject,
): Promise<Record<string, unknown>> {
  const uploadItemOrder = ['z.bin', 'a.bin', '10.bin', '2.bin', 'B.bin'];
  const uploadPrefixOrder = ['p-z', 'p-a', 'p-10', 'p-2', 'p-B'];

  for (const itemName of uploadItemOrder) {
    await subject.uploadMarker(`listall-order/${itemName}`);
  }
  for (const prefixName of uploadPrefixOrder) {
    await subject.uploadMarker(`listall-order/${prefixName}/leaf.bin`);
  }

  const listed = await subject.listItemAndPrefixNames('listall-order');
  return {
    uploadedItemOrder: uploadItemOrder,
    uploadedPrefixOrder: uploadPrefixOrder,
    observedItemNames: listed.itemNames,
    observedPrefixNames: listed.prefixNames,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#72',
  rowIds: ['storage#72', 'storage#73'],
  description:
    'listAll(ref) deterministic ordering: uploads items and sub-folder prefixes in scrambled numeric and mixed-case order and observes exact lexicographic ordering of items and prefixes.',
  async observe() {
    return withStorageProbeSession(async ({ storage, objectPath, objectRef, storageSdk }) => {
      return observeListAllLexicographicOrder({
        async uploadMarker(subpath) {
          await storageSdk.uploadBytes(objectRef(subpath), new Uint8Array([0x01]));
        },
        async listItemAndPrefixNames(subpath) {
          const dirRef = storageSdk.ref(storage, objectPath(subpath));
          const result = await storageSdk.listAll(dirRef);
          return {
            itemNames: result.items.map((item) => item.name),
            prefixNames: result.prefixes.map((prefix) => prefix.name),
          };
        },
      });
    });
  },
};
