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
    'firebase/storage ref(storage, path) slash normalization: observes stripping leading slashes, stripping trailing slashes, collapsing repeated internal slashes, and normalizing all-slash inputs to root.',
  async observe() {
    return withIsolatedClientStorage('buckets-default', 'slash-norm', (storage) => {
      return {
        singleLeadingSlash: snapshotStorageReference(ref(storage, '/sessions/s1')),
        multipleLeadingSlashes: snapshotStorageReference(ref(storage, '///sessions/s1')),
        singleTrailingSlash: snapshotStorageReference(ref(storage, 'sessions/s1/')),
        multipleTrailingSlashes: snapshotStorageReference(ref(storage, 'sessions/s1///')),
        repeatedInternalSlashes: snapshotStorageReference(ref(storage, 'a//b')),
        manyInternalSlashes: snapshotStorageReference(ref(storage, 'a////b///c')),
        combinedSlashes: snapshotStorageReference(ref(storage, '///a//b/c///')),
        onlySlashes: snapshotStorageReference(ref(storage, '////')),
      };
    });
  },
};
