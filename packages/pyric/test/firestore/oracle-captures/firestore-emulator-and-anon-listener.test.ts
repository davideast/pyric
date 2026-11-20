import { afterEach, describe, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { deleteApp, FirebaseError, getApps, initializeApp } from '../../../src/app/index.js';
import { resetAppRegistryForTests } from '../../../src/app/internal.js';
import {
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  getFirestore,
  onSnapshot,
  terminate,
  type ConnectFirestoreEmulatorOptions,
  type DocumentSnapshot,
} from '../../../src/firestore/index.js';
import {
  observeFirestoreConnectEmulatorOptions,
  type ConnectFirestoreEmulatorSubject,
} from '../../../../conformance/probes/firestore/firestore-connect-emulator-options.ts';
import {
  buildAnonymousListenerRulesBlock,
  observeFirestoreAnonymousListenerAuthTransition,
  type AnonymousListenerAuthTransitionSubject,
} from '../../../../conformance/probes/firestore/firestore-anonymous-listener-auth-transition.ts';
import { expectReplay, load } from './support.ts';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  resetAppRegistryForTests();
});

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const shaped = err as { code?: unknown };
    if (typeof shaped.code === 'string') {
      return shaped.code;
    }
  }
  return 'unknown';
}

describe('in-page oracle replay: connectFirestoreEmulator and anonymous listener auth transitions', () => {
  it('replays firestore-connect-emulator-options with zero pins (firestore#120, #121)', async () => {
    const observed = load('firestore-connect-emulator-options');
    const subject: ConnectFirestoreEmulatorSubject<
      ReturnType<typeof initializeApp>,
      ReturnType<typeof getFirestore>
    > = {
      createApp(name: string) {
        return initializeApp({ projectId: 'demo-emulator-replay' }, name);
      },
      deleteApp(app) {
        return deleteApp(app);
      },
      getFirestore(app) {
        return getFirestore(app);
      },
      createDocRef(db, path: string) {
        return doc(db, path);
      },
      disableNetwork(db) {
        return disableNetwork(db);
      },
      terminate(db) {
        return terminate(db);
      },
      connectEmulator(db, host: string, port: number, options?: Record<string, unknown>) {
        connectFirestoreEmulator(db, host, port, options as ConnectFirestoreEmulatorOptions);
      },
      isFirebaseError(err: unknown): boolean {
        return err instanceof FirebaseError;
      },
    };

    const actual = await observeFirestoreConnectEmulatorOptions(subject);
    expectReplay({ production: observed, pyric: actual, pins: [] });
  });

  it('replays firestore-anonymous-listener-auth-transition with zero pins (firestore#88)', async () => {
    const observed = load('firestore-anonymous-listener-auth-transition');
    const runId = 'inpage_anon_listener_replay';
    const basePath = `__pyric_fs_probe/${runId}`;
    const block = buildAnonymousListenerRulesBlock(runId);
    const rules = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`;

    const sandbox = initializeSandbox();
    try {
      setRules(sandbox, rules);
      sandbox.currentUser = null;
      const db = getFirestore(sandbox);

      const subject: AnonymousListenerAuthTransitionSubject = {
        async seedAdminDoc(relPath: string, data: Record<string, unknown>): Promise<void> {
          sandbox.admin.setDocument(`${basePath}/${relPath}`, data);
        },
        isSignedIn(): boolean {
          return sandbox.currentUser !== null;
        },
        async signInAs(roleLabel: 'alice' | 'bob'): Promise<string> {
          const uid = `replay-${roleLabel}-uid`;
          sandbox.currentUser = { uid };
          return uid;
        },
        subscribeDoc(relPath, onNext, onError) {
          return onSnapshot(
            doc(db, `${basePath}/${relPath}`),
            (snap: unknown) => {
              const docSnap = snap as DocumentSnapshot;
              onNext(docSnap.data() as Record<string, unknown> | undefined);
            },
            (err) => {
              onError(errorCodeOf(err));
            },
          );
        },
      };

      const actual = await observeFirestoreAnonymousListenerAuthTransition(subject, 2_000);
      expectReplay({ production: observed, pyric: actual, pins: [] });
    } finally {
      sandbox.dispose();
    }
  });
});
