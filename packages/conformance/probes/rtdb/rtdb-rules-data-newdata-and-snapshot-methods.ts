import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface DataSnapshotRuleVerdict {
  allowed: boolean;
  permissionDenied: boolean;
}

export interface DataSnapshotMethodsProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
  remove: typeof import('firebase/database').remove;
}

function classifySnapshotRuleError(err: unknown): DataSnapshotRuleVerdict {
  const errRecord = err as { code?: unknown; message?: unknown };
  const isCodeDenied = errRecord.code === 'PERMISSION_DENIED';
  let isMessageDenied = false;
  if (typeof errRecord.message === 'string') {
    isMessageDenied = /permission[_ ]denied/i.test(errRecord.message);
  }
  return {
    allowed: false,
    permissionDenied: isCodeDenied || isMessageDenied,
  };
}

async function runRead(
  sdk: DataSnapshotMethodsProbeSdk,
  path: string,
): Promise<DataSnapshotRuleVerdict> {
  try {
    await sdk.get(sdk.ref(sdk.db, path));
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifySnapshotRuleError(err);
  }
}

async function runSet(
  sdk: DataSnapshotMethodsProbeSdk,
  path: string,
  value: unknown,
): Promise<DataSnapshotRuleVerdict> {
  try {
    await sdk.set(sdk.ref(sdk.db, path), value);
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifySnapshotRuleError(err);
  }
}

async function runRemove(
  sdk: DataSnapshotMethodsProbeSdk,
  path: string,
): Promise<DataSnapshotRuleVerdict> {
  try {
    await sdk.remove(sdk.ref(sdk.db, path));
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifySnapshotRuleError(err);
  }
}

export const DATA_NEWDATA_SNAPSHOT_RULES = {
  createOnce: {
    '.read': 'auth != null',
    '.write': 'auth != null && !data.exists() && newData.exists()',
  },
  counter: {
    '.read': 'auth != null',
    count: {
      '.write': 'auth != null && data.exists() && newData.isNumber() && newData.val() > data.val()',
    },
  },
  vault: {
    config: {
      '.read': 'auth != null',
    },
    box: {
      '.read': "auth != null && data.parent().child('config/unlocked').val() === true",
      '.write':
        "auth != null && data.parent().child('config').child('unlocked').val() === true && newData.child('tag').val() === data.parent().child('config/expectedTag').val()",
    },
  },
} as const;

export async function observeRulesDataNewDataAndSnapshotMethods(
  sdk: DataSnapshotMethodsProbeSdk,
  basePath: string,
  seedAdminData: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  createOnceLifecycle: {
    initialCreateAllowed: DataSnapshotRuleVerdict;
    overwriteExistingDenied: DataSnapshotRuleVerdict;
    deleteExistingDenied: DataSnapshotRuleVerdict;
  };
  monotonicDataVsNewData: {
    lowerValueDenied: DataSnapshotRuleVerdict;
    equalValueDenied: DataSnapshotRuleVerdict;
    higherValueAllowed: DataSnapshotRuleVerdict;
  };
  parentAndChildNavigation: {
    readWhileLockedDenied: DataSnapshotRuleVerdict;
    readAfterUnlockAllowed: DataSnapshotRuleVerdict;
    writeWrongTagDenied: DataSnapshotRuleVerdict;
    writeMatchingExpectedTagAllowed: DataSnapshotRuleVerdict;
  };
}> {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  await seedAdminData('counter', { count: 10 });
  await seedAdminData('vault', {
    config: { unlocked: false, expectedTag: 'gold' },
    box: { tag: 'initial' },
  });

  const initialCreateAllowed = await runSet(sdk, `${prefix}createOnce`, { created: true });
  const overwriteExistingDenied = await runSet(sdk, `${prefix}createOnce`, { created: false });
  const deleteExistingDenied = await runRemove(sdk, `${prefix}createOnce`);

  const lowerValueDenied = await runSet(sdk, `${prefix}counter/count`, 5);
  const equalValueDenied = await runSet(sdk, `${prefix}counter/count`, 10);
  const higherValueAllowed = await runSet(sdk, `${prefix}counter/count`, 15);

  const readWhileLockedDenied = await runRead(sdk, `${prefix}vault/box`);
  await seedAdminData('vault/config/unlocked', true);
  const readAfterUnlockAllowed = await runRead(sdk, `${prefix}vault/box`);
  const writeWrongTagDenied = await runSet(sdk, `${prefix}vault/box`, { tag: 'silver' });
  const writeMatchingExpectedTagAllowed = await runSet(sdk, `${prefix}vault/box`, { tag: 'gold' });

  return {
    createOnceLifecycle: {
      initialCreateAllowed,
      overwriteExistingDenied,
      deleteExistingDenied,
    },
    monotonicDataVsNewData: {
      lowerValueDenied,
      equalValueDenied,
      higherValueAllowed,
    },
    parentAndChildNavigation: {
      readWhileLockedDenied,
      readAfterUnlockAllowed,
      writeWrongTagDenied,
      writeMatchingExpectedTagAllowed,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Live RTDB Security Rules evaluation for data vs newData state transitions and RuleDataSnapshot methods (data.exists(), data.val(), data.child(...), and data.parent()).',
  matrixRow: 'rtdb#64, rtdb#65',
  rowIds: ['rtdb#64', 'rtdb#65'],
  observe() {
    return withRtdbProbeSession(
      { runRules: { ...DATA_NEWDATA_SNAPSHOT_RULES } },
      async ({ runPath, db, rtdbSdk, adminWrite }) => {
        return observeRulesDataNewDataAndSnapshotMethods(
          {
            db,
            ref: rtdbSdk.ref,
            get: rtdbSdk.get,
            set: rtdbSdk.set,
            remove: rtdbSdk.remove,
          },
          runPath,
          adminWrite,
        );
      },
    );
  },
};
