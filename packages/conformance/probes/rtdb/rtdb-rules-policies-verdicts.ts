import type { Database } from 'firebase/database';
import {
  all,
  authenticated,
  fieldOwnerOnly,
  hasRole,
  isMember,
  ownerOrNew,
  pathOwnerOnly,
  required,
  ruleset,
  serializeRtdbRules,
  transition,
  type Segment,
} from 'pyric/rules/internal/rtdb';
import type { Probe } from '../../rigs/types.ts';
import type {
  ConstraintRuleVerdict,
  ConstraintRulesProbeClients,
} from './rtdb-rules-atoms-verdicts.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';

function classifyPolicyError(err: unknown): ConstraintRuleVerdict {
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
    return classifyPolicyError(err);
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
    return classifyPolicyError(err);
  }
}

export function buildPoliciesScopedRules(
  rootBaseSegments: readonly string[],
): Record<string, unknown> {
  const baseSegments: Segment[] = [...rootBaseSegments];
  const baseSlashPath = rootBaseSegments.join('/');
  const compiled = ruleset({
    '/policyPathOwner/$uid': {
      read: pathOwnerOnly('$uid'),
      write: pathOwnerOnly('$uid'),
    },
    '/policyFieldOwner/$docId': {
      read: fieldOwnerOnly('owner'),
      write: fieldOwnerOnly('owner'),
    },
    '/policyOwnerOrNew/$docId': {
      read: authenticated(),
      write: ownerOrNew('owner'),
    },
    '/policyHasRole': {
      write: all(
        authenticated(),
        hasRole([...baseSegments, 'roles', { $: 'auth.uid' }, 'tier'], 'moderator'),
      ),
    },
    '/policyIsMember/$teamId/board': {
      read: all(authenticated(), isMember(`${baseSlashPath}/team_members`, 'teamId')),
      write: all(authenticated(), isMember(`${baseSlashPath}/team_members`, 'teamId')),
    },
    '/policyRequired/$entryId': {
      read: authenticated(),
      write: authenticated(),
      validate: required('title', 'score', 'puck/x', 'puck/y'),
    },
    '/policyTransition/$gameId': {
      read: authenticated(),
      write: all(
        authenticated(),
        transition('status', [
          ['open', 'playing'],
          ['playing', 'finished'],
        ]),
      ),
    },
  });
  return serializeRtdbRules(compiled).rules;
}

export async function observeRulesPoliciesVerdicts(
  clients: ConstraintRulesProbeClients,
  basePath: string,
  seedAdminData: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  pathOwnerOnly: {
    unauthedWriteDenied: ConstraintRuleVerdict;
    ownerWriteAllowed: ConstraintRuleVerdict;
    otherUserWriteDenied: ConstraintRuleVerdict;
    ownerReadAllowed: ConstraintRuleVerdict;
  };
  fieldOwnerOnly: {
    unauthedReadDenied: ConstraintRuleVerdict;
    ownerUpdateAllowed: ConstraintRuleVerdict;
    otherUserUpdateDenied: ConstraintRuleVerdict;
    freshCreateWithoutExistingOwnerDenied: ConstraintRuleVerdict;
  };
  ownerOrNew: {
    unauthedCreateDenied: ConstraintRuleVerdict;
    authedCreateNewAllowed: ConstraintRuleVerdict;
    otherUserEditExistingDenied: ConstraintRuleVerdict;
    fieldOwnerEditExistingAllowed: ConstraintRuleVerdict;
  };
  hasRole: {
    moderatorWriteAllowed: ConstraintRuleVerdict;
    guestWriteDenied: ConstraintRuleVerdict;
    unauthedWriteDenied: ConstraintRuleVerdict;
  };
  isMember: {
    memberReadAllowed: ConstraintRuleVerdict;
    nonMemberReadDenied: ConstraintRuleVerdict;
    memberWriteAllowed: ConstraintRuleVerdict;
    nonMemberWriteDenied: ConstraintRuleVerdict;
  };
  required: {
    allRequiredPresentAllowed: ConstraintRuleVerdict;
    missingTopLevelKeyDenied: ConstraintRuleVerdict;
    missingNestedSlashPathDenied: ConstraintRuleVerdict;
  };
  transition: {
    unlistedOpenToFinishedDenied: ConstraintRuleVerdict;
    allowedOpenToPlayingAllowed: ConstraintRuleVerdict;
    reversePlayingToOpenDenied: ConstraintRuleVerdict;
    allowedPlayingToFinishedAllowed: ConstraintRuleVerdict;
  };
}> {
  const { userADb, userAUid, userBDb, userBUid, unauthedDb } = clients;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  await seedAdminData(`roles/${userAUid}`, { tier: 'moderator' });
  await seedAdminData(`roles/${userBUid}`, { tier: 'guest' });
  await seedAdminData('policyFieldOwner/doc1', { owner: userAUid, text: 'seed' });
  await seedAdminData(`team_members/alpha/${userAUid}`, true);
  await seedAdminData('policyIsMember/alpha/board', { topic: 'initial' });
  await seedAdminData('policyTransition/g1', { status: 'open' });

  const unauthedWriteDenied = await trySet(clients, unauthedDb, `${prefix}policyPathOwner/${userAUid}`, { v: 1 });
  const ownerWriteAllowed = await trySet(clients, userADb, `${prefix}policyPathOwner/${userAUid}`, { v: 1 });
  const otherUserWriteDenied = await trySet(clients, userBDb, `${prefix}policyPathOwner/${userAUid}`, { v: 2 });
  const ownerReadAllowed = await tryGet(clients, userADb, `${prefix}policyPathOwner/${userAUid}`);

  const unauthedReadDenied = await tryGet(clients, unauthedDb, `${prefix}policyFieldOwner/doc1`);
  const ownerUpdateAllowed = await trySet(clients, userADb, `${prefix}policyFieldOwner/doc1`, {
    owner: userAUid,
    text: 'edited',
  });
  const otherUserUpdateDenied = await trySet(clients, userBDb, `${prefix}policyFieldOwner/doc1`, {
    owner: userBUid,
    text: 'denied',
  });
  const freshCreateWithoutExistingOwnerDenied = await trySet(clients, userADb, `${prefix}policyFieldOwner/doc2`, {
    owner: userAUid,
    text: 'fresh',
  });

  const unauthedCreateDenied = await trySet(clients, unauthedDb, `${prefix}policyOwnerOrNew/p1`, {
    owner: 'guest',
    rev: 1,
  });
  const authedCreateNewAllowed = await trySet(clients, userADb, `${prefix}policyOwnerOrNew/p1`, {
    owner: userAUid,
    rev: 1,
  });
  const otherUserEditExistingDenied = await trySet(clients, userBDb, `${prefix}policyOwnerOrNew/p1`, {
    owner: userBUid,
    rev: 2,
  });
  const fieldOwnerEditExistingAllowed = await trySet(clients, userADb, `${prefix}policyOwnerOrNew/p1`, {
    owner: userAUid,
    rev: 2,
  });

  const moderatorWriteAllowed = await trySet(clients, userADb, `${prefix}policyHasRole`, { flagged: true });
  const guestWriteDenied = await trySet(clients, userBDb, `${prefix}policyHasRole`, { flagged: true });
  const hasRoleUnauthedWriteDenied = await trySet(clients, unauthedDb, `${prefix}policyHasRole`, { flagged: false });

  const memberReadAllowed = await tryGet(clients, userADb, `${prefix}policyIsMember/alpha/board`);
  const nonMemberReadDenied = await tryGet(clients, userBDb, `${prefix}policyIsMember/alpha/board`);
  const memberWriteAllowed = await trySet(clients, userADb, `${prefix}policyIsMember/alpha/board`, {
    topic: 'updated',
  });
  const nonMemberWriteDenied = await trySet(clients, userBDb, `${prefix}policyIsMember/alpha/board`, {
    topic: 'blocked',
  });

  const allRequiredPresentAllowed = await trySet(clients, userADb, `${prefix}policyRequired/r1`, {
    title: 'match',
    score: 10,
    puck: { x: 4, y: 8 },
  });
  const missingTopLevelKeyDenied = await trySet(clients, userADb, `${prefix}policyRequired/r2`, {
    title: 'match',
    puck: { x: 4, y: 8 },
  });
  const missingNestedSlashPathDenied = await trySet(clients, userADb, `${prefix}policyRequired/r3`, {
    title: 'match',
    score: 10,
    puck: { x: 4 },
  });

  const unlistedOpenToFinishedDenied = await trySet(clients, userADb, `${prefix}policyTransition/g1`, {
    status: 'finished',
  });
  const allowedOpenToPlayingAllowed = await trySet(clients, userADb, `${prefix}policyTransition/g1`, {
    status: 'playing',
  });
  const reversePlayingToOpenDenied = await trySet(clients, userADb, `${prefix}policyTransition/g1`, {
    status: 'open',
  });
  const allowedPlayingToFinishedAllowed = await trySet(clients, userADb, `${prefix}policyTransition/g1`, {
    status: 'finished',
  });

  return {
    pathOwnerOnly: {
      unauthedWriteDenied,
      ownerWriteAllowed,
      otherUserWriteDenied,
      ownerReadAllowed,
    },
    fieldOwnerOnly: {
      unauthedReadDenied,
      ownerUpdateAllowed,
      otherUserUpdateDenied,
      freshCreateWithoutExistingOwnerDenied,
    },
    ownerOrNew: {
      unauthedCreateDenied,
      authedCreateNewAllowed,
      otherUserEditExistingDenied,
      fieldOwnerEditExistingAllowed,
    },
    hasRole: {
      moderatorWriteAllowed,
      guestWriteDenied,
      unauthedWriteDenied: hasRoleUnauthedWriteDenied,
    },
    isMember: {
      memberReadAllowed,
      nonMemberReadDenied,
      memberWriteAllowed,
      nonMemberWriteDenied,
    },
    required: {
      allRequiredPresentAllowed,
      missingTopLevelKeyDenied,
      missingNestedSlashPathDenied,
    },
    transition: {
      unlistedOpenToFinishedDenied,
      allowedOpenToPlayingAllowed,
      reversePlayingToOpenDenied,
      allowedPlayingToFinishedAllowed,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: 'rtdb#85',
  rowIds: ['rtdb#85'],
  description:
    'Live RTDB Security Rules verdicts for rulesets compiled from all 7 composite policies helpers (pathOwnerOnly, fieldOwnerOnly, ownerOrNew, hasRole, isMember, required with single keys and nested slash paths, and transition).',
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
        const scopedRules = buildPoliciesScopedRules(['pyric_oracle', runId]);
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
            openClient('policies-user-a'),
            openClient('policies-user-b'),
          ]);
          const unauthedApp = initializeApp(
            { databaseURL: databaseUrl },
            `sdk-probe-policies-unauthed-${runId}`,
          );
          const unauthedDb = rtdbSdk.getDatabase(unauthedApp);

          try {
            return await observeRulesPoliciesVerdicts(
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
