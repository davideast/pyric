import { expect, it } from 'bun:test';
import {
  compileRtdbRules,
  serializeRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type SimulationInput,
  type SimulationResult,
} from '@pyric/rules/internal/rtdb';
import { initializeSandbox } from 'pyric/sandbox';
import {
  CASCADE_BINDINGS_AUTH_RULES,
  observeRulesCascadeBindingsAndAuthContext,
  type RulesCascadeAuthClients,
  type RulesVerdictOutcome,
} from '../../../../packages/conformance/probes/rtdb/rtdb-rules-cascade-bindings-and-auth-context.ts';
import {
  DATA_NEWDATA_SNAPSHOT_RULES,
  observeRulesDataNewDataAndSnapshotMethods,
  type DataSnapshotMethodsProbeSdk,
  type DataSnapshotRuleVerdict,
} from '../../../../packages/conformance/probes/rtdb/rtdb-rules-data-newdata-and-snapshot-methods.ts';
import {
  DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
  observeRulesDefaultDenyAndRuntimeErrors,
  type DefaultDenyAndErrorVerdict,
  type DefaultDenyAndRuntimeErrorSdk,
} from '../../../../packages/conformance/probes/rtdb/rtdb-rules-default-deny-and-runtime-errors.ts';
import {
  observeRulesJsonWildcardAndIndexOnRoundtrip,
  WILDCARD_AND_INDEXON_ROUNDTRIP_RULES,
  type RulesRoundtripClientSdk,
} from '../../../../packages/conformance/probes/rtdb/rtdb-rules-json-wildcard-and-indexon-roundtrip.ts';
import {
  get,
  getAdminDatabase,
  getDatabase,
  orderByChild,
  query,
  ref,
  remove,
  sandbox as rtdbSandbox,
  set,
  startAt,
} from '../../src/database/index.js';

type ObservationLoader = (name: string) => Record<string, unknown>;

function runSim(compiled: CompiledRtdbRules, input: SimulationInput): SimulationResult {
  const res = simulateRtdbRules(compiled, input);
  expect(res.success).toBe(true);
  if (res.success === false) {
    throw new Error(`Expected simulateRtdbRules verdict, got error ${res.error.code}: ${res.error.message}`);
  }
  return res.data;
}

function expectSimAllowed(
  compiled: CompiledRtdbRules,
  input: SimulationInput,
  expected: boolean | undefined,
): SimulationResult {
  const result = runSim(compiled, input);
  expect(result.allowed).toBe(expected);
  return result;
}

function createScopedSandboxClients(basePath: string, scopedRules: Record<string, unknown>) {
  const sandbox = initializeSandbox({ projectId: 'demo-rtdb-rules-conformance' });
  const authedUid = 'anon-uid-1';
  const authedDb = getDatabase(
    sandbox.withAuth({
      uid: authedUid,
      token: {
        firebase: { sign_in_provider: 'anonymous' },
      },
    }),
  );
  const unauthedDb = getDatabase(sandbox.withAuth(null));
  const adminDb = getAdminDatabase(sandbox);
  rtdbSandbox.setRules(authedDb, {
    rules: {
      [basePath]: structuredClone(scopedRules),
    },
  });
  return {
    authedDb,
    authedUid,
    unauthedDb,
    async seedAdminData(subpath: string, value: unknown): Promise<void> {
      const clean = subpath.replace(/^\/+|\/+$/g, '');
      await set(ref(adminDb, `${basePath}/${clean}`), value);
    },
  };
}

export function registerRtdbRulesOracleConformanceTests(load: ObservationLoader): void {
  it('rtdb-rules-cascade-bindings-and-auth-context: simulateRtdbRules and sandbox match live cascade, $userId bindings, and auth context (rtdb#61, #62, #63)', async () => {
    const obs = load('rtdb-rules-cascade-bindings-and-auth-context.json') as {
      ancestorCascadeOverridesChildFalse: Record<string, RulesVerdictOutcome>;
      pathVariableBindings: Record<string, RulesVerdictOutcome>;
      authNullVsBoundToken: Record<string, RulesVerdictOutcome>;
    };

    const basePath = 'probe_cascade';
    const { authedDb, authedUid, unauthedDb, seedAdminData } = createScopedSandboxClients(
      basePath,
      { ...CASCADE_BINDINGS_AUTH_RULES },
    );
    const clients: RulesCascadeAuthClients = {
      authedDb: authedDb as unknown as RulesCascadeAuthClients['authedDb'],
      authedUid,
      unauthedDb: unauthedDb as unknown as RulesCascadeAuthClients['unauthedDb'],
      ref: ref as unknown as RulesCascadeAuthClients['ref'],
      get: get as unknown as RulesCascadeAuthClients['get'],
      set: set as unknown as RulesCascadeAuthClients['set'],
    };
    const sandboxActual = await observeRulesCascadeBindingsAndAuthContext(
      clients,
      basePath,
      seedAdminData,
    );
    expect(sandboxActual).toEqual(obs);

    const compiled = compileRtdbRules({ rules: structuredClone(CASCADE_BINDINGS_AUTH_RULES) });
    const anonAuth = {
      uid: authedUid,
      token: { firebase: { sign_in_provider: 'anonymous' } },
    };
    const mockData = {
      cascadingRead: { childFalse: { secret: 'visible-via-parent' } },
      users: { 'other-fixed-uid': { profile: { owner: 'other-fixed-uid' } } },
      unauthedOnly: { publicGuest: true },
      providerBound: { anonAllowed: true },
    };

    const authedCascadeRead = expectSimAllowed(
      compiled,
      { operation: 'read', path: '/cascadingRead/childFalse', auth: anonAuth, mockData },
      obs.ancestorCascadeOverridesChildFalse.authedReadChildFalse?.allowed,
    );
    expect(authedCascadeRead.matchedPath).toBe('/cascadingRead');
    expect(authedCascadeRead.matchedRule).toBe('auth != null');

    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/cascadingRead/childFalse', auth: null, mockData },
      obs.ancestorCascadeOverridesChildFalse.unauthedReadChildFalse?.allowed,
    );

    const authedCascadeWrite = expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/cascadingWrite/childFalse',
        auth: anonAuth,
        mockData,
        newData: { updated: true },
      },
      obs.ancestorCascadeOverridesChildFalse.authedWriteChildFalse?.allowed,
    );
    expect(authedCascadeWrite.matchedPath).toBe('/cascadingWrite');

    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/cascadingWrite/childFalse',
        auth: null,
        mockData,
        newData: { updated: false },
      },
      obs.ancestorCascadeOverridesChildFalse.unauthedWriteChildFalse?.allowed,
    );

    const ownWrite = expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: `/users/${authedUid}/profile`,
        auth: anonAuth,
        mockData,
        newData: { owner: authedUid },
      },
      obs.pathVariableBindings.ownUidMatchingOwnerWrite?.allowed,
    );
    expect(ownWrite.pathVariableBindings).toEqual({ $userId: authedUid });

    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: `/users/${authedUid}/profile`,
        auth: anonAuth,
        mockData,
        newData: { owner: 'wrong-owner' },
      },
      obs.pathVariableBindings.ownUidMismatchedOwnerWrite?.allowed,
    );
    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/users/other-fixed-uid/profile',
        auth: anonAuth,
        mockData,
        newData: { owner: 'other-fixed-uid' },
      },
      obs.pathVariableBindings.otherUidWrite?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'read', path: `/users/${authedUid}/profile`, auth: anonAuth, mockData },
      obs.pathVariableBindings.ownUidRead?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/users/other-fixed-uid/profile', auth: anonAuth, mockData },
      obs.pathVariableBindings.otherUidRead?.allowed,
    );

    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/unauthedOnly', auth: null, mockData },
      obs.authNullVsBoundToken.unauthedOnAuthNullRead?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/unauthedOnly', auth: null, mockData, newData: { guestWrite: 1 } },
      obs.authNullVsBoundToken.unauthedOnAuthNullWrite?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/unauthedOnly', auth: anonAuth, mockData },
      obs.authNullVsBoundToken.authedOnAuthNullRead?.allowed,
    );
    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/unauthedOnly',
        auth: anonAuth,
        mockData,
        newData: { authedWrite: 1 },
      },
      obs.authNullVsBoundToken.authedOnAuthNullWrite?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/providerBound', auth: anonAuth, mockData },
      obs.authNullVsBoundToken.authedAnonymousProviderRead?.allowed,
    );
    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/providerBound',
        auth: anonAuth,
        mockData,
        newData: { byAnon: true },
      },
      obs.authNullVsBoundToken.authedAnonymousProviderWrite?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/providerBound', auth: null, mockData },
      obs.authNullVsBoundToken.unauthedAnonymousProviderRead?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/providerBound', auth: null, mockData, newData: { byGuest: true } },
      obs.authNullVsBoundToken.unauthedAnonymousProviderWrite?.allowed,
    );
  });

  it('rtdb-rules-data-newdata-and-snapshot-methods: simulateRtdbRules and sandbox match data/newData and snapshot navigation (rtdb#64, #65)', async () => {
    const obs = load('rtdb-rules-data-newdata-and-snapshot-methods.json') as {
      createOnceLifecycle: Record<string, DataSnapshotRuleVerdict>;
      monotonicDataVsNewData: Record<string, DataSnapshotRuleVerdict>;
      parentAndChildNavigation: Record<string, DataSnapshotRuleVerdict>;
    };

    const basePath = 'probe_snapshot_methods';
    const { authedDb, authedUid, seedAdminData } = createScopedSandboxClients(basePath, {
      ...DATA_NEWDATA_SNAPSHOT_RULES,
    });
    const sdk: DataSnapshotMethodsProbeSdk = {
      db: authedDb as unknown as DataSnapshotMethodsProbeSdk['db'],
      ref: ref as unknown as DataSnapshotMethodsProbeSdk['ref'],
      get: get as unknown as DataSnapshotMethodsProbeSdk['get'],
      set: set as unknown as DataSnapshotMethodsProbeSdk['set'],
      remove: remove as unknown as DataSnapshotMethodsProbeSdk['remove'],
    };
    const sandboxActual = await observeRulesDataNewDataAndSnapshotMethods(
      sdk,
      basePath,
      seedAdminData,
    );
    expect(sandboxActual).toEqual(obs);

    const compiled = compileRtdbRules({ rules: structuredClone(DATA_NEWDATA_SNAPSHOT_RULES) });
    const auth = { uid: authedUid };
    const initialMock = {
      counter: { count: 10 },
      vault: {
        config: { unlocked: false, expectedTag: 'gold' },
        box: { tag: 'initial' },
      },
    };
    const createdMock = { ...initialMock, createOnce: { created: true } };
    const unlockedMock = {
      counter: { count: 15 },
      vault: {
        config: { unlocked: true, expectedTag: 'gold' },
        box: { tag: 'initial' },
      },
    };

    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/createOnce', auth, mockData: initialMock, newData: { created: true } },
      obs.createOnceLifecycle.initialCreateAllowed?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/createOnce', auth, mockData: createdMock, newData: { created: false } },
      obs.createOnceLifecycle.overwriteExistingDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/createOnce', auth, mockData: createdMock, newData: null },
      obs.createOnceLifecycle.deleteExistingDenied?.allowed,
    );

    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/counter/count', auth, mockData: initialMock, newData: 5 },
      obs.monotonicDataVsNewData.lowerValueDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/counter/count', auth, mockData: initialMock, newData: 10 },
      obs.monotonicDataVsNewData.equalValueDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/counter/count', auth, mockData: initialMock, newData: 15 },
      obs.monotonicDataVsNewData.higherValueAllowed?.allowed,
    );

    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/vault/box', auth, mockData: initialMock },
      obs.parentAndChildNavigation.readWhileLockedDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/vault/box', auth, mockData: unlockedMock },
      obs.parentAndChildNavigation.readAfterUnlockAllowed?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/vault/box', auth, mockData: unlockedMock, newData: { tag: 'silver' } },
      obs.parentAndChildNavigation.writeWrongTagDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/vault/box', auth, mockData: unlockedMock, newData: { tag: 'gold' } },
      obs.parentAndChildNavigation.writeMatchingExpectedTagAllowed?.allowed,
    );
  });

  it('rtdb-rules-default-deny-and-runtime-errors: simulateRtdbRules and sandbox match ancestor deny attribution, default deny, and runtime error verdicts (rtdb#68, #69, #70)', async () => {
    const obs = load('rtdb-rules-default-deny-and-runtime-errors.json') as {
      explicitFalseAncestorWithChildValidateOrOppositeOp: Record<string, DefaultDenyAndErrorVerdict>;
      defaultDenyWhenNoRuleForOperationExists: Record<string, DefaultDenyAndErrorVerdict>;
      runtimeTypeErrorsFailClosedAsVerdicts: Record<string, DefaultDenyAndErrorVerdict>;
    };

    const basePath = 'probe_default_deny';
    const { authedDb, authedUid, seedAdminData } = createScopedSandboxClients(basePath, {
      ...DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
    });
    const sdk: DefaultDenyAndRuntimeErrorSdk = {
      db: authedDb as unknown as DefaultDenyAndRuntimeErrorSdk['db'],
      ref: ref as unknown as DefaultDenyAndRuntimeErrorSdk['ref'],
      get: get as unknown as DefaultDenyAndRuntimeErrorSdk['get'],
      set: set as unknown as DefaultDenyAndRuntimeErrorSdk['set'],
    };
    const sandboxActual = await observeRulesDefaultDenyAndRuntimeErrors(
      sdk,
      basePath,
      seedAdminData,
    );
    expect(sandboxActual).toEqual(obs);

    const compiled = compileRtdbRules({
      rules: structuredClone(DEFAULT_DENY_AND_RUNTIME_ERROR_RULES),
    });
    const auth = { uid: authedUid };
    const mockData = {
      readOnlyWithChildValidate: { sub: 'seeded' },
      ancestorReadFalseWithChildWriteOnly: { childWriteOnly: { onlyWrite: true } },
      noRulesBranch: { nested: { leaf: { hidden: 1 } } },
      runtimeErrors: {
        readStringMethodOnNumber: { numField: 42, childFallbackAllow: { ok: 1 } },
        writeStringMethodOnNull: { present: true },
      },
    };

    const writeOnReadOnlyChild = expectSimAllowed(
      compiled,
      { operation: 'write', path: '/readOnlyWithChildValidate/sub', auth, mockData, newData: 'valid-string' },
      obs.explicitFalseAncestorWithChildValidateOrOppositeOp
        .writeOnReadOnlyChildWithValidateDenied?.allowed,
    );
    expect(writeOnReadOnlyChild.matchedPath).toBe('/readOnlyWithChildValidate');
    expect(writeOnReadOnlyChild.matchedRule).toBe('false');

    const readOnChildrenOnly = expectSimAllowed(
      compiled,
      { operation: 'read', path: '/writeOnlyWithGrandchild/sub', auth, mockData },
      obs.explicitFalseAncestorWithChildValidateOrOppositeOp
        .readOnWriteOnlyChildrenOnlyNodeDenied?.allowed,
    );
    expect(readOnChildrenOnly.matchedPath).toBe('/writeOnlyWithGrandchild');
    expect(readOnChildrenOnly.matchedRule).toBe('false');

    const readOnChildWithOnlyWrite = expectSimAllowed(
      compiled,
      { operation: 'read', path: '/ancestorReadFalseWithChildWriteOnly/childWriteOnly', auth, mockData },
      obs.explicitFalseAncestorWithChildValidateOrOppositeOp
        .readOnChildWithOnlyWriteRuleDenied?.allowed,
    );
    expect(readOnChildWithOnlyWrite.matchedPath).toBe('/ancestorReadFalseWithChildWriteOnly');
    expect(readOnChildWithOnlyWrite.matchedRule).toBe('false');

    const rulelessRead = expectSimAllowed(
      compiled,
      { operation: 'read', path: '/noRulesBranch/nested/leaf', auth, mockData },
      obs.defaultDenyWhenNoRuleForOperationExists.readOnRulelessBranchDenied?.allowed,
    );
    expect(rulelessRead.matchedPath).toBe('');
    expect(rulelessRead.matchedRule).toBe('');
    expect(rulelessRead.reason.length).toBeGreaterThan(0);

    const rulelessWrite = expectSimAllowed(
      compiled,
      { operation: 'write', path: '/noRulesBranch/nested/leaf', auth, mockData, newData: { attempt: 1 } },
      obs.defaultDenyWhenNoRuleForOperationExists.writeOnRulelessBranchDenied?.allowed,
    );
    expect(rulelessWrite.matchedPath).toBe('');
    expect(rulelessWrite.matchedRule).toBe('');

    const erroringRead = expectSimAllowed(
      compiled,
      { operation: 'read', path: '/runtimeErrors/readStringMethodOnNumber', auth, mockData },
      obs.runtimeTypeErrorsFailClosedAsVerdicts.readCallingBeginsWithOnNumberDenied?.allowed,
    );
    expect(erroringRead.unsupported).toBeUndefined();

    expectSimAllowed(
      compiled,
      { operation: 'read', path: '/runtimeErrors/readStringMethodOnNumber/childFallbackAllow', auth, mockData },
      obs.runtimeTypeErrorsFailClosedAsVerdicts.childBelowErroringReadStillAllowed?.allowed,
    );
    expectSimAllowed(
      compiled,
      { operation: 'write', path: '/runtimeErrors/writeStringMethodOnNull', auth, mockData, newData: { next: 1 } },
      obs.runtimeTypeErrorsFailClosedAsVerdicts.writeCallingBeginsWithOnNullDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/runtimeErrors/validateStringMethodOnDynamicChild',
        auth,
        mockData,
        newData: { code: 999 },
      },
      obs.runtimeTypeErrorsFailClosedAsVerdicts.validateCallingBeginsWithOnNumberDenied?.allowed,
    );
    expectSimAllowed(
      compiled,
      {
        operation: 'write',
        path: '/runtimeErrors/validateStringMethodOnDynamicChild',
        auth,
        mockData,
        newData: { code: 'ok-123' },
      },
      obs.runtimeTypeErrorsFailClosedAsVerdicts.validateCallingBeginsWithOnValidStringAllowed
        ?.allowed,
    );
  });

  it('rtdb-rules-json-wildcard-and-indexon-roundtrip: compileRtdbRules and serializeRtdbRules preserve wildcards and .indexOn across round-trip and sandbox execution (rtdb#90, #91, #92, #93)', async () => {
    const obs = load('rtdb-rules-json-wildcard-and-indexon-roundtrip.json') as {
      fetchedScopedRulesJson: Record<string, unknown>;
      wildcardUserGameExecution: {
        matchingGameIdWriteAllowed: boolean;
        mismatchedGameIdWriteDenied: boolean;
        readBackStoredGame: unknown;
      };
      indexedOrderByChildExecution: {
        multiFieldScoreOrderKeys: string[];
        singleFieldRankOrderKeys: string[];
      };
    };

    expect(obs.fetchedScopedRulesJson).toEqual(WILDCARD_AND_INDEXON_ROUNDTRIP_RULES);

    const compiledOnce = compileRtdbRules({ rules: structuredClone(obs.fetchedScopedRulesJson) });
    const serializedOnce = serializeRtdbRules(compiledOnce);
    const compiledTwice = compileRtdbRules(serializedOnce);
    const serializedTwice = serializeRtdbRules(compiledTwice);

    expect(compiledTwice).not.toBe(compiledOnce);
    expect(compiledTwice).toEqual(compiledOnce);
    expect(serializedTwice).toEqual(serializedOnce);

    const expectedNormalizedPayload = {
      rules: {
        ...structuredClone(WILDCARD_AND_INDEXON_ROUNDTRIP_RULES),
        singleFieldIndex: {
          ...WILDCARD_AND_INDEXON_ROUNDTRIP_RULES.singleFieldIndex,
          '.indexOn': ['rank'],
        },
      },
    };
    expect(serializedOnce).toEqual(expectedNormalizedPayload);

    const usersNode = compiledTwice.children.find((node) => node.path === '/users');
    const userWildcardNode = usersNode?.children.find((node) => node.path === '/users/$userId');
    const gamesNode = userWildcardNode?.children.find(
      (node) => node.path === '/users/$userId/games',
    );
    const gameWildcardNode = gamesNode?.children.find(
      (node) => node.path === '/users/$userId/games/$gameId',
    );
    expect(gameWildcardNode?.pathVariables).toEqual(['$userId', '$gameId']);
    expect(gameWildcardNode?.read?.raw).toBe('$userId === auth.uid');

    const leaderboardNode = compiledTwice.children.find((node) => node.path === '/leaderboard');
    const singleFieldNode = compiledTwice.children.find(
      (node) => node.path === '/singleFieldIndex',
    );
    expect(leaderboardNode?.indexOn).toEqual(['score', 'turn']);
    expect(singleFieldNode?.indexOn).toEqual(['rank']);

    const sandbox = initializeSandbox({ projectId: 'demo-rules-roundtrip-conformance' });
    const uid = 'player-roundtrip-1';
    const db = getDatabase(sandbox.withAuth({ uid }));
    const basePath = 'probe_roundtrip';
    rtdbSandbox.setRules(db, {
      rules: {
        [basePath]: structuredClone(serializedTwice.rules),
      },
    });

    const clientSdk: RulesRoundtripClientSdk = {
      db: db as unknown as RulesRoundtripClientSdk['db'],
      uid,
      ref: ref as unknown as RulesRoundtripClientSdk['ref'],
      get: get as unknown as RulesRoundtripClientSdk['get'],
      set: set as unknown as RulesRoundtripClientSdk['set'],
      query: query as unknown as RulesRoundtripClientSdk['query'],
      orderByChild: orderByChild as unknown as RulesRoundtripClientSdk['orderByChild'],
      startAt: startAt as unknown as RulesRoundtripClientSdk['startAt'],
    };
    const sandboxActual = await observeRulesJsonWildcardAndIndexOnRoundtrip(
      clientSdk,
      basePath,
      async () => structuredClone(obs.fetchedScopedRulesJson),
    );
    expect(sandboxActual).toEqual(obs);
  });
}
