import { describe, expect, it } from 'bun:test';
import type * as fdb from 'firebase/database';
import { deleteApp, initializeApp } from '../../../src/app/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  connectDatabaseEmulator,
  enableLogging,
  get,
  getDatabase,
  goOffline,
  onValue,
  ref,
  refFromURL,
  runTransaction,
  sandbox as rtdbSandbox,
  set,
} from '../../../src/database/index.js';
import {
  observeClientEmulatorContract,
  observeClientLoggingContract,
  type ClientEmulatorAndLoggingObservation,
  type ClientEmulatorHandle,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-client-emulator-and-logging.ts';
import { load } from './oracle-conformance.support.js';

describe('oracle conformance (rtdb-modular): client emulator & logging (in-process)', () => {
  it('replays rtdb-modular-client-emulator-and-logging (#173, #M32, #165)', async () => {
    const observed = load(
      'rtdb-modular-client-emulator-and-logging.json',
    ) as unknown as ClientEmulatorAndLoggingObservation;

    const sandbox = initializeSandbox({ projectId: 'demo-oracle-inproc' });
    const mainDb = getDatabase(sandbox);
    rtdbSandbox.setDefaultPolicy(mainDb, 'allow');

    const logging = await observeClientLoggingContract({
      db: mainDb as unknown as fdb.Database,
      basePath: '/pyric_oracle/inproc_replay',
      enableLogging,
      ref: ref as unknown as typeof fdb.ref,
      get: get as unknown as typeof fdb.get,
      set: set as unknown as typeof fdb.set,
      onValue: onValue as unknown as typeof fdb.onValue,
      runTransaction: runTransaction as unknown as typeof fdb.runTransaction,
    });

    let seq = 0;
    const emulator = await observeClientEmulatorContract({
      openHandle(suffix: string): ClientEmulatorHandle {
        seq += 1;
        const app = initializeApp(
          {
            projectId: 'demo-oracle-inproc',
            databaseURL: 'https://demo-oracle-inproc-default-rtdb.firebaseio.com',
          },
          `inproc-emu-${seq}-${suffix}`,
        );
        const emuDb = getDatabase(app);
        return {
          db: emuDb as unknown as fdb.Database,
          goOffline() {
            goOffline(emuDb);
          },
          async deleteHandle() {
            await deleteApp(app);
          },
        };
      },
      connectDatabaseEmulator: connectDatabaseEmulator as unknown as typeof fdb.connectDatabaseEmulator,
      ref: ref as unknown as typeof fdb.ref,
      refFromURL: refFromURL as unknown as typeof fdb.refFromURL,
    });

    expect({ logging, emulator }).toEqual(observed);
  });

  it('enforces mockUserToken object and JWT claims in RTDB Security Rules (#165)', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-mock-token-rules' });
    const adminSeedDb = getDatabase(sandbox);
    rtdbSandbox.setRules(adminSeedDb, {
      rules: {
        users: {
          $uid: {
            '.read': 'auth != null && auth.uid === $uid',
            '.write': 'auth != null && auth.uid === $uid',
          },
        },
        verified: {
          '.read': "auth != null && auth.token.email === 'alice@example.com'",
          '.write': "auth != null && auth.token.email === 'alice@example.com'",
        },
      },
    });

    const aliceDb = getDatabase(sandbox.withAuth(null));
    connectDatabaseEmulator(aliceDb, '127.0.0.1', 9000, {
      mockUserToken: { sub: 'alice', email: 'alice@example.com' },
    });

    const bobDb = getDatabase(sandbox.withAuth(null));
    connectDatabaseEmulator(bobDb, '127.0.0.1', 9000, {
      mockUserToken: { user_id: 'bob' },
    });

    const jwtPayload = btoa(JSON.stringify({ sub: 'carol', user_id: 'carol' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const carolJwt = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${jwtPayload}.`;
    const carolDb = getDatabase(sandbox.withAuth(null));
    connectDatabaseEmulator(carolDb, '127.0.0.1', 9000, {
      mockUserToken: carolJwt,
    });

    const anonDb = getDatabase(sandbox.withAuth(null));
    connectDatabaseEmulator(anonDb, '127.0.0.1', 9000);

    await set(ref(aliceDb, 'users/alice'), { role: 'owner' });
    await set(ref(aliceDb, 'verified/flag'), true);
    expect((await get(ref(aliceDb, 'users/alice'))).val()).toEqual({ role: 'owner' });
    expect((await get(ref(aliceDb, 'verified/flag'))).val()).toBe(true);

    await set(ref(bobDb, 'users/bob'), { role: 'member' });
    expect((await get(ref(bobDb, 'users/bob'))).val()).toEqual({ role: 'member' });
    await expect(get(ref(bobDb, 'users/alice'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(get(ref(bobDb, 'verified/flag'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    await set(ref(carolDb, 'users/carol'), { via: 'jwt' });
    expect((await get(ref(carolDb, 'users/carol'))).val()).toEqual({ via: 'jwt' });

    await expect(get(ref(anonDb, 'users/alice'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});
