import { describe, expect, test } from 'bun:test';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  buildAtomsScopedRules,
  observeRulesAtomsVerdicts,
  probe as atomsProbe,
  type ConstraintRuleVerdict,
  type ConstraintRulesProbeClients,
} from '../../probes/rtdb/rtdb-rules-atoms-verdicts.ts';
import {
  buildPoliciesScopedRules,
  observeRulesPoliciesVerdicts,
  probe as policiesProbe,
} from '../../probes/rtdb/rtdb-rules-policies-verdicts.ts';
import {
  observeAdminUseEmulatorContract,
  probe as adminUseEmulatorProbe,
  type AdminUseEmulatorBoundaryCase,
  type AdminUseEmulatorSdk,
  type AdminUseEmulatorThrowSummary,
} from '../../probes/rtdb-modular/rtdb-modular-admin-use-emulator-validation.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const LINKED_PROBE_IDS = [
  'rtdb-rules-atoms-verdicts',
  'rtdb-rules-policies-verdicts',
  'rtdb-modular-admin-use-emulator-validation',
] as const;

const ALLOWED: ConstraintRuleVerdict = { allowed: true, permissionDenied: false };
const DENIED: ConstraintRuleVerdict = { allowed: false, permissionDenied: true };

let sandboxSeq = 0;

function createConstraintRulesHarness(scopedRules: Record<string, unknown>) {
  sandboxSeq += 1;
  const runId = `constraint_local_${sandboxSeq}`;
  const basePath = `pyric_oracle/${runId}`;
  const sandbox = initializeSandbox({ projectId: `demo-constraints-${sandboxSeq}` });
  const userADb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'user-a' }));
  const userBDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'user-b' }));
  const unauthedDb = pyricRtdb.getDatabase(sandbox.withAuth(null));
  const adminDb = pyricRtdb.getAdminDatabase(sandbox);

  pyricRtdb.sandbox.setRules(userADb, {
    rules: {
      pyric_oracle: {
        [runId]: scopedRules,
      },
    },
  });

  const clients: ConstraintRulesProbeClients = {
    userADb: userADb as unknown as ConstraintRulesProbeClients['userADb'],
    userAUid: 'user-a',
    userBDb: userBDb as unknown as ConstraintRulesProbeClients['userBDb'],
    userBUid: 'user-b',
    unauthedDb: unauthedDb as unknown as ConstraintRulesProbeClients['unauthedDb'],
    ref: pyricRtdb.ref as unknown as ConstraintRulesProbeClients['ref'],
    get: pyricRtdb.get as unknown as ConstraintRulesProbeClients['get'],
    set: pyricRtdb.set as unknown as ConstraintRulesProbeClients['set'],
    remove: pyricRtdb.remove as unknown as ConstraintRulesProbeClients['remove'],
  };

  return {
    runId,
    basePath,
    clients,
    async seedAdminData(subpath: string, value: unknown): Promise<void> {
      const cleanSub = subpath.replace(/^\/+|\/+$/g, '');
      await pyricRtdb.set(pyricRtdb.ref(adminDb, `${basePath}/${cleanSub}`), value);
    },
  };
}

describe('RTDB constraint atoms/policies and admin useEmulator linked probes (sdk-probes)', () => {
  test('registers linked rules and admin useEmulator probes with clean authMode audit', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const byId = new Map(loaded.map((entry) => [entry.id, entry]));

    expect(byId.get('rtdb-rules-atoms-verdicts')?.surfaceDir).toBe('rtdb');
    expect(byId.get('rtdb-rules-policies-verdicts')?.surfaceDir).toBe('rtdb');
    expect(byId.get('rtdb-modular-admin-use-emulator-validation')?.surfaceDir).toBe('rtdb-modular');

    expect(atomsProbe.rig).toBe('sdk-probes');
    expect(atomsProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(atomsProbe.pendingRowLink).toBeUndefined();
    expect(atomsProbe.matrixRow).toBe('rtdb#84');
    expect(atomsProbe.rowIds).toEqual(['rtdb#84']);
    expect(atomsProbe.description.length).toBeGreaterThan(20);

    expect(policiesProbe.rig).toBe('sdk-probes');
    expect(policiesProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(policiesProbe.pendingRowLink).toBeUndefined();
    expect(policiesProbe.matrixRow).toBe('rtdb#85');
    expect(policiesProbe.rowIds).toEqual(['rtdb#85']);
    expect(policiesProbe.description.length).toBeGreaterThan(20);

    expect(adminUseEmulatorProbe.rig).toBe('sdk-probes');
    expect(adminUseEmulatorProbe.requires).toEqual([]);
    expect(adminUseEmulatorProbe.pendingRowLink).toBeUndefined();
    expect(adminUseEmulatorProbe.matrixRow).toBe('rtdb-admin#9');
    expect(adminUseEmulatorProbe.rowIds).toEqual(['rtdb-admin#9']);
    expect(adminUseEmulatorProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of LINKED_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    for (const id of LINKED_PROBE_IDS) {
      expect(previewLines.some((line) => line.includes(id))).toBe(true);
    }

    expect(auditProbeSessionAuthModes()).toEqual([]);
  });

  test('executes observeRulesAtomsVerdicts and observeRulesPoliciesVerdicts deterministically against Pyric sandbox', async () => {
    const atomsRunId = `constraint_local_${sandboxSeq + 1}`;
    const atomsHarness = createConstraintRulesHarness(
      buildAtomsScopedRules(['pyric_oracle', atomsRunId]),
    );
    const atomsObserved = await observeRulesAtomsVerdicts(
      atomsHarness.clients,
      atomsHarness.basePath,
      atomsHarness.seedAdminData,
    );

    expect(atomsObserved).toEqual({
      authenticated: {
        authedReadAllowed: ALLOWED,
        unauthedReadDenied: DENIED,
        authedWriteAllowed: ALLOWED,
        unauthedWriteDenied: DENIED,
      },
      ownPath: {
        ownUidWriteAllowed: ALLOWED,
        otherUidWriteDenied: DENIED,
        ownUidReadAllowed: ALLOWED,
        otherUidReadDenied: DENIED,
      },
      ownField: {
        ownerReadAllowed: ALLOWED,
        nonOwnerReadDenied: DENIED,
        ownerOverwriteAllowed: ALLOWED,
        nonOwnerOverwriteDenied: DENIED,
      },
      isNew: {
        initialCreateAllowed: ALLOWED,
        secondWriteDenied: DENIED,
        deleteExistingDenied: DENIED,
      },
      schemaPredicates: {
        validObjectAllowed: ALLOWED,
        primitiveLeafDenied: DENIED,
        missingNestedHasChildDenied: DENIED,
        nonStringTitleDenied: DENIED,
        nonNumberCountDenied: DENIED,
        nonBooleanActiveDenied: DENIED,
        invalidEnumKindDenied: DENIED,
      },
      immutability: {
        createImmutableFieldAllowed: ALLOWED,
        updateKeepingImmutableFieldAllowed: ALLOWED,
        mutateImmutableFieldDenied: DENIED,
        createImmutableSelfAllowed: ALLOWED,
        repeatSameImmutableSelfAllowed: ALLOWED,
        changeImmutableSelfDenied: DENIED,
      },
      crossPathRootLookups: {
        rootExistsPathVarPresentAllowed: ALLOWED,
        rootExistsPathVarMissingDenied: DENIED,
        rootExistsCallerListedAllowed: ALLOWED,
        rootExistsCallerUnlistedDenied: DENIED,
        rootEqualsMatchingRoleAllowed: ALLOWED,
        rootEqualsMismatchedRoleDenied: DENIED,
      },
    });
    expect(JSON.stringify(atomsObserved)).not.toContain(atomsHarness.runId);
    expect(JSON.stringify(atomsObserved)).not.toContain('user-a');

    const policiesRunId = `constraint_local_${sandboxSeq + 1}`;
    const policiesHarness = createConstraintRulesHarness(
      buildPoliciesScopedRules(['pyric_oracle', policiesRunId]),
    );
    const policiesObserved = await observeRulesPoliciesVerdicts(
      policiesHarness.clients,
      policiesHarness.basePath,
      policiesHarness.seedAdminData,
    );

    expect(policiesObserved).toEqual({
      pathOwnerOnly: {
        unauthedWriteDenied: DENIED,
        ownerWriteAllowed: ALLOWED,
        otherUserWriteDenied: DENIED,
        ownerReadAllowed: ALLOWED,
      },
      fieldOwnerOnly: {
        unauthedReadDenied: DENIED,
        ownerUpdateAllowed: ALLOWED,
        otherUserUpdateDenied: DENIED,
        freshCreateWithoutExistingOwnerDenied: DENIED,
      },
      ownerOrNew: {
        unauthedCreateDenied: DENIED,
        authedCreateNewAllowed: ALLOWED,
        otherUserEditExistingDenied: DENIED,
        fieldOwnerEditExistingAllowed: ALLOWED,
      },
      hasRole: {
        moderatorWriteAllowed: ALLOWED,
        guestWriteDenied: DENIED,
        unauthedWriteDenied: DENIED,
      },
      isMember: {
        memberReadAllowed: ALLOWED,
        nonMemberReadDenied: DENIED,
        memberWriteAllowed: ALLOWED,
        nonMemberWriteDenied: DENIED,
      },
      required: {
        allRequiredPresentAllowed: ALLOWED,
        missingTopLevelKeyDenied: DENIED,
        missingNestedSlashPathDenied: DENIED,
      },
      transition: {
        unlistedOpenToFinishedDenied: DENIED,
        allowedOpenToPlayingAllowed: ALLOWED,
        reversePlayingToOpenDenied: DENIED,
        allowedPlayingToFinishedAllowed: ALLOWED,
      },
    });
    expect(JSON.stringify(policiesObserved)).not.toContain(policiesHarness.runId);
    expect(JSON.stringify(policiesObserved)).not.toContain('user-a');
  });

  test('executes offline firebase-admin Database#useEmulator probe deterministically with zero network calls', async () => {
    const run1 = (await adminUseEmulatorProbe.observe()) as Awaited<
      ReturnType<typeof observeAdminUseEmulatorContract>
    > & { fetchCalls: number };
    const run2 = (await adminUseEmulatorProbe.observe()) as Awaited<
      ReturnType<typeof observeAdminUseEmulatorContract>
    > & { fetchCalls: number };

    expect(run1).toEqual(run2);
    expect(run1.fetchCalls).toBe(0);

    const postStartFatal: AdminUseEmulatorThrowSummary = {
      threw: true,
      isErrorInstance: true,
      code: null,
      message:
        'FIREBASE FATAL ERROR: connectDatabaseEmulator() cannot initialize or alter the emulator configuration after the database instance has started. ',
    };
    const noThrow: AdminUseEmulatorThrowSummary = {
      threw: false,
      isErrorInstance: false,
      code: null,
      message: null,
    };

    expect(run1.preStartBindingAndOverwrite).toEqual({
      baselineHttpsRefUrl: 'https://demo-admin-emulator-base.firebaseio.com/items/k1',
      afterUseEmulatorRefUrl: 'http://127.0.0.1:9000/items/k1',
      afterUseEmulatorRefJson: 'http://127.0.0.1:9000/items/k1',
      afterUseEmulatorRootUrl: 'http://127.0.0.1:9000/',
      overwrittenBeforeStartRefUrl: 'http://localhost:9005/items/k1',
    });
    expect(run1.refFromUrlAfterUseEmulator).toEqual({
      matchingEmulatorOriginUrl: 'http://127.0.0.1:9000/orders/o1',
      originalNamespaceHttpsUrl: 'http://127.0.0.1:9000/orders/o2',
      differentNamespaceHttpsUrl: 'http://127.0.0.1:9000/orders/o3',
    });
    const expectedEmptyHostBoundary: AdminUseEmulatorBoundaryCase = {
      callOutcome: noThrow,
      resultingRefUrl: 'http://:9000/items/k1',
    };
    expect(run1.argumentBoundaryBehavior).toEqual({
      emptyHost: expectedEmptyHostBoundary,
      schemePrefixedHost: {
        callOutcome: noThrow,
        resultingRefUrl: 'http://http://127.0.0.1:9000/items/k1',
      },
      ipv6LoopbackHost: {
        callOutcome: noThrow,
        resultingRefUrl: 'http://::1:9000/items/k1',
      },
      zeroPort: {
        callOutcome: noThrow,
        resultingRefUrl: 'http://127.0.0.1:0/items/k1',
      },
      negativePort: {
        callOutcome: noThrow,
        resultingRefUrl: 'http://127.0.0.1:-1/items/k1',
      },
      nanPort: {
        callOutcome: noThrow,
        resultingRefUrl: 'http://127.0.0.1:nan/items/k1',
      },
    });
    expect(run1.lifecycleAndPostStartGuards.sameHostPortRepeatAfterRef).toEqual(noThrow);
    expect(run1.lifecycleAndPostStartGuards.differentPortAfterRef).toEqual(postStartFatal);
    expect(run1.lifecycleAndPostStartGuards.differentHostAfterRef).toEqual(postStartFatal);
    expect(run1.lifecycleAndPostStartGuards.firstCallAfterRef).toEqual(postStartFatal);
    expect(run1.lifecycleAndPostStartGuards.firstCallAfterGoOffline).toEqual(postStartFatal);
    expect(run1.lifecycleAndPostStartGuards.mockUserTokenOptionOnAdmin).toEqual({
      threw: true,
      isErrorInstance: true,
      code: null,
      message:
        'FIREBASE FATAL ERROR: mockUserToken is not supported by the Admin SDK. For client access with mock users, please use the "firebase" package instead of "firebase-admin". ',
    });
    expect(run1.lifecycleAndPostStartGuards.callOnDeletedDatabase).toEqual({
      threw: true,
      isErrorInstance: true,
      code: null,
      message: 'FIREBASE FATAL ERROR: Cannot call useEmulator on a deleted database. ',
    });

    const sdkFnCheck: typeof observeAdminUseEmulatorContract = observeAdminUseEmulatorContract;
    const sdkShape: AdminUseEmulatorSdk | null = null;
    expect(typeof sdkFnCheck).toBe('function');
    expect(sdkShape).toBeNull();
  });
});
