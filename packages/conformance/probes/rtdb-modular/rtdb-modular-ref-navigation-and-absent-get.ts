import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface RefNavigationAndAbsentGetSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
}

function scrubRefString(rawText: string, rootUrl: string, cleanBase: string): string {
  const origin = rootUrl.replace(/\/+$/, '');
  let out = rawText.split(origin).join('<rootOrigin>');
  if (cleanBase) {
    out = out.split(`/${cleanBase}`).join('/<runPath>');
    out = out.split(cleanBase).join('<runPath>');
  }
  return out;
}

export async function observeRefNavigationAndAbsentGet(
  sdk: RefNavigationAndAbsentGetSdk,
  basePath: string,
): Promise<{
  rootAndPathRefs: {
    defaultRootKey: string | null;
    defaultRootParentIsNull: boolean;
    emptyStringPathThrewSync: boolean;
    emptyStringPathMessage: string | null;
    pathRefKey: string | null;
    composedChildKey: string | null;
    composedParentKey: string | null;
    composedRootKey: string | null;
    composedRootParentIsNull: boolean;
    composedRootMatchesDefaultRoot: boolean;
    composedMatchesDirectPathRef: boolean;
    scrubbedComposedToString: string;
  };
  populatedGetSnapshotShape: {
    exists: boolean;
    key: string | null;
    val: unknown;
    toJSON: unknown;
    size: number;
    hasChildren: boolean;
    directChildVal: unknown;
    missingChildVal: unknown;
    hasNumChildrenProperty: boolean;
  };
  absentGetSnapshotShape: {
    exists: boolean;
    key: string | null;
    val: unknown;
    toJSON: unknown;
    size: number;
    hasChildren: boolean;
  };
}> {
  const { db, ref, child, set, get } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'refNav';
  if (cleanBase) {
    scope = `${cleanBase}/refNav`;
  }

  const defaultRoot = ref(db);
  const rootString = defaultRoot.toString();
  let emptyStringPathThrewSync = false;
  let emptyStringPathMessage: string | null = null;
  try {
    ref(db, '');
  } catch (err) {
    emptyStringPathThrewSync = true;
    emptyStringPathMessage = (err as Error).message;
  }
  const baseScopeRef = ref(db, scope);
  const directLeafRef = ref(db, `${scope}/orders/ord-1`);
  const composedLeafRef = child(baseScopeRef, 'orders/ord-1');

  let composedParentKey: string | null = null;
  if (composedLeafRef.parent !== null) {
    composedParentKey = composedLeafRef.parent.key;
  }

  await set(composedLeafRef, { item: 'widget', qty: 2 });
  const populatedSnap = await get(directLeafRef);

  const absentRef = child(baseScopeRef, 'orders/missing-ord');
  const absentSnap = await get(absentRef);

  const hasNumChildrenProperty =
    typeof (populatedSnap as unknown as { numChildren?: unknown }).numChildren === 'function';

  return {
    rootAndPathRefs: {
      defaultRootKey: defaultRoot.key,
      defaultRootParentIsNull: defaultRoot.parent === null,
      emptyStringPathThrewSync,
      emptyStringPathMessage,
      pathRefKey: directLeafRef.key,
      composedChildKey: composedLeafRef.key,
      composedParentKey,
      composedRootKey: composedLeafRef.root.key,
      composedRootParentIsNull: composedLeafRef.root.parent === null,
      composedRootMatchesDefaultRoot: composedLeafRef.root.toString() === rootString,
      composedMatchesDirectPathRef: composedLeafRef.toString() === directLeafRef.toString(),
      scrubbedComposedToString: scrubRefString(composedLeafRef.toString(), rootString, cleanBase),
    },
    populatedGetSnapshotShape: {
      exists: populatedSnap.exists(),
      key: populatedSnap.key,
      val: populatedSnap.val(),
      toJSON: populatedSnap.toJSON(),
      size: populatedSnap.size,
      hasChildren: populatedSnap.hasChildren(),
      directChildVal: populatedSnap.child('item').val(),
      missingChildVal: populatedSnap.child('nonexistent').val(),
      hasNumChildrenProperty,
    },
    absentGetSnapshotShape: {
      exists: absentSnap.exists(),
      key: absentSnap.key,
      val: absentSnap.val(),
      toJSON: absentSnap.toJSON(),
      size: absentSnap.size,
      hasChildren: absentSnap.hasChildren(),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'Modular RTDB ref(db, path?), child(ref, subpath), parent, root, DataSnapshot shape (val, exists, key, child, hasChildren, size, toJSON, absence of numChildren), and get() on an absent path.',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeRefNavigationAndAbsentGet(
        {
          db,
          ref: rtdbSdk.ref,
          child: rtdbSdk.child,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
        },
        runPath,
      );
    });
  },
};
