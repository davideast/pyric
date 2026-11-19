import type { Database } from 'firebase/database';
import {
  all,
  authenticated,
  fieldEnum,
  fieldIsBoolean,
  fieldIsNumber,
  fieldIsString,
  hasChild,
  hasChildren,
  immutable,
  immutableSelf,
  isNew,
  ownField,
  ownPath,
  rootEquals,
  rootExists,
  ruleset,
  serializeRtdbRules,
  type Segment,
} from 'pyric/rules/internal/rtdb';
import type { Probe } from '../../rigs/types.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';

export interface ConstraintRuleVerdict {
  allowed: boolean;
  permissionDenied: boolean;
}

export interface ConstraintRulesProbeClients {
  userADb: Database;
  userAUid: string;
  userBDb: Database;
  userBUid: string;
  unauthedDb: Database;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
  remove: typeof import('firebase/database').remove;
}

function classifyRuleVerdictError(err: unknown): ConstraintRuleVerdict {
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

async function tryGet(
  clients: ConstraintRulesProbeClients,
  db: Database,
  path: string,
): Promise<ConstraintRuleVerdict> {
  try {
    await clients.get(clients.ref(db, path));
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyRuleVerdictError(err);
  }
}

async function trySet(
  clients: ConstraintRulesProbeClients,
  db: Database,
  path: string,
  value: unknown,
): Promise<ConstraintRuleVerdict> {
  try {
    await clients.set(clients.ref(db, path), value);
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyRuleVerdictError(err);
  }
}

async function tryRemove(
  clients: ConstraintRulesProbeClients,
  db: Database,
  path: string,
): Promise<ConstraintRuleVerdict> {
  try {
    await clients.remove(clients.ref(db, path));
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyRuleVerdictError(err);
  }
}

export function buildAtomsScopedRules(
  rootBaseSegments: readonly string[],
): Record<string, unknown> {
  const baseSegments: Segment[] = [...rootBaseSegments];
  const compiled = ruleset({
    '/atomAuth': {
      read: authenticated(),
      write: authenticated(),
    },
    '/atomOwnPath/$uid': {
      read: ownPath('$uid'),
      write: ownPath('$uid'),
    },
    '/atomOwnField/$docId': {
      read: ownField('author'),
      write: ownField('author'),
    },
    '/atomIsNew/$docId': {
      read: authenticated(),
      write: all(authenticated(), isNew()),
    },
    '/atomSchema/$itemId': {
      read: authenticated(),
      write: authenticated(),
      validate: all(
        hasChildren(),
        hasChild('meta/tag'),
        fieldIsString('title'),
        fieldIsNumber('count'),
        fieldIsBoolean('active'),
        fieldEnum('kind', ['note', 'task']),
      ),
    },
    '/atomImmutableField/$docId': {
      read: authenticated(),
      write: authenticated(),
      validate: immutable('createdBy'),
    },
    '/atomImmutableSelf/$slug': {
      read: authenticated(),
      write: authenticated(),
      validate: immutableSelf(),
    },
    '/atomRootExistsVar/$targetUid': {
      read: all(
        authenticated(),
        rootExists([...baseSegments, 'directory', { $: '$targetUid' }]),
      ),
    },
    '/atomRootExistsCaller': {
      write: all(
        authenticated(),
        rootExists([...baseSegments, 'directory', { $: 'auth.uid' }]),
      ),
    },
    '/atomRootEqualsAdmin': {
      write: all(
        authenticated(),
        rootEquals([...baseSegments, 'roles', { $: 'auth.uid' }, 'role'], 'admin'),
      ),
    },
  });
  return serializeRtdbRules(compiled).rules;
}

export async function observeRulesAtomsVerdicts(
  clients: ConstraintRulesProbeClients,
  basePath: string,
  seedAdminData: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  authenticated: {
    authedReadAllowed: ConstraintRuleVerdict;
    unauthedReadDenied: ConstraintRuleVerdict;
    authedWriteAllowed: ConstraintRuleVerdict;
    unauthedWriteDenied: ConstraintRuleVerdict;
  };
  ownPath: {
    ownUidWriteAllowed: ConstraintRuleVerdict;
    otherUidWriteDenied: ConstraintRuleVerdict;
    ownUidReadAllowed: ConstraintRuleVerdict;
    otherUidReadDenied: ConstraintRuleVerdict;
  };
  ownField: {
    ownerReadAllowed: ConstraintRuleVerdict;
    nonOwnerReadDenied: ConstraintRuleVerdict;
    ownerOverwriteAllowed: ConstraintRuleVerdict;
    nonOwnerOverwriteDenied: ConstraintRuleVerdict;
  };
  isNew: {
    initialCreateAllowed: ConstraintRuleVerdict;
    secondWriteDenied: ConstraintRuleVerdict;
    deleteExistingDenied: ConstraintRuleVerdict;
  };
  schemaPredicates: {
    validObjectAllowed: ConstraintRuleVerdict;
    primitiveLeafDenied: ConstraintRuleVerdict;
    missingNestedHasChildDenied: ConstraintRuleVerdict;
    nonStringTitleDenied: ConstraintRuleVerdict;
    nonNumberCountDenied: ConstraintRuleVerdict;
    nonBooleanActiveDenied: ConstraintRuleVerdict;
    invalidEnumKindDenied: ConstraintRuleVerdict;
  };
  immutability: {
    createImmutableFieldAllowed: ConstraintRuleVerdict;
    updateKeepingImmutableFieldAllowed: ConstraintRuleVerdict;
    mutateImmutableFieldDenied: ConstraintRuleVerdict;
    createImmutableSelfAllowed: ConstraintRuleVerdict;
    repeatSameImmutableSelfAllowed: ConstraintRuleVerdict;
    changeImmutableSelfDenied: ConstraintRuleVerdict;
  };
  crossPathRootLookups: {
    rootExistsPathVarPresentAllowed: ConstraintRuleVerdict;
    rootExistsPathVarMissingDenied: ConstraintRuleVerdict;
    rootExistsCallerListedAllowed: ConstraintRuleVerdict;
    rootExistsCallerUnlistedDenied: ConstraintRuleVerdict;
    rootEqualsMatchingRoleAllowed: ConstraintRuleVerdict;
    rootEqualsMismatchedRoleDenied: ConstraintRuleVerdict;
  };
}> {
  const { userADb, userAUid, userBDb, userBUid, unauthedDb } = clients;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  await seedAdminData('atomAuth', { seeded: true });
  await seedAdminData('atomOwnField/doc1', { author: userAUid, body: 'v1' });
  await seedAdminData(`directory/${userAUid}`, true);
  await seedAdminData(`atomRootExistsVar/${userAUid}`, { ok: true });
  await seedAdminData(`atomRootExistsVar/${userBUid}`, { ok: true });
  await seedAdminData(`roles/${userAUid}`, { role: 'admin' });
  await seedAdminData(`roles/${userBUid}`, { role: 'viewer' });

  const authedReadAllowed = await tryGet(clients, userADb, `${prefix}atomAuth`);
  const unauthedReadDenied = await tryGet(clients, unauthedDb, `${prefix}atomAuth`);
  const authedWriteAllowed = await trySet(clients, userADb, `${prefix}atomAuth`, { updated: 1 });
  const unauthedWriteDenied = await trySet(clients, unauthedDb, `${prefix}atomAuth`, { updated: 2 });

  const ownUidWriteAllowed = await trySet(clients, userADb, `${prefix}atomOwnPath/${userAUid}`, { slot: 1 });
  const otherUidWriteDenied = await trySet(clients, userBDb, `${prefix}atomOwnPath/${userAUid}`, { slot: 2 });
  const ownUidReadAllowed = await tryGet(clients, userADb, `${prefix}atomOwnPath/${userAUid}`);
  const otherUidReadDenied = await tryGet(clients, userBDb, `${prefix}atomOwnPath/${userAUid}`);

  const ownerReadAllowed = await tryGet(clients, userADb, `${prefix}atomOwnField/doc1`);
  const nonOwnerReadDenied = await tryGet(clients, userBDb, `${prefix}atomOwnField/doc1`);
  const ownerOverwriteAllowed = await trySet(clients, userADb, `${prefix}atomOwnField/doc1`, {
    author: userAUid,
    body: 'v2',
  });
  const nonOwnerOverwriteDenied = await trySet(clients, userBDb, `${prefix}atomOwnField/doc1`, {
    author: userBUid,
    body: 'hijack',
  });

  const initialCreateAllowed = await trySet(clients, userADb, `${prefix}atomIsNew/n1`, { created: true });
  const secondWriteDenied = await trySet(clients, userADb, `${prefix}atomIsNew/n1`, { created: false });
  const deleteExistingDenied = await tryRemove(clients, userADb, `${prefix}atomIsNew/n1`);

  const validObjectAllowed = await trySet(clients, userADb, `${prefix}atomSchema/s1`, {
    title: 'alpha',
    count: 3,
    active: true,
    kind: 'note',
    meta: { tag: 'v1' },
  });
  const primitiveLeafDenied = await trySet(clients, userADb, `${prefix}atomSchema/s2`, 'plain-leaf');
  const missingNestedHasChildDenied = await trySet(clients, userADb, `${prefix}atomSchema/s3`, {
    title: 'alpha',
    count: 3,
    active: true,
    kind: 'note',
    meta: {},
  });
  const nonStringTitleDenied = await trySet(clients, userADb, `${prefix}atomSchema/s4`, {
    title: 42,
    count: 3,
    active: true,
    kind: 'note',
    meta: { tag: 'v1' },
  });
  const nonNumberCountDenied = await trySet(clients, userADb, `${prefix}atomSchema/s5`, {
    title: 'alpha',
    count: '3',
    active: true,
    kind: 'note',
    meta: { tag: 'v1' },
  });
  const nonBooleanActiveDenied = await trySet(clients, userADb, `${prefix}atomSchema/s6`, {
    title: 'alpha',
    count: 3,
    active: 1,
    kind: 'note',
    meta: { tag: 'v1' },
  });
  const invalidEnumKindDenied = await trySet(clients, userADb, `${prefix}atomSchema/s7`, {
    title: 'alpha',
    count: 3,
    active: true,
    kind: 'archived',
    meta: { tag: 'v1' },
  });

  const createImmutableFieldAllowed = await trySet(clients, userADb, `${prefix}atomImmutableField/f1`, {
    createdBy: 'creator-1',
    note: 'v1',
  });
  const updateKeepingImmutableFieldAllowed = await trySet(clients, userADb, `${prefix}atomImmutableField/f1`, {
    createdBy: 'creator-1',
    note: 'v2',
  });
  const mutateImmutableFieldDenied = await trySet(clients, userADb, `${prefix}atomImmutableField/f1`, {
    createdBy: 'creator-2',
    note: 'v3',
  });
  const createImmutableSelfAllowed = await trySet(clients, userADb, `${prefix}atomImmutableSelf/k1`, 'locked-v1');
  const repeatSameImmutableSelfAllowed = await trySet(clients, userADb, `${prefix}atomImmutableSelf/k1`, 'locked-v1');
  const changeImmutableSelfDenied = await trySet(clients, userADb, `${prefix}atomImmutableSelf/k1`, 'locked-v2');

  const rootExistsPathVarPresentAllowed = await tryGet(clients, userADb, `${prefix}atomRootExistsVar/${userAUid}`);
  const rootExistsPathVarMissingDenied = await tryGet(clients, userADb, `${prefix}atomRootExistsVar/${userBUid}`);
  const rootExistsCallerListedAllowed = await trySet(clients, userADb, `${prefix}atomRootExistsCaller`, { ok: true });
  const rootExistsCallerUnlistedDenied = await trySet(clients, userBDb, `${prefix}atomRootExistsCaller`, { ok: true });
  const rootEqualsMatchingRoleAllowed = await trySet(clients, userADb, `${prefix}atomRootEqualsAdmin`, { ok: true });
  const rootEqualsMismatchedRoleDenied = await trySet(clients, userBDb, `${prefix}atomRootEqualsAdmin`, { ok: true });

  return {
    authenticated: {
      authedReadAllowed,
      unauthedReadDenied,
      authedWriteAllowed,
      unauthedWriteDenied,
    },
    ownPath: {
      ownUidWriteAllowed,
      otherUidWriteDenied,
      ownUidReadAllowed,
      otherUidReadDenied,
    },
    ownField: {
      ownerReadAllowed,
      nonOwnerReadDenied,
      ownerOverwriteAllowed,
      nonOwnerOverwriteDenied,
    },
    isNew: {
      initialCreateAllowed,
      secondWriteDenied,
      deleteExistingDenied,
    },
    schemaPredicates: {
      validObjectAllowed,
      primitiveLeafDenied,
      missingNestedHasChildDenied,
      nonStringTitleDenied,
      nonNumberCountDenied,
      nonBooleanActiveDenied,
      invalidEnumKindDenied,
    },
    immutability: {
      createImmutableFieldAllowed,
      updateKeepingImmutableFieldAllowed,
      mutateImmutableFieldDenied,
      createImmutableSelfAllowed,
      repeatSameImmutableSelfAllowed,
      changeImmutableSelfDenied,
    },
    crossPathRootLookups: {
      rootExistsPathVarPresentAllowed,
      rootExistsPathVarMissingDenied,
      rootExistsCallerListedAllowed,
      rootExistsCallerUnlistedDenied,
      rootEqualsMatchingRoleAllowed,
      rootEqualsMismatchedRoleDenied,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Live RTDB Security Rules verdicts for rulesets compiled from all 14 constraint atoms predicates (authenticated, ownPath, ownField, isNew, hasChildren, hasChild, fieldIsString/Number/Boolean, fieldEnum, immutable, immutableSelf, rootExists, rootEquals).',
  async observe() {
    const [
      { RTDB_RULES_SCOPE },
      { loadOracleServiceAccount, oracleAccessToken },
      { OracleRulesSession, rtdbOracleTarget, runWithOracleRulesRestored },
      { withRtdbProbeSession },
    ] = await Promise.all([
      import('../../src/oracle-access-token.ts'),
      import('../../src/oracle-credential.ts'),
      import('../../src/oracle-rules-session.ts'),
      import('../../src/sdk-probe-runtime.ts'),
    ]);
    return withRtdbProbeSession(
      { runRules: { '.read': false, '.write': false }, propagationMs: 0 },
      async ({ runId, runPath, databaseUrl, openClient, rtdbSdk, adminWrite }) => {
        const sa = await loadOracleServiceAccount();
        const getRtdbToken = () => oracleAccessToken(sa, RTDB_RULES_SCOPE);
        const scopedRules = buildAtomsScopedRules(['pyric_oracle', runId]);
        const innerRulesSession = new OracleRulesSession({
          projectId: sa.project_id,
          accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
        });

        return runWithOracleRulesRestored(innerRulesSession, async () => {
          await innerRulesSession.deployRtdb(
            rtdbOracleTarget(databaseUrl, getRtdbToken, {
              runId,
              rules: scopedRules,
              stripTopLevelGrants: true,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 5_000));

          const [{ deleteApp, initializeApp }, userA, userB] = await Promise.all([
            import('firebase/app'),
            openClient('atoms-user-a'),
            openClient('atoms-user-b'),
          ]);
          const unauthedApp = initializeApp(
            { databaseURL: databaseUrl },
            `sdk-probe-atoms-unauthed-${runId}`,
          );
          const unauthedDb = rtdbSdk.getDatabase(unauthedApp);

          try {
            return await observeRulesAtomsVerdicts(
              {
                userADb: userA.db,
                userAUid: userA.uid,
                userBDb: userB.db,
                userBUid: userB.uid,
                unauthedDb,
                ref: rtdbSdk.ref,
                get: rtdbSdk.get,
                set: rtdbSdk.set,
                remove: rtdbSdk.remove,
              },
              runPath,
              adminWrite,
            );
          } finally {
            rtdbSdk.goOffline(unauthedDb);
            await deleteApp(unauthedApp).catch(() => undefined);
          }
        });
      },
    );
  },
};
