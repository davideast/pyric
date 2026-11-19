import { describe, expect, test } from 'bun:test';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  CASCADE_BINDINGS_AUTH_RULES,
  observeRulesCascadeBindingsAndAuthContext,
  probe as cascadeBindingsAuthProbe,
  type RulesCascadeAuthClients,
  type RulesVerdictOutcome,
} from '../../probes/rtdb/rtdb-rules-cascade-bindings-and-auth-context.ts';
import {
  DATA_NEWDATA_SNAPSHOT_RULES,
  observeRulesDataNewDataAndSnapshotMethods,
  probe as dataNewDataSnapshotProbe,
  type DataSnapshotMethodsProbeSdk,
  type DataSnapshotRuleVerdict,
} from '../../probes/rtdb/rtdb-rules-data-newdata-and-snapshot-methods.ts';
import {
  DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
  observeRulesDefaultDenyAndRuntimeErrors,
  probe as defaultDenyAndErrorsProbe,
  type DefaultDenyAndErrorVerdict,
  type DefaultDenyAndRuntimeErrorSdk,
} from '../../probes/rtdb/rtdb-rules-default-deny-and-runtime-errors.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const RTDB_RULES_EVALUATION_PROBE_IDS = [
  'rtdb-rules-cascade-bindings-and-auth-context',
  'rtdb-rules-data-newdata-and-snapshot-methods',
  'rtdb-rules-default-deny-and-runtime-errors',
] as const;

let rulesSandboxSeq = 0;

function createScopedRulesSandbox(basePath: string, scopedRules: Record<string, unknown>) {
  rulesSandboxSeq += 1;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-rules-eval-${rulesSandboxSeq}` });
  const authedRawDb = pyricRtdb.getDatabase(
    sandbox.withAuth({
      uid: 'anon-uid-1',
      token: {
        firebase: { sign_in_provider: 'anonymous' },
      },
    }),
  );
  const unauthedRawDb = pyricRtdb.getDatabase(sandbox.withAuth(null));
  const adminRawDb = pyricRtdb.getAdminDatabase(sandbox);
  pyricRtdb.sandbox.setRules(authedRawDb, {
    rules: {
      [basePath]: scopedRules,
    },
  });
  return {
    authedDb: authedRawDb as unknown as RulesCascadeAuthClients['authedDb'],
    authedUid: 'anon-uid-1',
    unauthedDb: unauthedRawDb as unknown as RulesCascadeAuthClients['unauthedDb'],
    async adminWriteAt(subpath: string, value: unknown): Promise<void> {
      const cleanSub = subpath.replace(/^\/+|\/+$/g, '');
      await pyricRtdb.set(pyricRtdb.ref(adminRawDb, `${basePath}/${cleanSub}`), value);
    },
  };
}

describe('RTDB Security Rules evaluation probes on surface rtdb (sdk-probes)', () => {
  test('registers all 3 RTDB Security Rules evaluation probes under probes/rtdb with linked rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of RTDB_RULES_EVALUATION_PROBE_IDS) {
      expect(loadedIds).toContain(id);
      const entry = loaded.find((item) => item.id === id);
      expect(entry?.surfaceDir).toBe('rtdb');
    }

    const expectedRowIds: ReadonlyArray<[typeof cascadeBindingsAuthProbe, string[]]> = [
      [cascadeBindingsAuthProbe, ['rtdb#61', 'rtdb#62', 'rtdb#63', 'rtdb-modular#VR1']],
      [dataNewDataSnapshotProbe, ['rtdb#64', 'rtdb#65', 'rtdb-modular#VR2']],
      [defaultDenyAndErrorsProbe, ['rtdb#68', 'rtdb#69', 'rtdb#70', 'rtdb-modular#VR2']],
    ];
    for (const [probeRecord, rowIds] of expectedRowIds) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'dedicated-rtdb']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(rowIds.join(', '));
      expect(probeRecord.rowIds).toEqual(rowIds);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of RTDB_RULES_EVALUATION_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    for (const id of RTDB_RULES_EVALUATION_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes upward grant cascading, $userId path bindings, and auth == null vs anonymous token context', async () => {
    const basePath = 'probe_cascade';
    const { authedDb, authedUid, unauthedDb, adminWriteAt } = createScopedRulesSandbox(basePath, {
      ...CASCADE_BINDINGS_AUTH_RULES,
    });

    const clients: RulesCascadeAuthClients = {
      authedDb,
      authedUid,
      unauthedDb,
      ref: pyricRtdb.ref as unknown as RulesCascadeAuthClients['ref'],
      get: pyricRtdb.get as unknown as RulesCascadeAuthClients['get'],
      set: pyricRtdb.set as unknown as RulesCascadeAuthClients['set'],
    };

    const result = await observeRulesCascadeBindingsAndAuthContext(
      clients,
      basePath,
      adminWriteAt,
    );
    const allowed: RulesVerdictOutcome = { allowed: true, permissionDenied: false };
    const denied: RulesVerdictOutcome = { allowed: false, permissionDenied: true };

    expect(result.ancestorCascadeOverridesChildFalse).toEqual({
      authedReadChildFalse: allowed,
      unauthedReadChildFalse: denied,
      authedWriteChildFalse: allowed,
      unauthedWriteChildFalse: denied,
    });
    expect(result.pathVariableBindings).toEqual({
      ownUidMatchingOwnerWrite: allowed,
      ownUidMismatchedOwnerWrite: denied,
      otherUidWrite: denied,
      ownUidRead: allowed,
      otherUidRead: denied,
    });
    expect(result.authNullVsBoundToken).toEqual({
      unauthedOnAuthNullRead: allowed,
      unauthedOnAuthNullWrite: allowed,
      authedOnAuthNullRead: denied,
      authedOnAuthNullWrite: denied,
      authedAnonymousProviderRead: allowed,
      authedAnonymousProviderWrite: allowed,
      unauthedAnonymousProviderRead: denied,
      unauthedAnonymousProviderWrite: denied,
    });
  });

  test('observes data vs newData transitions and data.exists(), val(), child(), parent() navigation', async () => {
    const basePath = 'probe_data_nav';
    const { authedDb, adminWriteAt } = createScopedRulesSandbox(basePath, {
      ...DATA_NEWDATA_SNAPSHOT_RULES,
    });

    const sdk: DataSnapshotMethodsProbeSdk = {
      db: authedDb,
      ref: pyricRtdb.ref as unknown as DataSnapshotMethodsProbeSdk['ref'],
      get: pyricRtdb.get as unknown as DataSnapshotMethodsProbeSdk['get'],
      set: pyricRtdb.set as unknown as DataSnapshotMethodsProbeSdk['set'],
      remove: pyricRtdb.remove as unknown as DataSnapshotMethodsProbeSdk['remove'],
    };

    const result = await observeRulesDataNewDataAndSnapshotMethods(sdk, basePath, adminWriteAt);
    const allowed: DataSnapshotRuleVerdict = { allowed: true, permissionDenied: false };
    const denied: DataSnapshotRuleVerdict = { allowed: false, permissionDenied: true };

    expect(result.createOnceLifecycle).toEqual({
      initialCreateAllowed: allowed,
      overwriteExistingDenied: denied,
      deleteExistingDenied: denied,
    });
    expect(result.monotonicDataVsNewData).toEqual({
      lowerValueDenied: denied,
      equalValueDenied: denied,
      higherValueAllowed: allowed,
    });
    expect(result.parentAndChildNavigation).toEqual({
      readWhileLockedDenied: denied,
      readAfterUnlockAllowed: allowed,
      writeWrongTagDenied: denied,
      writeMatchingExpectedTagAllowed: allowed,
    });
  });

  test('observes ancestor false with child .validate, ruleless default deny, and runtime type errors failing closed', async () => {
    const basePath = 'probe_default_deny';
    const { authedDb, adminWriteAt } = createScopedRulesSandbox(basePath, {
      ...DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
    });

    const sdk: DefaultDenyAndRuntimeErrorSdk = {
      db: authedDb,
      ref: pyricRtdb.ref as unknown as DefaultDenyAndRuntimeErrorSdk['ref'],
      get: pyricRtdb.get as unknown as DefaultDenyAndRuntimeErrorSdk['get'],
      set: pyricRtdb.set as unknown as DefaultDenyAndRuntimeErrorSdk['set'],
    };

    const result = await observeRulesDefaultDenyAndRuntimeErrors(sdk, basePath, adminWriteAt);
    const allowed: DefaultDenyAndErrorVerdict = { allowed: true, permissionDenied: false };
    const denied: DefaultDenyAndErrorVerdict = { allowed: false, permissionDenied: true };

    expect(result.explicitFalseAncestorWithChildValidateOrOppositeOp).toEqual({
      readOnReadOnlyChildAllowed: allowed,
      writeOnReadOnlyChildWithValidateDenied: denied,
      writeOnWriteOnlyGrandchildAllowed: allowed,
      readOnWriteOnlyChildrenOnlyNodeDenied: denied,
      readOnWriteOnlyGrandchildDenied: denied,
      readOnChildWithOnlyWriteRuleDenied: denied,
      writeOnChildWithOnlyWriteRuleAllowed: allowed,
    });
    expect(result.defaultDenyWhenNoRuleForOperationExists).toEqual({
      readOnRulelessBranchDenied: denied,
      writeOnRulelessBranchDenied: denied,
    });
    expect(result.runtimeTypeErrorsFailClosedAsVerdicts).toEqual({
      readCallingBeginsWithOnNumberDenied: denied,
      childBelowErroringReadStillAllowed: allowed,
      writeCallingBeginsWithOnNullDenied: denied,
      validateCallingBeginsWithOnNumberDenied: denied,
      validateCallingBeginsWithOnValidStringAllowed: allowed,
    });
  });
});
