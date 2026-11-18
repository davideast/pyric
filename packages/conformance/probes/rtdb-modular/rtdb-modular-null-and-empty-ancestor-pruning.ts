import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface AncestorPruningProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  get: typeof import('firebase/database').get;
}

export async function observeNullAndEmptyAncestorPruning(
  sdk: AncestorPruningProbeSdk,
  basePath: string,
): Promise<{
  setEmptyObjectRemovesSubtree: {
    beforeExists: boolean;
    afterLeafExists: boolean;
    afterLeafVal: unknown;
    afterParentExists: boolean;
  };
  nestedNullAndEmptyObjectWrite: {
    exists: boolean;
    val: unknown;
    forEachKeys: string[];
    hasNullChildB: boolean;
    hasEmptyNestedChildC: boolean;
    hasAllNullArrayChildF: boolean;
  };
  deepLeafNullCollapsesAncestors: {
    beforeBranchExists: boolean;
    afterLeafExists: boolean;
    afterTwigExists: boolean;
    afterBranchExists: boolean;
    afterTreeExists: boolean;
  };
  multiPathUpdateNullPruning: {
    val: unknown;
    hasCollapsedLeftChild: boolean;
    hasRemainingRightChild: boolean;
  };
}> {
  const { db, ref, set, update, get } = sdk;

  const emptyObjParentRef = ref(db, `${basePath}/emptyObj/parent`);
  const emptyObjLeafRef = ref(db, `${basePath}/emptyObj/parent/leaf`);
  await set(emptyObjLeafRef, { keep: 1, nested: { x: 2 } });
  const beforeEmptySnap = await get(emptyObjLeafRef);
  await set(emptyObjLeafRef, {});
  const afterLeafSnap = await get(emptyObjLeafRef);
  const afterParentSnap = await get(emptyObjParentRef);

  const docRef = ref(db, `${basePath}/nestedPruning`);
  await set(docRef, {
    a: 1,
    b: null,
    c: { d: null, e: {} },
    f: [null, null],
  });
  const docSnap = await get(docRef);
  const docForEachKeys: string[] = [];
  docSnap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      docForEachKeys.push(childSnap.key);
    }
    return false;
  });

  const treeRef = ref(db, `${basePath}/deepCollapse`);
  const branchRef = ref(db, `${basePath}/deepCollapse/branch`);
  const twigRef = ref(db, `${basePath}/deepCollapse/branch/twig`);
  const leafRef = ref(db, `${basePath}/deepCollapse/branch/twig/leaf`);
  await set(treeRef, { branch: { twig: { leaf: 'green' } } });
  const beforeBranchSnap = await get(branchRef);
  await set(leafRef, null);
  const [collapseLeaf, collapseTwig, collapseBranch, collapseTree] = await Promise.all([
    get(leafRef),
    get(twigRef),
    get(branchRef),
    get(treeRef),
  ]);

  const multiRef = ref(db, `${basePath}/multiPath`);
  await set(multiRef, {
    left: { only: 1 },
    right: { a: 1, b: 2 },
  });
  await update(multiRef, {
    'left/only': null,
    'right/a': null,
  });
  const multiSnap = await get(multiRef);

  return {
    setEmptyObjectRemovesSubtree: {
      beforeExists: beforeEmptySnap.exists(),
      afterLeafExists: afterLeafSnap.exists(),
      afterLeafVal: afterLeafSnap.val(),
      afterParentExists: afterParentSnap.exists(),
    },
    nestedNullAndEmptyObjectWrite: {
      exists: docSnap.exists(),
      val: docSnap.val(),
      forEachKeys: docForEachKeys,
      hasNullChildB: docSnap.hasChild('b'),
      hasEmptyNestedChildC: docSnap.hasChild('c'),
      hasAllNullArrayChildF: docSnap.hasChild('f'),
    },
    deepLeafNullCollapsesAncestors: {
      beforeBranchExists: beforeBranchSnap.exists(),
      afterLeafExists: collapseLeaf.exists(),
      afterTwigExists: collapseTwig.exists(),
      afterBranchExists: collapseBranch.exists(),
      afterTreeExists: collapseTree.exists(),
    },
    multiPathUpdateNullPruning: {
      val: multiSnap.val(),
      hasCollapsedLeftChild: multiSnap.hasChild('left'),
      hasRemainingRightChild: multiSnap.hasChild('right'),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular RTDB write-boundary null and empty-object ancestor pruning: set(ref, {}) deletes existing subtrees and collapses empty parents, nested null/empty children are dropped on set(), and setting the sole deep leaf to null or nulling via multi-path update collapses empty ancestors.',
  matrixRow: 'rtdb-modular#M67',
  rowIds: ['rtdb-modular#M67'],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeNullAndEmptyAncestorPruning(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          update: rtdbSdk.update,
          get: rtdbSdk.get,
        },
        `${runPath}/ancestor-pruning`,
      );
    });
  },
};
