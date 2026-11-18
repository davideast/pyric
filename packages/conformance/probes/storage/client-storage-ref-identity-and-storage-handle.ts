import { ref } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import { withIsolatedClientStorage } from '../../src/client-storage-ref-session.ts';

export const probe: Probe = {
  rig: 'client-storage',
  matrixRow: 'storage#22',
  rowIds: ['storage#22', 'storage#23'],
  description:
    'firebase/storage StorageReference value-object identity and owning handle preservation: observes non-interned reference instances across ref(), parent, and root alongside preserved storage and bucket properties.',
  async observe() {
    return withIsolatedClientStorage('buckets-default', 'identity', (storage) => {
      const firstSamePath = ref(storage, 'a/b');
      const secondSamePath = ref(storage, 'a/b');
      const rootFirst = ref(storage);
      const rootSecond = ref(storage);

      const firstParent = firstSamePath.parent;
      const secondParent = firstSamePath.parent;
      if (firstParent === null || secondParent === null) {
        throw new Error('expected non-null parent for nested path a/b');
      }

      const firstRoot = firstSamePath.root;
      const secondRoot = firstSamePath.root;
      const childFromParent = ref(firstParent, 'b');

      return {
        samePathStrictEqual: firstSamePath === secondSamePath,
        samePathFullPathEqual: firstSamePath.fullPath === secondSamePath.fullPath,
        samePathToStringEqual: firstSamePath.toString() === secondSamePath.toString(),
        rootCallsStrictEqual: rootFirst === rootSecond,
        rootGetterOnRootStrictEqualSelf: rootFirst.root === rootFirst,
        repeatedParentGetterStrictEqual: firstParent === secondParent,
        repeatedParentToStringEqual: firstParent.toString() === secondParent.toString(),
        repeatedRootGetterStrictEqual: firstRoot === secondRoot,
        repeatedRootToStringEqual: firstRoot.toString() === secondRoot.toString(),
        childJoinToStringMatchesDirect: childFromParent.toString() === firstSamePath.toString(),
        childJoinStrictEqualDirect: childFromParent === firstSamePath,
        directPreservesStorageHandle: firstSamePath.storage === storage,
        parentPreservesStorageHandle: firstParent.storage === storage,
        rootPreservesStorageHandle: firstRoot.storage === storage,
        childJoinPreservesStorageHandle: childFromParent.storage === storage,
        bucketPreservedAcrossChain:
          firstSamePath.bucket === 'buckets-default' &&
          firstParent.bucket === 'buckets-default' &&
          firstRoot.bucket === 'buckets-default' &&
          childFromParent.bucket === 'buckets-default',
      };
    });
  },
};
