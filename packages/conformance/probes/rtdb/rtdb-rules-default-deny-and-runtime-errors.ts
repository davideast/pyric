import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface DefaultDenyAndErrorVerdict {
  allowed: boolean;
  permissionDenied: boolean;
}

export interface DefaultDenyAndRuntimeErrorSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
}

function classifyDefaultDenyOrRuntimeError(err: unknown): DefaultDenyAndErrorVerdict {
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

async function execRead(
  sdk: DefaultDenyAndRuntimeErrorSdk,
  path: string,
): Promise<DefaultDenyAndErrorVerdict> {
  try {
    await sdk.get(sdk.ref(sdk.db, path));
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyDefaultDenyOrRuntimeError(err);
  }
}

async function execWrite(
  sdk: DefaultDenyAndRuntimeErrorSdk,
  path: string,
  value: unknown,
): Promise<DefaultDenyAndErrorVerdict> {
  try {
    await sdk.set(sdk.ref(sdk.db, path), value);
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyDefaultDenyOrRuntimeError(err);
  }
}

export const DEFAULT_DENY_AND_RUNTIME_ERROR_RULES = {
  readOnlyWithChildValidate: {
    '.read': 'auth != null',
    '.write': false,
    sub: {
      '.validate': 'newData.isString()',
    },
  },
  writeOnlyWithGrandchild: {
    '.read': false,
    '.write': 'auth != null',
    sub: {
      leaf: {
        '.validate': 'newData.hasChildren()',
      },
    },
  },
  ancestorReadFalseWithChildWriteOnly: {
    '.read': false,
    childWriteOnly: {
      '.write': 'auth != null',
    },
  },
  noRulesBranch: {
    nested: {
      leaf: {},
    },
  },
  runtimeErrors: {
    readStringMethodOnNumber: {
      '.read': "data.child('numField').val().beginsWith('abc')",
      childFallbackAllow: {
        '.read': 'auth != null',
      },
    },
    writeStringMethodOnNull: {
      '.write': "data.child('missingField').val().beginsWith('abc')",
    },
    validateStringMethodOnDynamicChild: {
      '.write': 'auth != null',
      '.validate': "newData.child('code').val().beginsWith('ok-')",
    },
  },
} as const;

export async function observeRulesDefaultDenyAndRuntimeErrors(
  sdk: DefaultDenyAndRuntimeErrorSdk,
  basePath: string,
  seedAdminData: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  explicitFalseAncestorWithChildValidateOrOppositeOp: {
    readOnReadOnlyChildAllowed: DefaultDenyAndErrorVerdict;
    writeOnReadOnlyChildWithValidateDenied: DefaultDenyAndErrorVerdict;
    writeOnWriteOnlyGrandchildAllowed: DefaultDenyAndErrorVerdict;
    readOnWriteOnlyChildrenOnlyNodeDenied: DefaultDenyAndErrorVerdict;
    readOnWriteOnlyGrandchildDenied: DefaultDenyAndErrorVerdict;
    readOnChildWithOnlyWriteRuleDenied: DefaultDenyAndErrorVerdict;
    writeOnChildWithOnlyWriteRuleAllowed: DefaultDenyAndErrorVerdict;
  };
  defaultDenyWhenNoRuleForOperationExists: {
    readOnRulelessBranchDenied: DefaultDenyAndErrorVerdict;
    writeOnRulelessBranchDenied: DefaultDenyAndErrorVerdict;
  };
  runtimeTypeErrorsFailClosedAsVerdicts: {
    readCallingBeginsWithOnNumberDenied: DefaultDenyAndErrorVerdict;
    childBelowErroringReadStillAllowed: DefaultDenyAndErrorVerdict;
    writeCallingBeginsWithOnNullDenied: DefaultDenyAndErrorVerdict;
    validateCallingBeginsWithOnNumberDenied: DefaultDenyAndErrorVerdict;
    validateCallingBeginsWithOnValidStringAllowed: DefaultDenyAndErrorVerdict;
  };
}> {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  await seedAdminData('readOnlyWithChildValidate/sub', 'seeded');
  await seedAdminData('ancestorReadFalseWithChildWriteOnly/childWriteOnly', { onlyWrite: true });
  await seedAdminData('noRulesBranch/nested/leaf', { hidden: 1 });
  await seedAdminData('runtimeErrors/readStringMethodOnNumber', {
    numField: 42,
    childFallbackAllow: { ok: 1 },
  });
  await seedAdminData('runtimeErrors/writeStringMethodOnNull', { present: true });

  const readOnReadOnlyChildAllowed = await execRead(
    sdk,
    `${prefix}readOnlyWithChildValidate/sub`,
  );
  const writeOnReadOnlyChildWithValidateDenied = await execWrite(
    sdk,
    `${prefix}readOnlyWithChildValidate/sub`,
    'valid-string',
  );

  const writeOnWriteOnlyGrandchildAllowed = await execWrite(
    sdk,
    `${prefix}writeOnlyWithGrandchild/sub/leaf`,
    { ok: true },
  );
  const readOnWriteOnlyChildrenOnlyNodeDenied = await execRead(
    sdk,
    `${prefix}writeOnlyWithGrandchild/sub`,
  );
  const readOnWriteOnlyGrandchildDenied = await execRead(
    sdk,
    `${prefix}writeOnlyWithGrandchild/sub/leaf`,
  );
  const readOnChildWithOnlyWriteRuleDenied = await execRead(
    sdk,
    `${prefix}ancestorReadFalseWithChildWriteOnly/childWriteOnly`,
  );
  const writeOnChildWithOnlyWriteRuleAllowed = await execWrite(
    sdk,
    `${prefix}ancestorReadFalseWithChildWriteOnly/childWriteOnly`,
    { onlyWrite: false },
  );

  const readOnRulelessBranchDenied = await execRead(sdk, `${prefix}noRulesBranch/nested/leaf`);
  const writeOnRulelessBranchDenied = await execWrite(sdk, `${prefix}noRulesBranch/nested/leaf`, {
    attempt: 1,
  });

  const readCallingBeginsWithOnNumberDenied = await execRead(
    sdk,
    `${prefix}runtimeErrors/readStringMethodOnNumber`,
  );
  const childBelowErroringReadStillAllowed = await execRead(
    sdk,
    `${prefix}runtimeErrors/readStringMethodOnNumber/childFallbackAllow`,
  );
  const writeCallingBeginsWithOnNullDenied = await execWrite(
    sdk,
    `${prefix}runtimeErrors/writeStringMethodOnNull`,
    { next: 1 },
  );
  const validateCallingBeginsWithOnNumberDenied = await execWrite(
    sdk,
    `${prefix}runtimeErrors/validateStringMethodOnDynamicChild`,
    { code: 999 },
  );
  const validateCallingBeginsWithOnValidStringAllowed = await execWrite(
    sdk,
    `${prefix}runtimeErrors/validateStringMethodOnDynamicChild`,
    { code: 'ok-123' },
  );

  return {
    explicitFalseAncestorWithChildValidateOrOppositeOp: {
      readOnReadOnlyChildAllowed,
      writeOnReadOnlyChildWithValidateDenied,
      writeOnWriteOnlyGrandchildAllowed,
      readOnWriteOnlyChildrenOnlyNodeDenied,
      readOnWriteOnlyGrandchildDenied,
      readOnChildWithOnlyWriteRuleDenied,
      writeOnChildWithOnlyWriteRuleAllowed,
    },
    defaultDenyWhenNoRuleForOperationExists: {
      readOnRulelessBranchDenied,
      writeOnRulelessBranchDenied,
    },
    runtimeTypeErrorsFailClosedAsVerdicts: {
      readCallingBeginsWithOnNumberDenied,
      childBelowErroringReadStillAllowed,
      writeCallingBeginsWithOnNullDenied,
      validateCallingBeginsWithOnNumberDenied,
      validateCallingBeginsWithOnValidStringAllowed,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Live RTDB Security Rules evaluation for ancestor false verdicts when descendants carry only .validate or the opposite operation, default deny when no rule exists on the path, and runtime type errors (beginsWith on number/null) failing closed as deny verdicts.',
  matrixRow: 'rtdb#68, rtdb#69, rtdb#70, rtdb-modular#VR2',
  rowIds: ['rtdb#68', 'rtdb#69', 'rtdb#70', 'rtdb-modular#VR2'],
  observe() {
    return withRtdbProbeSession(
      { runRules: { ...DEFAULT_DENY_AND_RUNTIME_ERROR_RULES } },
      async ({ runPath, db, rtdbSdk, adminWrite }) => {
        return observeRulesDefaultDenyAndRuntimeErrors(
          {
            db,
            ref: rtdbSdk.ref,
            get: rtdbSdk.get,
            set: rtdbSdk.set,
          },
          runPath,
          adminWrite,
        );
      },
    );
  },
};
