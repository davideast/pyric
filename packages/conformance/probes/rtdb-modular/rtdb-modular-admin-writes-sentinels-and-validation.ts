import type { Database as AdminDatabase } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface AdminServerValueApi {
  readonly TIMESTAMP: object;
  increment(delta: number): object;
}

export interface AdminWriteValidationCase {
  label: string;
  threwSynchronously: boolean;
  errorName: string | null;
  message: string | null;
}

function scrubRunPrefix(rawMessage: string, cleanBase: string): string {
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

function captureAdminValidationThrow(
  label: string,
  cleanBase: string,
  invoke: () => unknown,
): AdminWriteValidationCase {
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
      message: scrubRunPrefix(errorObj.message, cleanBase),
    };
  }
}

export async function observeAdminWritesSentinelsAndValidation(
  adminDb: Pick<AdminDatabase, 'ref'>,
  serverValue: AdminServerValueApi,
  basePath: string,
): Promise<{
  setUpdateRemove: {
    afterMultiPathUpdate: unknown;
    afterRemoveExists: boolean;
  };
  arrayUpdateBehavior: {
    threwSynchronously: boolean;
    storedAfterArrayUpdate: unknown;
  };
  pushAndCallbacks: {
    pushKeyCount: number;
    allKeysLength20: boolean;
    keysStrictlyIncreasing: boolean;
    syncKeyAvailableBeforeAwait: boolean;
    pushedValuesInOrder: unknown[];
    callbacksDeliveredNullError: {
      set: boolean;
      update: boolean;
      remove: boolean;
      push: boolean;
    };
  };
  sentinels: {
    timestampIsFiniteInteger: boolean;
    timestampWithinPlausibleWindow: boolean;
    incrementFromMissing: unknown;
    incrementPositiveThenNegative: unknown;
    incrementFloatFromNumber: unknown;
  };
  validationCases: AdminWriteValidationCase[];
  baselineUnchangedAfterRefusedWrites: unknown;
}> {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let rootPrefix = 'adminWrites';
  if (cleanBase) {
    rootPrefix = `${cleanBase}/adminWrites`;
  }

  const docRef = adminDb.ref(`${rootPrefix}/doc`);
  await docRef.set({
    profile: { name: 'Ada', stale: 'drop' },
    keep: true,
  });
  await docRef.update({
    'profile/role': 'engineer',
    'profile/stale': null,
    count: 1,
  });
  const afterUpdateSnap = await docRef.get();
  await docRef.remove();
  const afterRemoveSnap = await docRef.get();

  const arrayUpdateRef = adminDb.ref(`${rootPrefix}/arrayUpdate`);
  await arrayUpdateRef.set({
    '0': 'old0',
    '1': 'old1',
    '2': 'keep2',
    extra: 'preserved',
  });
  let arrayUpdateThrewSync = false;
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const joined = args.map(String).join(' ');
    if (!joined.includes('Passing an Array to Firebase.update()')) {
      originalWarn(...args);
    }
  };
  try {
    await arrayUpdateRef.update(['new0', 'new1'] as unknown as Record<string, unknown>);
  } catch {
    arrayUpdateThrewSync = true;
  } finally {
    console.warn = originalWarn;
  }
  const afterArrayUpdateSnap = await arrayUpdateRef.get();

  const cbResults = {
    set: false,
    update: false,
    remove: false,
    push: false,
  };
  const cbRef = adminDb.ref(`${rootPrefix}/callbacks`);
  await cbRef.set({ a: 1 }, (err) => {
    cbResults.set = err === null;
  });
  await cbRef.update({ b: 2 }, (err) => {
    cbResults.update = err === null;
  });

  const pushListRef = adminDb.ref(`${rootPrefix}/pushed`);
  const ref1 = pushListRef.push();
  const syncKey1 = ref1.key;
  await ref1.set('first');

  let resolvePushCb: (() => void) | undefined;
  let rejectPushCb: ((err: unknown) => void) | undefined;
  const pushCbSettled = new Promise<void>((resolve, reject) => {
    resolvePushCb = resolve;
    rejectPushCb = reject;
  });
  const ref2 = pushListRef.push('second', (err) => {
    if (err !== null && err !== undefined) {
      if (rejectPushCb !== undefined) {
        rejectPushCb(err);
      }
      return;
    }
    cbResults.push = true;
    if (resolvePushCb !== undefined) {
      resolvePushCb();
    }
  });
  await Promise.all([ref2, pushCbSettled]);
  const ref3 = pushListRef.push('third');
  await ref3;

  await cbRef.remove((err) => {
    cbResults.remove = err === null;
  });

  const pushedKeys = [syncKey1, ref2.key, ref3.key].filter(
    (k): k is string => typeof k === 'string',
  );
  const allKeysLength20 = pushedKeys.length === 3 && pushedKeys.every((k) => k.length === 20);
  const keysStrictlyIncreasing =
    pushedKeys.length === 3 && pushedKeys[0] < pushedKeys[1] && pushedKeys[1] < pushedKeys[2];

  const pushedListSnap = await pushListRef.get();
  const pushedValuesInOrder: unknown[] = [];
  pushedListSnap.forEach((childSnap) => {
    pushedValuesInOrder.push(childSnap.val());
    return false;
  });

  const sentinelRef = adminDb.ref(`${rootPrefix}/sentinels`);
  const beforeMs = Date.now();
  await sentinelRef.set({
    createdAt: serverValue.TIMESTAMP,
    fromMissing: serverValue.increment(5),
    counter: 10,
    decimal: 1.5,
  });
  const afterMs = Date.now();
  await sentinelRef.update({
    counter: serverValue.increment(-3),
    decimal: serverValue.increment(2.25),
  });
  const sentinelSnap = await sentinelRef.get();
  const sentinelVal = sentinelSnap.val() as {
    createdAt?: unknown;
    fromMissing?: unknown;
    counter?: unknown;
    decimal?: unknown;
  };
  const tsVal = sentinelVal.createdAt;
  const timestampIsFiniteInteger = typeof tsVal === 'number' && Number.isInteger(tsVal);
  let timestampWithinPlausibleWindow = false;
  if (typeof tsVal === 'number') {
    timestampWithinPlausibleWindow = tsVal >= beforeMs - 60_000 && tsVal <= afterMs + 60_000;
  }

  const valNodeRef = adminDb.ref(`${rootPrefix}/validationNode`);
  await valNodeRef.set({ intact: true });
  const invalidFn = () => 1;
  const validationCases: AdminWriteValidationCase[] = [
    captureAdminValidationThrow('set-undefined', cleanBase, () => valNodeRef.set(undefined)),
    captureAdminValidationThrow('set-nan-child', cleanBase, () => valNodeRef.set({ n: NaN })),
    captureAdminValidationThrow('set-infinity', cleanBase, () => valNodeRef.set({ n: Infinity })),
    captureAdminValidationThrow('set-function', cleanBase, () => valNodeRef.set(invalidFn)),
    captureAdminValidationThrow('set-invalid-dot-key', cleanBase, () =>
      valNodeRef.set({ 'bad.key': 1 }),
    ),
    captureAdminValidationThrow('update-null', cleanBase, () =>
      valNodeRef.update(null as unknown as Record<string, unknown>),
    ),
    captureAdminValidationThrow('update-primitive', cleanBase, () =>
      valNodeRef.update(42 as unknown as Record<string, unknown>),
    ),
    captureAdminValidationThrow('update-invalid-key', cleanBase, () =>
      valNodeRef.update({ 'bad#key': 1 }),
    ),
    captureAdminValidationThrow('push-nan', cleanBase, () => valNodeRef.push(NaN)),
  ];
  const valFinalSnap = await valNodeRef.get();

  return {
    setUpdateRemove: {
      afterMultiPathUpdate: afterUpdateSnap.val(),
      afterRemoveExists: afterRemoveSnap.exists(),
    },
    arrayUpdateBehavior: {
      threwSynchronously: arrayUpdateThrewSync,
      storedAfterArrayUpdate: afterArrayUpdateSnap.exportVal(),
    },
    pushAndCallbacks: {
      pushKeyCount: pushedKeys.length,
      allKeysLength20,
      keysStrictlyIncreasing,
      syncKeyAvailableBeforeAwait: typeof syncKey1 === 'string' && syncKey1.length === 20,
      pushedValuesInOrder,
      callbacksDeliveredNullError: cbResults,
    },
    sentinels: {
      timestampIsFiniteInteger,
      timestampWithinPlausibleWindow,
      incrementFromMissing: sentinelVal.fromMissing,
      incrementPositiveThenNegative: sentinelVal.counter,
      incrementFloatFromNumber: sentinelVal.decimal,
    },
    validationCases,
    baselineUnchangedAfterRefusedWrites: valFinalSnap.val(),
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'firebase-admin/database writes, ServerValue sentinels, and synchronous validation: observes set, multi-path atomic update, array update merging, remove, ordered 20-char push keys, onComplete callbacks, ServerValue.TIMESTAMP and ServerValue.increment(delta), and synchronous payload/key validation throws.',
  matrixRow: 'rtdb-admin#3',
  rowIds: ['rtdb-admin#3'],
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl }) => {
      const [adminAppMod, { getDatabaseWithUrl, ServerValue }] = await Promise.all([
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
        `sdk-probe-rtdb-admin-writes-${runId}`,
      );
      const adminDb = getDatabaseWithUrl(databaseUrl, adminApp);
      try {
        return await observeAdminWritesSentinelsAndValidation(adminDb, ServerValue, runPath);
      } finally {
        adminDb.goOffline();
        await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      }
    });
  },
};
