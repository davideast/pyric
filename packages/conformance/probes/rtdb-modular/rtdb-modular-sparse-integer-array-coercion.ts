import type { DataSnapshot as ClientDataSnapshot, Database as ClientDatabase } from 'firebase/database';
import type { DataSnapshot as AdminDataSnapshot, Database as AdminDatabase } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface SparseArrayCoercionClientSdk {
  db: ClientDatabase;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  setWithPriority: typeof import('firebase/database').setWithPriority;
  get: typeof import('firebase/database').get;
}

export interface SparseArraySnapshotInspection {
  exists: boolean;
  isArray: boolean;
  length: number | null;
  ownKeys: string[];
  hasHoleIndexInOperator: boolean;
  holeIndexIsUndefined: boolean;
  exportVal: unknown;
  toJSON: unknown;
  priority: string | number | null;
  childCount: number;
  hasChildren: boolean;
  hasPresentChild: boolean;
  hasMissingHoleChild: boolean;
  presentChildVal: unknown;
  missingHoleChildExists: boolean;
  forEachKeys: string[];
  earlyExitVisitedKeys: string[];
  earlyExitReturnedTrue: boolean;
}

function inspectClientSnapshot(
  snap: ClientDataSnapshot,
  presentKey: string,
  holeIndex: number,
  earlyStopKey: string,
): SparseArraySnapshotInspection {
  const val = snap.val();
  const holeKey = String(holeIndex);
  let length: number | null = null;
  let ownKeys: string[] = [];
  let hasHoleIndexInOperator = false;
  let holeIndexIsUndefined = false;
  if (Array.isArray(val)) {
    length = val.length;
    ownKeys = Object.keys(val);
    hasHoleIndexInOperator = holeIndex in val;
    holeIndexIsUndefined = val[holeIndex] === undefined;
  } else if (val !== null && typeof val === 'object') {
    ownKeys = Object.keys(val as Record<string, unknown>);
  }

  const forEachKeys: string[] = [];
  snap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      forEachKeys.push(childSnap.key);
    }
    return false;
  });

  const earlyExitVisitedKeys: string[] = [];
  const earlyExitReturnedTrue = snap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      earlyExitVisitedKeys.push(childSnap.key);
    }
    return childSnap.key === earlyStopKey;
  });

  return {
    exists: snap.exists(),
    isArray: Array.isArray(val),
    length,
    ownKeys,
    hasHoleIndexInOperator,
    holeIndexIsUndefined,
    exportVal: snap.exportVal(),
    toJSON: snap.toJSON(),
    priority: snap.priority,
    childCount: snap.size,
    hasChildren: snap.hasChildren(),
    hasPresentChild: snap.hasChild(presentKey),
    hasMissingHoleChild: snap.hasChild(holeKey),
    presentChildVal: snap.child(presentKey).val(),
    missingHoleChildExists: snap.child(holeKey).exists(),
    forEachKeys,
    earlyExitVisitedKeys,
    earlyExitReturnedTrue,
  };
}

function inspectAdminSnapshot(
  snap: AdminDataSnapshot,
  presentKey: string,
  holeIndex: number,
  earlyStopKey: string,
): SparseArraySnapshotInspection {
  const val = snap.val();
  const holeKey = String(holeIndex);
  let length: number | null = null;
  let ownKeys: string[] = [];
  let hasHoleIndexInOperator = false;
  let holeIndexIsUndefined = false;
  if (Array.isArray(val)) {
    length = val.length;
    ownKeys = Object.keys(val);
    hasHoleIndexInOperator = holeIndex in val;
    holeIndexIsUndefined = val[holeIndex] === undefined;
  } else if (val !== null && typeof val === 'object') {
    ownKeys = Object.keys(val as Record<string, unknown>);
  }

  const forEachKeys: string[] = [];
  snap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      forEachKeys.push(childSnap.key);
    }
    return false;
  });

  const earlyExitVisitedKeys: string[] = [];
  const earlyExitReturnedTrue = snap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      earlyExitVisitedKeys.push(childSnap.key);
    }
    return childSnap.key === earlyStopKey;
  });

  return {
    exists: snap.exists(),
    isArray: Array.isArray(val),
    length,
    ownKeys,
    hasHoleIndexInOperator,
    holeIndexIsUndefined,
    exportVal: snap.exportVal(),
    toJSON: snap.toJSON(),
    priority: snap.getPriority(),
    childCount: snap.numChildren(),
    hasChildren: snap.hasChildren(),
    hasPresentChild: snap.hasChild(presentKey),
    hasMissingHoleChild: snap.hasChild(holeKey),
    presentChildVal: snap.child(presentKey).val(),
    missingHoleChildExists: snap.child(holeKey).exists(),
    forEachKeys,
    earlyExitVisitedKeys,
    earlyExitReturnedTrue,
  };
}

export async function observeSparseIntegerArrayCoercion(
  clientSdk: SparseArrayCoercionClientSdk,
  adminDb: Pick<AdminDatabase, 'ref'>,
  basePath: string,
): Promise<{
  sparseUnderThreshold: {
    client: SparseArraySnapshotInspection;
    admin: SparseArraySnapshotInspection;
  };
  exactBoundaryCoerced: {
    client: SparseArraySnapshotInspection;
    admin: SparseArraySnapshotInspection;
  };
  exactBoundaryObject: {
    client: SparseArraySnapshotInspection;
    admin: SparseArraySnapshotInspection;
  };
  nonCanonicalKeys: {
    leadingZeroClientIsArray: boolean;
    leadingZeroAdminIsArray: boolean;
    negativeKeyClientIsArray: boolean;
    negativeKeyAdminIsArray: boolean;
  };
  arrayWithPriority: {
    clientVal: unknown;
    clientExportVal: unknown;
    clientPriority: string | number | null;
    adminVal: unknown;
    adminExportVal: unknown;
    adminPriority: string | number | null;
  };
}> {
  const { db, ref, set, setWithPriority, get } = clientSdk;
  const cleanBase = basePath.replace(/^\/+/, '');

  const sparsePath = `${cleanBase}/sparse`;
  await set(ref(db, sparsePath), { '0': 'a', '1': 'b', '3': 'd' });

  const boundaryArrayPath = `${cleanBase}/boundaryCoerced`;
  await set(ref(db, boundaryArrayPath), { '0': 'first', '3': 'fourth' });

  const boundaryObjectPath = `${cleanBase}/boundaryObject`;
  await set(ref(db, boundaryObjectPath), { '0': 'first', '4': 'fifth' });

  const leadingZeroPath = `${cleanBase}/leadingZero`;
  await set(ref(db, leadingZeroPath), { '0': 'zero', '01': 'lead' });

  const negativeKeyPath = `${cleanBase}/negativeKey`;
  await set(ref(db, negativeKeyPath), { '-1': 'neg', '0': 'zero' });

  const priorityPath = `${cleanBase}/withPriority`;
  await setWithPriority(ref(db, priorityPath), ['p0', 'p1'], 7);

  const [
    sparseClient,
    sparseAdmin,
    boundaryArrayClient,
    boundaryArrayAdmin,
    boundaryObjClient,
    boundaryObjAdmin,
    leadingZeroClient,
    leadingZeroAdmin,
    negativeKeyClient,
    negativeKeyAdmin,
    prioClient,
    prioAdmin,
  ] = await Promise.all([
    get(ref(db, sparsePath)),
    adminDb.ref(sparsePath).get(),
    get(ref(db, boundaryArrayPath)),
    adminDb.ref(boundaryArrayPath).get(),
    get(ref(db, boundaryObjectPath)),
    adminDb.ref(boundaryObjectPath).get(),
    get(ref(db, leadingZeroPath)),
    adminDb.ref(leadingZeroPath).get(),
    get(ref(db, negativeKeyPath)),
    adminDb.ref(negativeKeyPath).get(),
    get(ref(db, priorityPath)),
    adminDb.ref(priorityPath).get(),
  ]);

  return {
    sparseUnderThreshold: {
      client: inspectClientSnapshot(sparseClient, '1', 2, '1'),
      admin: inspectAdminSnapshot(sparseAdmin, '1', 2, '1'),
    },
    exactBoundaryCoerced: {
      client: inspectClientSnapshot(boundaryArrayClient, '3', 1, '0'),
      admin: inspectAdminSnapshot(boundaryArrayAdmin, '3', 1, '0'),
    },
    exactBoundaryObject: {
      client: inspectClientSnapshot(boundaryObjClient, '4', 1, '0'),
      admin: inspectAdminSnapshot(boundaryObjAdmin, '4', 1, '0'),
    },
    nonCanonicalKeys: {
      leadingZeroClientIsArray: Array.isArray(leadingZeroClient.val()),
      leadingZeroAdminIsArray: Array.isArray(leadingZeroAdmin.val()),
      negativeKeyClientIsArray: Array.isArray(negativeKeyClient.val()),
      negativeKeyAdminIsArray: Array.isArray(negativeKeyAdmin.val()),
    },
    arrayWithPriority: {
      clientVal: prioClient.val(),
      clientExportVal: prioClient.exportVal(),
      clientPriority: prioClient.priority,
      adminVal: prioAdmin.val(),
      adminExportVal: prioAdmin.exportVal(),
      adminPriority: prioAdmin.getPriority(),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular client and firebase-admin RTDB read-side integer-key array coercion: compares snap.val() sparse holes (maxKey < 2 * numKeys vs >= 2 * numKeys and non-canonical keys), exportVal(), toJSON(), priority, child/hasChild/numChildren/size, and early-exit forEach().',
  matrixRow: 'rtdb-modular#M66',
  rowIds: ['rtdb-modular#M66', 'rtdb-modular#AS1', 'rtdb-admin#4'],
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl, db, rtdbSdk }) => {
      const [adminAppMod, { getDatabaseWithUrl }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/database'),
      ]);
      const sa = await loadOracleServiceAccount();
      const adminApp = adminAppMod.initializeApp(
        {
          credential: {
            getAccessToken: async () => ({
              access_token: await oracleAccessToken(sa, RTDB_RULES_SCOPE),
              expires_in: 3600,
            }),
          },
          projectId: sa.project_id,
          databaseURL: databaseUrl,
        },
        `sdk-probe-rtdb-sparse-admin-${runId}`,
      );
      const adminDb = getDatabaseWithUrl(databaseUrl, adminApp);
      try {
        return await observeSparseIntegerArrayCoercion(
          {
            db,
            ref: rtdbSdk.ref,
            set: rtdbSdk.set,
            setWithPriority: rtdbSdk.setWithPriority,
            get: rtdbSdk.get,
          },
          adminDb,
          `${runPath}/sparse-coercion`,
        );
      } finally {
        adminDb.goOffline();
        await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      }
    });
  },
};
