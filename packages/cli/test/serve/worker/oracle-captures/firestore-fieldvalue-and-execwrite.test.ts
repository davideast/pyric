import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, FirebaseError, getApps, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  ensureFirestoreConfigured as workerEnsureFirestoreConfigured,
  executeWrite as workerExecuteWrite,
} from '../../../../src/serve/worker/client/firestore-lifecycle.js';
import * as client from '../../../../src/serve/worker/index.js';
import {
  observeFirestoreEnsureConfiguredAndExecuteWrite,
  type EnsureConfiguredAndExecuteWriteSubject,
} from '../../../../../conformance/probes/firestore/firestore-ensure-configured-and-execute-write.ts';
import {
  observeFirestoreFieldValueClassAndEquality,
} from '../../../../../conformance/probes/firestore/firestore-field-value-class-and-equality.ts';
import { makeHostCtx } from '../integration-support.js';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import {
  load,
  loadServedFirestoreSurface,
  restoreSharedWorker,
  type ServedFirestoreSurface,
} from './support.ts';

restoreSharedWorker();

async function cleanApps(): Promise<void> {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  resetAppRegistryForTests();
}

beforeEach(cleanApps);
afterEach(cleanApps);

describe('served and hosted 3-plane oracle replay: FieldValue and ensureFirestoreConfigured/executeWrite', () => {
  it('replays firestore-field-value-class-and-equality over served SharedWorker surface (firestore#105)', async () => {
    const surface = await loadServedFirestoreSurface();
    const observed = load('firestore-field-value-class-and-equality');
    const actual = observeFirestoreFieldValueClassAndEquality({
      FieldValue: surface.FieldValue,
      deleteField: () => surface.deleteField(),
      serverTimestamp: () => surface.serverTimestamp(),
      increment: (n: number) => surface.increment(n),
      arrayUnion: (...elements: unknown[]) => surface.arrayUnion(...elements),
      arrayRemove: (...elements: unknown[]) => surface.arrayRemove(...elements),
      vector: (values?: number[]) => surface.vector(values),
    });

    expect(actual).toEqual(observed);
  });

  it('replays firestore-field-value-class-and-equality over worker/hosted client surface (firestore#105)', async () => {
    const surface = await loadServedFirestoreSurface();
    const observed = load('firestore-field-value-class-and-equality');
    const actual = observeFirestoreFieldValueClassAndEquality({
      FieldValue: surface.FieldValue,
      deleteField: () => client.deleteField(),
      serverTimestamp: () => client.serverTimestamp(),
      increment: (n: number) => client.increment(n),
      arrayUnion: (...elements: unknown[]) => client.arrayUnion(...elements),
      arrayRemove: (...elements: unknown[]) => client.arrayRemove(...elements),
      vector: (values?: number[]) => surface.vector(values),
    });

    expect(actual).toEqual(observed);
  });

  it('replays firestore-ensure-configured-and-execute-write over served SharedWorker surface (firestore#156)', async () => {
    const observed = load('firestore-ensure-configured-and-execute-write');
    const host = await makeHostCtx();
    try {
      const surface = await loadServedFirestoreSurface(host);
      const subject: EnsureConfiguredAndExecuteWriteSubject<
        ReturnType<typeof initializeApp>,
        ReturnType<ServedFirestoreSurface['getFirestore']>
      > = {
        createApp(name: string) {
          return initializeApp({ projectId: 'demo-served-plumbing' }, name);
        },
        deleteApp(app) {
          return deleteApp(app);
        },
        getFirestore(app) {
          return surface.getFirestore(app);
        },
        ensureFirestoreConfigured(db) {
          return surface.ensureFirestoreConfigured(db);
        },
        executeWrite(db, mutations: unknown[]) {
          return surface.executeWrite(db, mutations);
        },
        connectEmulator(db, host: string, port: number) {
          surface.connectFirestoreEmulator(db, host, port);
        },
        terminate(db) {
          return surface.terminate(db);
        },
        isFirebaseError(err: unknown): boolean {
          return err instanceof FirebaseError;
        },
      };

      const actual = await observeFirestoreEnsureConfiguredAndExecuteWrite(subject);
      expect(actual).toEqual(observed);
    } finally {
      host.sandbox.dispose();
    }
  });

  it('replays firestore-ensure-configured-and-execute-write over Node host loopback WebSocket (firestore#156)', async () => {
    const observed = load('firestore-ensure-configured-and-execute-write');
    const ctx = await hostedFirestoreContext();
    const hostedDbs = new Map<string, client.ClientDb>();
    for (const tag of ['configured', 'exec', 'terminated']) {
      const opened = await ctx.newClient(`cfg-ew-${tag}`);
      hostedDbs.set(tag, opened.db as unknown as client.ClientDb);
    }

    const subject: EnsureConfiguredAndExecuteWriteSubject<string, client.ClientDb> = {
      createApp(name: string) {
        return name;
      },
      async deleteApp() {},
      getFirestore(appName: string) {
        for (const [tag, db] of hostedDbs) {
          if (appName.includes(`fs-cfg-ew-${tag}-`)) {
            return db;
          }
        }
        throw new Error(`Missing pre-opened hosted client for ${appName}`);
      },
      ensureFirestoreConfigured(db) {
        return workerEnsureFirestoreConfigured(db);
      },
      executeWrite(db, mutations: unknown[]) {
        return workerExecuteWrite(db, mutations);
      },
      connectEmulator(db, host: string, port: number) {
        client.connectFirestoreEmulator(db, host, port);
      },
      terminate(db) {
        return client.terminate(db);
      },
      isFirebaseError(err: unknown): boolean {
        return err instanceof FirebaseError;
      },
    };

    const actual = await observeFirestoreEnsureConfiguredAndExecuteWrite(subject);
    expect(actual).toEqual(observed);
  });
});
