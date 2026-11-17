import { ref } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import {
  snapshotStorageReference,
  withIsolatedClientStorage,
} from '../../src/client-storage-ref-session.ts';

export const probe: Probe = {
  rig: 'client-storage',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/storage ref(storage) and ref(storage, path) root and segment properties: observes fullPath, name, parent, root value-object semantics, and gs://<bucket>/<fullPath> string formatting.',
  async observe() {
    return withIsolatedClientStorage('buckets-default', 'root-segments', (storage) => {
      const bareRoot = ref(storage);
      const emptyRoot = ref(storage, '');
      const singleSegment = ref(storage, 'readme.txt');
      const nestedSegments = ref(storage, 'sessions/s1.json');
      const deepSegments = ref(storage, 'orgs/acme/projects/p1/report.csv');

      return {
        bareRoot: {
          ...snapshotStorageReference(bareRoot),
          rootStrictEqualSelf: bareRoot.root === bareRoot,
          rootToStringMatchesSelf: bareRoot.root.toString() === bareRoot.toString(),
        },
        emptyStringRoot: snapshotStorageReference(emptyRoot),
        singleSegment: snapshotStorageReference(singleSegment),
        nestedSegments: snapshotStorageReference(nestedSegments),
        deepSegments: snapshotStorageReference(deepSegments),
      };
    });
  },
};
