import type { DataSnapshot as AdminDataSnapshot, Database as AdminDatabase } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

function waitForValueMatch(
  targetRef: ReturnType<AdminDatabase['ref']>,
  predicate: (snap: AdminDataSnapshot) => boolean,
  label: string,
  timeoutMs = 10_000,
): { ready: Promise<void>; detach(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: ((snap: AdminDataSnapshot) => void) | undefined;
  const detach = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (listener !== undefined) {
      targetRef.off('value', listener);
      listener = undefined;
    }
  };
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      detach();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    listener = (snap: AdminDataSnapshot) => {
      if (predicate(snap)) {
        detach();
        resolve();
      }
    };
    targetRef.on('value', listener, (err: Error) => {
      detach();
      reject(err);
    });
  });
  return { ready, detach };
}

export async function observeAdminConnectionAndOnDisconnect(
  writerDb: Pick<AdminDatabase, 'ref' | 'goOffline' | 'goOnline'>,
  observerDb: Pick<AdminDatabase, 'ref'>,
  basePath: string,
): Promise<{
  beforeGoOffline: {
    s1Val: unknown;
    ephemeralExists: boolean;
    cancelledVal: unknown;
  };
  afterFirstGoOffline: {
    s1Val: unknown;
    s2Val: unknown;
    prioVal: unknown;
    prioPriority: string | number | null;
    ephemeralExists: boolean;
    cancelledVal: unknown;
  };
  afterGoOnlineAndSecondGoOfflineWithoutRequeue: {
    reconnectedWriteVal: unknown;
    remainedUnchangedOnSecondGoOffline: unknown;
  };
}> {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'adminDisconnect';
  if (cleanBase) {
    scope = `${cleanBase}/adminDisconnect`;
  }

  const writerS1 = writerDb.ref(`${scope}/s1`);
  const writerS2 = writerDb.ref(`${scope}/s2`);
  const writerPrio = writerDb.ref(`${scope}/prioNode`);
  const writerEphemeral = writerDb.ref(`${scope}/ephemeral`);
  const writerCancelled = writerDb.ref(`${scope}/cancelled`);

  await Promise.all([
    writerS1.set({ state: 'online', retries: 1 }),
    writerS2.set({ state: 'online', keep: 'yes', obsolete: true }),
    writerPrio.set('online-val'),
    writerEphemeral.set({ holder: 'w1' }),
    writerCancelled.set({ keep: 'untouched' }),
  ]);

  await writerS1.onDisconnect().set({ state: 'draft' });
  await writerS1.onDisconnect().set({ state: 'offline' });
  await writerS2.onDisconnect().update({
    state: 'disconnected',
    obsolete: null,
    'meta/reason': 'goOffline',
  });
  await writerPrio.onDisconnect().setWithPriority('offline-prio', 42);
  await writerEphemeral.onDisconnect().remove();
  await writerCancelled.onDisconnect().set({ keep: 'mutated' });
  await writerCancelled.onDisconnect().cancel();

  const observerS1 = observerDb.ref(`${scope}/s1`);
  const observerS2 = observerDb.ref(`${scope}/s2`);
  const observerPrio = observerDb.ref(`${scope}/prioNode`);
  const observerEphemeral = observerDb.ref(`${scope}/ephemeral`);
  const observerCancelled = observerDb.ref(`${scope}/cancelled`);

  const [preS1, preEph, preCanc] = await Promise.all([
    observerS1.get(),
    observerEphemeral.get(),
    observerCancelled.get(),
  ]);

  const offlineWaiter = waitForValueMatch(
    observerS1,
    (snap) => {
      const v = snap.val() as { state?: unknown } | null;
      return v !== null && typeof v === 'object' && v.state === 'offline';
    },
    'writer goOffline() OnDisconnect execution on s1',
  );
  try {
    writerDb.goOffline();
    await offlineWaiter.ready;
  } finally {
    offlineWaiter.detach();
  }

  const [postS1, postS2, postPrio, postEph, postCanc] = await Promise.all([
    observerS1.get(),
    observerS2.get(),
    observerPrio.get(),
    observerEphemeral.get(),
    observerCancelled.get(),
  ]);

  writerDb.goOnline();
  await writerS1.set({ state: 'reconnected' });
  const reconnectedSnap = await observerS1.get();

  const sentinelRef = writerDb.ref(`${scope}/secondCycleSentinel`);
  await sentinelRef.set({ phase: 'armed' });
  await sentinelRef.onDisconnect().set({ phase: 'drained-2' });

  const observerSentinel = observerDb.ref(`${scope}/secondCycleSentinel`);
  const secondOfflineWaiter = waitForValueMatch(
    observerSentinel,
    (snap) => {
      const v = snap.val() as { phase?: unknown } | null;
      return v !== null && typeof v === 'object' && v.phase === 'drained-2';
    },
    'second writer goOffline() sentinel execution',
  );
  try {
    writerDb.goOffline();
    await secondOfflineWaiter.ready;
  } finally {
    secondOfflineWaiter.detach();
  }

  const s1AfterSecondOffline = await observerS1.get();
  writerDb.goOnline();

  return {
    beforeGoOffline: {
      s1Val: preS1.val(),
      ephemeralExists: preEph.exists(),
      cancelledVal: preCanc.val(),
    },
    afterFirstGoOffline: {
      s1Val: postS1.val(),
      s2Val: postS2.val(),
      prioVal: postPrio.val(),
      prioPriority: postPrio.getPriority(),
      ephemeralExists: postEph.exists(),
      cancelledVal: postCanc.val(),
    },
    afterGoOnlineAndSecondGoOfflineWithoutRequeue: {
      reconnectedWriteVal: reconnectedSnap.val(),
      remainedUnchangedOnSecondGoOffline: s1AfterSecondOffline.val(),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'firebase-admin/database goOffline()/goOnline() and Reference.onDisconnect(): observes queued set, setWithPriority, multi-path update, remove, and cancel() across two live admin handles, plus one-shot drain semantics after goOnline() reconnect.',
  matrixRow: 'rtdb-admin#6',
  rowIds: ['rtdb-admin#6'],
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl }) => {
      const [adminAppMod, { getDatabaseWithUrl }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/database'),
      ]);
      const sa = await loadOracleServiceAccount();
      const makeCredential = () => ({
        getAccessToken: async () => ({
          access_token: await oracleAccessToken(sa, RTDB_RULES_SCOPE),
          expires_in: 3600,
        }),
      });
      const writerApp = adminAppMod.initializeApp(
        {
          credential: makeCredential(),
          projectId: sa.project_id,
          databaseURL: databaseUrl,
        },
        `sdk-probe-rtdb-admin-disc-writer-${runId}`,
      );
      const observerApp = adminAppMod.initializeApp(
        {
          credential: makeCredential(),
          projectId: sa.project_id,
          databaseURL: databaseUrl,
        },
        `sdk-probe-rtdb-admin-disc-observer-${runId}`,
      );
      const writerDb = getDatabaseWithUrl(databaseUrl, writerApp);
      const observerDb = getDatabaseWithUrl(databaseUrl, observerApp);
      try {
        return await observeAdminConnectionAndOnDisconnect(writerDb, observerDb, runPath);
      } finally {
        writerDb.goOffline();
        observerDb.goOffline();
        await Promise.all([
          adminAppMod.deleteApp(writerApp).catch(() => undefined),
          adminAppMod.deleteApp(observerApp).catch(() => undefined),
        ]);
      }
    });
  },
};
