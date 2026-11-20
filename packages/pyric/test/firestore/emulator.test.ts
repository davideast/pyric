import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, FirebaseError, getApps, initializeApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/internal.js';
import {
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  getFirestore,
  terminate,
  type ConnectFirestoreEmulatorOptions,
  type EmulatorMockTokenOptions,
} from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  resetAppRegistryForTests();
});

describe('connectFirestoreEmulator lifecycle and mockUserToken validation', () => {
  it('accepts pre-start host/port, repeat calls before start, and calls after doc()', () => {
    const app = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-prestart');
    const db = getFirestore(app);

    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFirestoreEmulator(db, '127.0.0.1', 8085);
    doc(db, 'items/alpha');

    const opts: ConnectFirestoreEmulatorOptions = { ssl: false };
    connectFirestoreEmulator(db, 'localhost', 8080, opts);
  });

  it('accepts string, { sub }, and { user_id } mockUserToken options and rejects empty objects', () => {
    const appA = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-jwt');
    connectFirestoreEmulator(getFirestore(appA), '127.0.0.1', 8080, {
      mockUserToken: 'custom-jwt-token',
    });

    const appB = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-sub');
    const subToken: EmulatorMockTokenOptions = { sub: 'user-alpha', role: 'member' };
    connectFirestoreEmulator(getFirestore(appB), '127.0.0.1', 8080, {
      mockUserToken: subToken,
    });

    const appC = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-uid');
    connectFirestoreEmulator(getFirestore(appC), '127.0.0.1', 8080, {
      mockUserToken: { user_id: 'user-beta' },
    });

    const appD = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-empty');
    let caught: unknown = null;
    try {
      connectFirestoreEmulator(getFirestore(appD), '127.0.0.1', 8080, {
        mockUserToken: {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof FirebaseError).toBe(false);
    expect((caught as Error).message).toContain('sub');
    expect((caught as Error).message).toContain('user_id');
  });

  it('rejects with FirebaseError failed-precondition after client start or terminate', async () => {
    const app = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-started');
    const db = getFirestore(app);
    await disableNetwork(db);

    let startedErr: unknown = null;
    try {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
    } catch (err) {
      startedErr = err;
    }
    expect(startedErr).toBeInstanceOf(FirebaseError);
    expect((startedErr as FirebaseError).code).toBe('failed-precondition');

    const termApp = initializeApp({ projectId: 'demo-emulator-unit' }, 'emu-terminated');
    const termDb = getFirestore(termApp);
    await terminate(termDb);

    let termErr: unknown = null;
    try {
      connectFirestoreEmulator(termDb, '127.0.0.1', 8080);
    } catch (err) {
      termErr = err;
    }
    expect(termErr).toBeInstanceOf(FirebaseError);
    expect((termErr as FirebaseError).code).toBe('failed-precondition');
  });
});
