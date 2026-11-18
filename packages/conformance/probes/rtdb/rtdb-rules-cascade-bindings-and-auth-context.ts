import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface RulesVerdictOutcome {
  allowed: boolean;
  permissionDenied: boolean;
}

export interface RulesCascadeAuthClients {
  authedDb: Database;
  authedUid: string;
  unauthedDb: Database;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
}

function classifyRulesRejection(err: unknown): RulesVerdictOutcome {
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

async function attemptRead(
  getFn: typeof import('firebase/database').get,
  refFn: typeof import('firebase/database').ref,
  db: Database,
  path: string,
): Promise<RulesVerdictOutcome> {
  try {
    await getFn(refFn(db, path));
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyRulesRejection(err);
  }
}

async function attemptWrite(
  setFn: typeof import('firebase/database').set,
  refFn: typeof import('firebase/database').ref,
  db: Database,
  path: string,
  value: unknown,
): Promise<RulesVerdictOutcome> {
  try {
    await setFn(refFn(db, path), value);
    return { allowed: true, permissionDenied: false };
  } catch (err) {
    return classifyRulesRejection(err);
  }
}

export const CASCADE_BINDINGS_AUTH_RULES = {
  cascadingRead: {
    '.read': 'auth != null',
    childFalse: {
      '.read': false,
    },
  },
  cascadingWrite: {
    '.write': 'auth != null',
    childFalse: {
      '.write': false,
    },
  },
  users: {
    $userId: {
      profile: {
        '.read': '$userId === auth.uid',
        '.write': "$userId === auth.uid && newData.child('owner').val() === $userId",
      },
    },
  },
  unauthedOnly: {
    '.read': 'auth == null',
    '.write': 'auth == null',
  },
  providerBound: {
    '.read': "auth != null && auth.token.firebase.sign_in_provider === 'anonymous'",
    '.write': "auth != null && auth.token.firebase.sign_in_provider === 'anonymous'",
  },
} as const;

export async function observeRulesCascadeBindingsAndAuthContext(
  clients: RulesCascadeAuthClients,
  basePath: string,
  seedAdminData: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  ancestorCascadeOverridesChildFalse: {
    authedReadChildFalse: RulesVerdictOutcome;
    unauthedReadChildFalse: RulesVerdictOutcome;
    authedWriteChildFalse: RulesVerdictOutcome;
    unauthedWriteChildFalse: RulesVerdictOutcome;
  };
  pathVariableBindings: {
    ownUidMatchingOwnerWrite: RulesVerdictOutcome;
    ownUidMismatchedOwnerWrite: RulesVerdictOutcome;
    otherUidWrite: RulesVerdictOutcome;
    ownUidRead: RulesVerdictOutcome;
    otherUidRead: RulesVerdictOutcome;
  };
  authNullVsBoundToken: {
    unauthedOnAuthNullRead: RulesVerdictOutcome;
    unauthedOnAuthNullWrite: RulesVerdictOutcome;
    authedOnAuthNullRead: RulesVerdictOutcome;
    authedOnAuthNullWrite: RulesVerdictOutcome;
    authedAnonymousProviderRead: RulesVerdictOutcome;
    authedAnonymousProviderWrite: RulesVerdictOutcome;
    unauthedAnonymousProviderRead: RulesVerdictOutcome;
    unauthedAnonymousProviderWrite: RulesVerdictOutcome;
  };
}> {
  const { authedDb, authedUid, unauthedDb, ref, get, set } = clients;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  await seedAdminData('cascadingRead/childFalse', { secret: 'visible-via-parent' });
  await seedAdminData('users/other-fixed-uid/profile', { owner: 'other-fixed-uid' });
  await seedAdminData('unauthedOnly', { publicGuest: true });
  await seedAdminData('providerBound', { anonAllowed: true });

  const authedReadChildFalse = await attemptRead(
    get,
    ref,
    authedDb,
    `${prefix}cascadingRead/childFalse`,
  );
  const unauthedReadChildFalse = await attemptRead(
    get,
    ref,
    unauthedDb,
    `${prefix}cascadingRead/childFalse`,
  );
  const authedWriteChildFalse = await attemptWrite(
    set,
    ref,
    authedDb,
    `${prefix}cascadingWrite/childFalse`,
    { updated: true },
  );
  const unauthedWriteChildFalse = await attemptWrite(
    set,
    ref,
    unauthedDb,
    `${prefix}cascadingWrite/childFalse`,
    { updated: false },
  );

  const ownUidMatchingOwnerWrite = await attemptWrite(
    set,
    ref,
    authedDb,
    `${prefix}users/${authedUid}/profile`,
    { owner: authedUid },
  );
  const ownUidMismatchedOwnerWrite = await attemptWrite(
    set,
    ref,
    authedDb,
    `${prefix}users/${authedUid}/profile`,
    { owner: 'wrong-owner' },
  );
  const otherUidWrite = await attemptWrite(
    set,
    ref,
    authedDb,
    `${prefix}users/other-fixed-uid/profile`,
    { owner: 'other-fixed-uid' },
  );
  const ownUidRead = await attemptRead(get, ref, authedDb, `${prefix}users/${authedUid}/profile`);
  const otherUidRead = await attemptRead(
    get,
    ref,
    authedDb,
    `${prefix}users/other-fixed-uid/profile`,
  );

  const unauthedOnAuthNullRead = await attemptRead(get, ref, unauthedDb, `${prefix}unauthedOnly`);
  const unauthedOnAuthNullWrite = await attemptWrite(
    set,
    ref,
    unauthedDb,
    `${prefix}unauthedOnly`,
    { guestWrite: 1 },
  );
  const authedOnAuthNullRead = await attemptRead(get, ref, authedDb, `${prefix}unauthedOnly`);
  const authedOnAuthNullWrite = await attemptWrite(set, ref, authedDb, `${prefix}unauthedOnly`, {
    authedWrite: 1,
  });

  const authedAnonymousProviderRead = await attemptRead(
    get,
    ref,
    authedDb,
    `${prefix}providerBound`,
  );
  const authedAnonymousProviderWrite = await attemptWrite(
    set,
    ref,
    authedDb,
    `${prefix}providerBound`,
    { byAnon: true },
  );
  const unauthedAnonymousProviderRead = await attemptRead(
    get,
    ref,
    unauthedDb,
    `${prefix}providerBound`,
  );
  const unauthedAnonymousProviderWrite = await attemptWrite(
    set,
    ref,
    unauthedDb,
    `${prefix}providerBound`,
    { byGuest: true },
  );

  return {
    ancestorCascadeOverridesChildFalse: {
      authedReadChildFalse,
      unauthedReadChildFalse,
      authedWriteChildFalse,
      unauthedWriteChildFalse,
    },
    pathVariableBindings: {
      ownUidMatchingOwnerWrite,
      ownUidMismatchedOwnerWrite,
      otherUidWrite,
      ownUidRead,
      otherUidRead,
    },
    authNullVsBoundToken: {
      unauthedOnAuthNullRead,
      unauthedOnAuthNullWrite,
      authedOnAuthNullRead,
      authedOnAuthNullWrite,
      authedAnonymousProviderRead,
      authedAnonymousProviderWrite,
      unauthedAnonymousProviderRead,
      unauthedAnonymousProviderWrite,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Live RTDB Security Rules evaluation for upward grant cascading (ancestor true overriding child false), $userId path-variable binding, and auth == null vs auth.uid / auth.token.firebase.sign_in_provider context.',
  matrixRow: 'rtdb#61, rtdb#62, rtdb#63',
  rowIds: ['rtdb#61', 'rtdb#62', 'rtdb#63'],
  observe() {
    return withRtdbProbeSession(
      { runRules: { ...CASCADE_BINDINGS_AUTH_RULES }, authMode: 'anonymous' },
      async ({ runId, runPath, databaseUrl, rtdbSdk, openClient, adminWrite }) => {
        const [{ deleteApp, initializeApp }, authedClient] = await Promise.all([
          import('firebase/app'),
          openClient('authed-rules'),
        ]);
        const unauthedApp = initializeApp(
          { databaseURL: databaseUrl },
          `sdk-probe-unauthed-${runId}`,
        );
        const unauthedDb = rtdbSdk.getDatabase(unauthedApp);
        try {
          return await observeRulesCascadeBindingsAndAuthContext(
            {
              authedDb: authedClient.db,
              authedUid: authedClient.uid,
              unauthedDb,
              ref: rtdbSdk.ref,
              get: rtdbSdk.get,
              set: rtdbSdk.set,
            },
            runPath,
            adminWrite,
          );
        } finally {
          rtdbSdk.goOffline(unauthedDb);
          await deleteApp(unauthedApp).catch(() => undefined);
        }
      },
    );
  },
};
