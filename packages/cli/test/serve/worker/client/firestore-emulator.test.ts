import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient } from '../integration-support.js';
import { restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

async function freshWorkerDb(): Promise<client.ClientDb> {
  const { db } = await connectClient();
  return db;
}

describe('worker client connectFirestoreEmulator', () => {
  it('accepts pre-start host/port, repeat calls before start, and calls after doc()', async () => {
    const db = await freshWorkerDb();
    client.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    client.connectFirestoreEmulator(db, '127.0.0.1', 8085);
    client.doc(db, 'items/alpha');
    client.connectFirestoreEmulator(db, 'localhost', 8080, { ssl: false });
  });

  it('validates mockUserToken options identically to firebase/firestore', async () => {
    client.connectFirestoreEmulator(await freshWorkerDb(), '127.0.0.1', 8080, {
      mockUserToken: 'custom-jwt-token',
    });
    client.connectFirestoreEmulator(await freshWorkerDb(), '127.0.0.1', 8080, {
      mockUserToken: { sub: 'user-alpha' },
    });
    client.connectFirestoreEmulator(await freshWorkerDb(), '127.0.0.1', 8080, {
      mockUserToken: { user_id: 'user-beta' },
    });

    let emptyErr: unknown = null;
    try {
      client.connectFirestoreEmulator(await freshWorkerDb(), '127.0.0.1', 8080, {
        mockUserToken: {},
      });
    } catch (err) {
      emptyErr = err;
    }
    expect(emptyErr).toBeInstanceOf(Error);
    expect(emptyErr instanceof FirebaseError).toBe(false);
    expect((emptyErr as Error).message).toContain('sub');
  });

  it('rejects with FirebaseError failed-precondition after disableNetwork or terminate', async () => {
    const db = await freshWorkerDb();
    await client.disableNetwork(db);

    let startedErr: unknown = null;
    try {
      client.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    } catch (err) {
      startedErr = err;
    }
    expect(startedErr).toBeInstanceOf(FirebaseError);
    expect((startedErr as FirebaseError).code).toBe('failed-precondition');

    const termDb = await freshWorkerDb();
    await client.terminate(termDb);
    let termErr: unknown = null;
    try {
      client.connectFirestoreEmulator(termDb, '127.0.0.1', 8080);
    } catch (err) {
      termErr = err;
    }
    expect(termErr).toBeInstanceOf(FirebaseError);
    expect((termErr as FirebaseError).code).toBe('failed-precondition');
  });
});
