import type { OracleRulesTarget } from '../../src/oracle-rules-session.ts';
import type { Probe } from '../../rigs/types.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const FIRESTORE_REAL_LOCK = '/tmp/pyric-firestore-real.lock';

export interface AnonymousListenerAuthTransitionSubject {
  seedAdminDoc(relPath: string, data: Record<string, unknown>): Promise<void>;
  isSignedIn(): boolean;
  signInAs(roleLabel: 'alice' | 'bob'): Promise<string>;
  subscribeDoc(
    relPath: string,
    onNext: (data: Record<string, unknown> | undefined) => void,
    onError: (code: string) => void,
  ): () => void;
}

export function buildAnonymousListenerRulesBlock(runId: string): string {
  return [
    `    // @pyric/oracle-anon-listener-${runId}`,
    `    match /__pyric_fs_probe/${runId} {`,
    `      match /__ready/{id} {`,
    `        allow read, write: if true;`,
    `      }`,
    `      match /public/{docId} {`,
    `        allow read: if true;`,
    `        allow write: if request.auth != null;`,
    `      }`,
    `      match /owned/{ownerId} {`,
    `        allow read, write: if request.auth != null && request.auth.uid == ownerId;`,
    `      }`,
    `    }`,
  ].join('\n');
}

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const shaped = err as { code?: unknown };
    if (typeof shaped.code === 'string') {
      return shaped.code;
    }
  }
  return 'unknown';
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    function tick(): void {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, pollMs);
    }
    tick();
  });
}

export async function observeFirestoreAnonymousListenerAuthTransition(
  subject: AnonymousListenerAuthTransitionSubject,
  waitTimeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const activeUnsubs: Array<() => void> = [];

  try {
    const signedInBeforeAttach = subject.isSignedIn();
    await subject.seedAdminDoc('public/item-1', { step: 0 });

    const publicSteps: number[] = [];
    let publicErrorCode: string | null = null;
    const stopPublic = subject.subscribeDoc(
      'public/item-1',
      (data) => {
        if (data !== undefined && typeof data.step === 'number') {
          publicSteps.push(data.step);
        }
      },
      (code) => {
        publicErrorCode = code;
      },
    );
    activeUnsubs.push(stopPublic);

    const sawInitialPublic = await waitForCondition(
      () => publicSteps.length >= 1 || publicErrorCode !== null,
      waitTimeoutMs,
    );

    const aliceUid = await subject.signInAs('alice');
    const signedInAfterSignIn = subject.isSignedIn();

    await subject.seedAdminDoc('public/item-1', { step: 1 });
    const sawPostSignInPublic = await waitForCondition(
      () => publicSteps.includes(1) || publicErrorCode !== null,
      waitTimeoutMs,
    );

    await subject.seedAdminDoc(`owned/${aliceUid}`, { count: 0 });
    const ownedCounts: number[] = [];
    let ownedErrorCode: string | null = null;
    const stopOwned = subject.subscribeDoc(
      `owned/${aliceUid}`,
      (data) => {
        if (data !== undefined && typeof data.count === 'number') {
          ownedCounts.push(data.count);
        }
      },
      (code) => {
        ownedErrorCode = code;
      },
    );
    activeUnsubs.push(stopOwned);

    const sawInitialOwned = await waitForCondition(
      () => ownedCounts.length >= 1 || ownedErrorCode !== null,
      waitTimeoutMs,
    );

    await subject.signInAs('bob');
    await waitForCondition(() => ownedErrorCode !== null, waitTimeoutMs);
    await subject.seedAdminDoc(`owned/${aliceUid}`, { count: 1 });
    await waitForCondition(() => ownedCounts.includes(1), Math.min(400, waitTimeoutMs));

    await subject.seedAdminDoc('public/item-1', { step: 2 });
    const sawPostUserSwapPublic = await waitForCondition(
      () => publicSteps.includes(2) || publicErrorCode !== null,
      waitTimeoutMs,
    );

    return {
      publicAnonymousListenerAcrossSignIn: {
        signedInBeforeAttach,
        signedInAfterSignIn,
        sawInitialPublic,
        sawPostSignInPublic,
        sawPostUserSwapPublic,
        stepsObserved: publicSteps,
        errorCode: publicErrorCode,
      },
      ownerGatedListenerAcrossUserSwitch: {
        sawInitialOwned,
        countsObserved: ownedCounts,
        errorCodeAfterSwitch: ownedErrorCode,
      },
    };
  } finally {
    for (const unsub of activeUnsubs) {
      unsub();
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  matrixRow: 'firestore#88',
  rowIds: ['firestore#88'],
  description:
    'firebase/firestore onSnapshot listener registered while signed out keeps receiving updates across Auth sign-in and subsequent session user transitions, while an owner-gated listener loses access with permission-denied on user switch.',
  async observe(): Promise<Record<string, unknown>> {
    const [
      { deleteApp, initializeApp },
      { getAuth },
      { signInOracleClientAuth },
      fsSdk,
      adminAppMod,
      { getAuth: getAdminAuth },
      { getFirestore: getAdminFirestore },
      { loadOracleServiceAccount, oracleAccessToken, oracleAppOptions },
      { OracleRulesSession, runWithOracleRulesRestored },
      { installOracleSignalRestoreGuard },
      { resolveProbeWebConfig },
      { acquireRunLock },
    ] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('../../src/oracle-run-auth-session.ts'),
      import('firebase/firestore'),
      import('firebase-admin/app'),
      import('firebase-admin/auth'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
      import('../../src/oracle-rules-session.ts'),
      import('../../src/oracle-signal-restore.ts'),
      import('../../src/sdk-probe-runtime.ts'),
      import('../../src/storage-stdlib-real-lock.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const runId = `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `__pyric_fs_probe/${runId}`;
    const block = buildAnonymousListenerRulesBlock(runId);
    const target: OracleRulesTarget = {
      service: 'Firestore',
      release: 'cloud.firestore',
      rulesFileName: 'firestore.rules',
      marker: `@pyric/oracle-anon-listener-${runId}`,
      freshRules: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`,
      insertAfter: /(match\s+\/databases\/\{database\}\/documents\s*\{)/,
      insertAfterDescription: '`match /databases/{database}/documents`',
      block: `\n${block}\n`,
    };

    const releaseLock = acquireRunLock(FIRESTORE_REAL_LOCK);
    const session = new OracleRulesSession({
      projectId: sa.project_id,
      accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
    });
    const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () =>
      session.restoreAll(),
    );

    const clientApp = initializeApp(webConfig, `sdk-probe-al-client-${runId}`);
    const clientAuth = getAuth(clientApp);
    const clientDb = fsSdk.getFirestore(clientApp);
    const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-al-admin-${runId}`);
    const adminAuth = getAdminAuth(adminApp);
    const adminDb = getAdminFirestore(adminApp);
    const createdUids = new Set<string>();

    try {
      return await runWithOracleRulesRestored(session, async () => {
        await session.deploy(target);
        try {
          const deadline = Date.now() + 90_000;
          let consecutiveReady = 0;
          let round = 0;
          while (consecutiveReady < 5) {
            if (Date.now() > deadline) {
              throw new Error('Timed out waiting for anonymous-listener rules propagation');
            }
            round += 1;
            try {
              await fsSdk.setDoc(fsSdk.doc(clientDb, `${basePath}/__ready/probe`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(clientDb, `${basePath}/__ready/probe`));
              consecutiveReady += 1;
            } catch {
              consecutiveReady = 0;
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          await new Promise((resolve) => setTimeout(resolve, 15_000));

          const subject: AnonymousListenerAuthTransitionSubject = {
            async seedAdminDoc(relPath: string, data: Record<string, unknown>): Promise<void> {
              await adminDb.doc(`${basePath}/${relPath}`).set(data);
            },
            isSignedIn(): boolean {
              return clientAuth.currentUser !== null;
            },
            async signInAs(roleLabel: 'alice' | 'bob'): Promise<string> {
              await signInOracleClientAuth(clientAuth, sa, `sdk-al-${roleLabel}-${runId}`);
              const current = clientAuth.currentUser;
              if (!current) {
                throw new Error(`Expected signed-in user for ${roleLabel}`);
              }
              await current.getIdToken(true);
              createdUids.add(current.uid);
              return current.uid;
            },
            subscribeDoc(relPath, onNext, onError) {
              return fsSdk.onSnapshot(
                fsSdk.doc(clientDb, `${basePath}/${relPath}`),
                (snap) => {
                  onNext(snap.data() as Record<string, unknown> | undefined);
                },
                (err) => {
                  onError(errorCodeOf(err));
                },
              );
            },
          };

          return await observeFirestoreAnonymousListenerAuthTransition(subject);
        } finally {
          await fsSdk.terminate(clientDb).catch(() => undefined);
          await deleteApp(clientApp).catch(() => undefined);
          for (const uid of createdUids) {
            await adminAuth.deleteUser(uid).catch(() => undefined);
          }
          await adminDb.recursiveDelete(adminDb.doc(basePath)).catch(() => undefined);
          await adminAppMod.deleteApp(adminApp).catch(() => undefined);
        }
      });
    } finally {
      detachSignals();
      releaseLock();
    }
  },
};
