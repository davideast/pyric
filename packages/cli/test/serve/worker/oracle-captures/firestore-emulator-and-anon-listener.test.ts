import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, FirebaseError, getApps, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import * as client from '../../../../src/serve/worker/index.js';
import {
  observeFirestoreConnectEmulatorOptions,
  type ConnectFirestoreEmulatorSubject,
} from '../../../../../conformance/probes/firestore/firestore-connect-emulator-options.ts';
import {
  buildAnonymousListenerRulesBlock,
  observeFirestoreAnonymousListenerAuthTransition,
  type AnonymousListenerAuthTransitionSubject,
} from '../../../../../conformance/probes/firestore/firestore-anonymous-listener-auth-transition.ts';
import { makeHostCtx } from '../integration-support.js';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import {
  load,
  loadServedFirestoreSurface,
  restoreSharedWorker,
  servedFirestoreContext,
  type ServedFirestoreSurface,
} from './support.ts';

restoreSharedWorker();

async function resetApps(): Promise<void> {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  resetAppRegistryForTests();
}

beforeEach(resetApps);
afterEach(resetApps);

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const shaped = err as { code?: unknown };
    if (typeof shaped.code === 'string') {
      return shaped.code;
    }
  }
  return 'unknown';
}

describe('served and hosted 3-plane oracle replay: connectFirestoreEmulator and anonymous listener', () => {
  it('replays firestore-connect-emulator-options over served SharedWorker surface (firestore#120, #121)', async () => {
    const observed = load('firestore-connect-emulator-options');
    const host = await makeHostCtx();
    try {
      const surface = await loadServedFirestoreSurface(host);
      const subject: ConnectFirestoreEmulatorSubject<
        ReturnType<typeof initializeApp>,
        ReturnType<ServedFirestoreSurface['getFirestore']>
      > = {
        createApp(name: string) {
          return initializeApp({ projectId: 'demo-served-emulator' }, name);
        },
        deleteApp(app) {
          return deleteApp(app);
        },
        getFirestore(app) {
          return surface.getFirestore(app);
        },
        createDocRef(db, path: string) {
          return surface.doc(db, path);
        },
        disableNetwork(db) {
          return surface.disableNetwork(db);
        },
        terminate(db) {
          return surface.terminate(db);
        },
        connectEmulator(db, host: string, port: number, options?: Record<string, unknown>) {
          surface.connectFirestoreEmulator(db, host, port, options);
        },
        isFirebaseError(err: unknown): boolean {
          return err instanceof FirebaseError;
        },
      };

      const actual = await observeFirestoreConnectEmulatorOptions(subject);
      expect(actual).toEqual(observed);
    } finally {
      host.sandbox.dispose();
    }
  });

  it('replays firestore-connect-emulator-options over Node host loopback WebSocket (firestore#120, #121)', async () => {
    const observed = load('firestore-connect-emulator-options');
    const ctx = await hostedFirestoreContext();
    const subject: ConnectFirestoreEmulatorSubject<string, client.ClientDb> = {
      createApp(name: string) {
        return name;
      },
      async deleteApp() {},
      getFirestore() {
        throw new Error('unused');
      },
      createDocRef(db, path: string) {
        return client.doc(db, path);
      },
      disableNetwork(db) {
        return client.disableNetwork(db);
      },
      terminate(db) {
        return client.terminate(db);
      },
      connectEmulator(db, host: string, port: number, options?: Record<string, unknown>) {
        client.connectFirestoreEmulator(db, host, port, options);
      },
      isFirebaseError(err: unknown): boolean {
        return err instanceof FirebaseError;
      },
    };
    const hostedDbs = new Map<string, client.ClientDb>();
    for (const tag of ['basic', 'doc-first', 'jwt-str', 'sub-obj', 'uid-obj', 'empty-obj', 'started']) {
      const opened = await ctx.newClient(`emu-${tag}`);
      hostedDbs.set(tag, opened.db as unknown as client.ClientDb);
    }
    subject.getFirestore = (appName: string) => {
      for (const [tag, db] of hostedDbs) {
        if (appName.includes(`fs-emu-${tag}-`)) {
          return db;
        }
      }
      throw new Error(`Missing pre-opened hosted client for ${appName}`);
    };

    const actual = await observeFirestoreConnectEmulatorOptions(subject);
    expect(actual).toEqual(observed);
  });

  const AUTH_PLANES = [
    { name: 'SharedWorker client+host', open: () => servedFirestoreContext() },
    { name: 'Node host loopback WebSocket', open: () => hostedFirestoreContext() },
  ] as const;

  for (const plane of AUTH_PLANES) {
    it(`replays firestore-anonymous-listener-auth-transition over ${plane.name} (firestore#88)`, async () => {
      const observed = load('firestore-anonymous-listener-auth-transition');
      const ctx = await plane.open();
      const runId = 'worker_anon_listener_replay';
      const basePath = `__pyric_fs_probe/${runId}`;
      const block = buildAnonymousListenerRulesBlock(runId);
      const rules = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`;

      const clientDb = ctx.db as unknown as client.ClientDb;
      await client.setFirestoreRules(clientDb, rules);
      const auth = client.getAuth(clientDb);
      await client.signOut(auth);

      const password = 'replay-password-123';
      await client.adminCreateUser(auth, {
        uid: 'served-alice-uid',
        email: 'alice@example.test',
        password,
      });
      await client.adminCreateUser(auth, {
        uid: 'served-bob-uid',
        email: 'bob@example.test',
        password,
      });

      let signedIn = false;
      const subject: AnonymousListenerAuthTransitionSubject = {
        async seedAdminDoc(relPath: string, data: Record<string, unknown>): Promise<void> {
          await client.adminSetDocument(clientDb, `${basePath}/${relPath}`, data);
        },
        isSignedIn(): boolean {
          return signedIn;
        },
        async signInAs(roleLabel: 'alice' | 'bob'): Promise<string> {
          let email = 'bob@example.test';
          let uid = 'served-bob-uid';
          if (roleLabel === 'alice') {
            email = 'alice@example.test';
            uid = 'served-alice-uid';
          }
          await client.signInWithEmailAndPassword(auth, email, password);
          signedIn = true;
          return uid;
        },
        subscribeDoc(relPath, onNext, onError) {
          return client.onSnapshot(
            client.doc(clientDb, `${basePath}/${relPath}`),
            (snap) => {
              onNext(snap.data() as Record<string, unknown> | undefined);
            },
            (err) => {
              onError(errorCodeOf(err));
            },
          );
        },
      };

      const actual = await observeFirestoreAnonymousListenerAuthTransition(subject, 3_000);
      expect(actual).toEqual(observed);
    });
  }
});
