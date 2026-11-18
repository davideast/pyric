import type { Database as AdminDatabase } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface AdminPriorityValidationCase {
  label: string;
  threwSynchronously: boolean;
  errorName: string | null;
  message: string | null;
}

function scrubAdminPrioMessage(rawMessage: string, cleanBase: string): string {
  let out = rawMessage;
  if (cleanBase) {
    const dotPrefix = `${cleanBase.split('/').join('.')}.`;
    out = out
      .split(dotPrefix)
      .join('')
      .split(`/${cleanBase}/`)
      .join('/')
      .split(cleanBase)
      .join('<runPath>');
  }
  return out
    .replace(/pyric_oracle\.rtdb_[a-z0-9_-]+\./gi, '')
    .replace(/\/pyric_oracle\/rtdb_[a-z0-9_-]+\//gi, '/');
}

function capturePriorityThrow(
  label: string,
  cleanBase: string,
  invoke: () => unknown,
): AdminPriorityValidationCase {
  try {
    const ret = invoke();
    if (
      ret !== null &&
      typeof ret === 'object' &&
      typeof (ret as { catch?: unknown }).catch === 'function'
    ) {
      (ret as Promise<unknown>).catch(() => undefined);
    }
    return {
      label,
      threwSynchronously: false,
      errorName: null,
      message: null,
    };
  } catch (err) {
    const errorObj = err as Error;
    return {
      label,
      threwSynchronously: true,
      errorName: errorObj.name,
      message: scrubAdminPrioMessage(errorObj.message, cleanBase),
    };
  }
}

export async function observeAdminPrioritiesAndInlinePriority(
  adminDb: Pick<AdminDatabase, 'ref'>,
  basePath: string,
): Promise<{
  setWithPriorityAndSetPriority: {
    initialVal: unknown;
    initialPriority: string | number | null;
    initialExportVal: unknown;
    afterSetPriorityNumber: string | number | null;
    afterSetPriorityString: string | number | null;
    afterClearPriorityNull: string | number | null;
    afterClearExportVal: unknown;
    priorityOnEmptyNodeRemainsNull: string | number | null;
    callbacksDeliveredNullError: {
      setWithPriority: boolean;
      setPriority: boolean;
    };
  };
  inlinePriorityInSetAndUpdate: {
    inlinePrimitiveVal: unknown;
    inlinePrimitivePriority: string | number | null;
    inlinePrimitiveExportVal: unknown;
    inlineObjectVal: unknown;
    inlineObjectPriority: string | number | null;
    inlineObjectExportVal: unknown;
    afterUpdateInlineChildOrderByPriorityKeys: string[];
    afterUpdateChildExportVal: unknown;
  };
  validationThrows: AdminPriorityValidationCase[];
}> {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let rootPrefix = 'adminPrio';
  if (cleanBase) {
    rootPrefix = `${cleanBase}/adminPrio`;
  }

  let swpCbNull = false;
  let spCbNull = false;
  const itemRef = adminDb.ref(`${rootPrefix}/item`);

  await new Promise<void>((resolve, reject) => {
    void itemRef
      .setWithPriority({ label: 'alpha' }, 25, (err) => {
        swpCbNull = err === null;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      })
      .catch(reject);
  });
  const initialSnap = await itemRef.get();

  await new Promise<void>((resolve, reject) => {
    void itemRef
      .setPriority(5, (err) => {
        spCbNull = err === null;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      })
      .catch(reject);
  });
  const afterNumPrioSnap = await itemRef.get();

  await itemRef.setPriority('rank-b', () => undefined);
  const afterStrPrioSnap = await itemRef.get();

  await itemRef.setPriority(null, () => undefined);
  const afterClearPrioSnap = await itemRef.get();

  const emptyRef = adminDb.ref(`${rootPrefix}/absentNode`);
  await emptyRef.setPriority(99, () => undefined);
  const emptyAfterPrioSnap = await emptyRef.get();

  const inlinePrimRef = adminDb.ref(`${rootPrefix}/inlinePrim`);
  await inlinePrimRef.set({ '.value': 'scalar-payload', '.priority': 12 });
  const inlinePrimSnap = await inlinePrimRef.get();

  const inlineObjRef = adminDb.ref(`${rootPrefix}/inlineObj`);
  await inlineObjRef.set({ title: 'doc', count: 2, '.priority': 'p-high' });
  const inlineObjSnap = await inlineObjRef.get();

  const orderedListRef = adminDb.ref(`${rootPrefix}/orderedList`);
  await orderedListRef.set({
    c: { '.value': 'third', '.priority': 30 },
    a: { '.value': 'first', '.priority': 10 },
  });
  await orderedListRef.update({
    b: { '.value': 'second', '.priority': 20 },
    a: { '.value': 'moved-last', '.priority': 40 },
  });
  const orderedSnap = await orderedListRef.orderByPriority().get();
  const orderedKeys: string[] = [];
  orderedSnap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      orderedKeys.push(childSnap.key);
    }
    return false;
  });
  const childBSnap = await orderedListRef.child('b').get();

  const validationRef = adminDb.ref(`${rootPrefix}/validationTarget`);
  const validationThrows: AdminPriorityValidationCase[] = [
    capturePriorityThrow('setPriority-undefined', cleanBase, () =>
      validationRef.setPriority(undefined as unknown as number, () => undefined),
    ),
    capturePriorityThrow('setPriority-nan', cleanBase, () =>
      validationRef.setPriority(NaN, () => undefined),
    ),
    capturePriorityThrow('setPriority-boolean', cleanBase, () =>
      validationRef.setPriority(true as unknown as number, () => undefined),
    ),
    capturePriorityThrow('setPriority-object', cleanBase, () =>
      validationRef.setPriority({ bad: 1 } as unknown as number, () => undefined),
    ),
    capturePriorityThrow('setWithPriority-nan-prio', cleanBase, () =>
      validationRef.setWithPriority('v', NaN),
    ),
    capturePriorityThrow('setWithPriority-undefined-val', cleanBase, () =>
      validationRef.setWithPriority(undefined, 10),
    ),
    capturePriorityThrow('inline-value-undefined', cleanBase, () =>
      validationRef.set({ '.value': undefined, '.priority': 10 }),
    ),
  ];

  return {
    setWithPriorityAndSetPriority: {
      initialVal: initialSnap.val(),
      initialPriority: initialSnap.getPriority(),
      initialExportVal: initialSnap.exportVal(),
      afterSetPriorityNumber: afterNumPrioSnap.getPriority(),
      afterSetPriorityString: afterStrPrioSnap.getPriority(),
      afterClearPriorityNull: afterClearPrioSnap.getPriority(),
      afterClearExportVal: afterClearPrioSnap.exportVal(),
      priorityOnEmptyNodeRemainsNull: emptyAfterPrioSnap.getPriority(),
      callbacksDeliveredNullError: {
        setWithPriority: swpCbNull,
        setPriority: spCbNull,
      },
    },
    inlinePriorityInSetAndUpdate: {
      inlinePrimitiveVal: inlinePrimSnap.val(),
      inlinePrimitivePriority: inlinePrimSnap.getPriority(),
      inlinePrimitiveExportVal: inlinePrimSnap.exportVal(),
      inlineObjectVal: inlineObjSnap.val(),
      inlineObjectPriority: inlineObjSnap.getPriority(),
      inlineObjectExportVal: inlineObjSnap.exportVal(),
      afterUpdateInlineChildOrderByPriorityKeys: orderedKeys,
      afterUpdateChildExportVal: childBSnap.exportVal(),
    },
    validationThrows,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'firebase-admin/database Reference.setPriority, Reference.setWithPriority, inline .priority/.value in set() and update(), DataSnapshot.getPriority()/exportVal(), orderByPriority() ordering, and synchronous invalid-priority throws.',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl }) => {
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
        `sdk-probe-rtdb-admin-prio-${runId}`,
      );
      const adminDb = getDatabaseWithUrl(databaseUrl, adminApp);
      try {
        return await observeAdminPrioritiesAndInlinePriority(adminDb, runPath);
      } finally {
        adminDb.goOffline();
        await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      }
    });
  },
};
