import { ref, type StorageReference } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import {
  snapshotStorageReference,
  withIsolatedClientStorage,
} from '../../src/client-storage-ref-session.ts';

function walkParentChain(start: StorageReference): Array<{ fullPath: string; name: string }> {
  const steps: Array<{ fullPath: string; name: string }> = [];
  let cursor: StorageReference | null = start;
  while (cursor !== null) {
    steps.push({ fullPath: cursor.fullPath, name: cursor.name });
    cursor = cursor.parent;
  }
  return steps;
}

export const probe: Probe = {
  rig: 'client-storage',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/storage ref(parent, child), parent chain traversal, and root accessor across depths: observes relative path joining, step-by-step parent stripping down to null at root, and root returning the bucket root from every depth.',
  async observe() {
    return withIsolatedClientStorage('buckets-default', 'hierarchy', (storage) => {
      const rootRef = ref(storage);
      const folderRef = ref(storage, 'users/u1');
      const childFromRoot = ref(rootRef, 'items/doc.txt');
      const childFromFolder = ref(folderRef, 'avatars/profile.png');
      const slashyChildJoin = ref(ref(storage, '/users//u1/'), '//avatars//banner.png/');
      const emptyChildJoin = ref(folderRef, '');
      const slashOnlyChildJoin = ref(folderRef, '///');

      const depth3 = ref(storage, 'alpha/beta/gamma');
      const depth1 = ref(storage, 'alpha');

      return {
        childFromRoot: snapshotStorageReference(childFromRoot),
        childFromFolder: snapshotStorageReference(childFromFolder),
        slashyChildJoin: snapshotStorageReference(slashyChildJoin),
        emptyChildJoin: snapshotStorageReference(emptyChildJoin),
        slashOnlyChildJoin: snapshotStorageReference(slashOnlyChildJoin),
        parentChainFromDepth3: walkParentChain(depth3),
        terminalParentIsNull: rootRef.parent === null,
        rootAtDepth0: snapshotStorageReference(rootRef.root),
        rootAtDepth1: snapshotStorageReference(depth1.root),
        rootAtDepth3: snapshotStorageReference(depth3.root),
      };
    });
  },
};
