import { describe, expect, it } from 'bun:test';
import type * as fdb from 'firebase/database';
import * as client from '../../../../src/serve/worker/index.js';
import { rtdbEnableLogging } from '../../../../src/serve/worker/client/rtdb-controls.js';
import { rtdbRefFromURL } from '../../../../src/serve/worker/client/rtdb-references.js';
import {
  observeClientEmulatorContract,
  observeClientLoggingContract,
  type ClientEmulatorAndLoggingObservation,
  type ClientEmulatorHandle,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-client-emulator-and-logging.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

type PlaneFactory = (
  databaseRules?: Record<string, unknown>,
) => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, PlaneFactory]> = [
  ['served SharedWorker', (databaseRules) => servedRtdbContext(databaseRules)],
  ['served Node host', (databaseRules) => hostedRtdbContext(databaseRules)],
];

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB client emulator & logging oracle capture (${planeLabel})`, () => {
    it('rtdb-modular-client-emulator-and-logging (#173, #M32, #165)', async () => {
      const observed = load(
        'rtdb-modular-client-emulator-and-logging',
      ) as unknown as ClientEmulatorAndLoggingObservation;

      const ctx = await createContext();
      const rtdb = ctx.rtdb as unknown as typeof fdb;

      const logging = await observeClientLoggingContract({
        db: ctx.db as unknown as fdb.Database,
        basePath: `${ctx.base}/emu_logging`,
        enableLogging: rtdbEnableLogging,
        ref: rtdb.ref,
        get: rtdb.get,
        set: rtdb.set,
        onValue: rtdb.onValue,
        runTransaction: rtdb.runTransaction,
      });

      const emulator = await observeClientEmulatorContract({
        async openHandle(suffix: string): Promise<ClientEmulatorHandle> {
          const opened = await ctx.newClient(`emu-${suffix}`);
          const emuDb = opened.db as unknown as client.ClientRtdb;
          return {
            db: emuDb as unknown as fdb.Database,
            goOffline() {
              client.rtdbGoOffline(emuDb);
            },
            async deleteHandle() {
              client.disconnectPort(emuDb.port);
            },
          };
        },
        connectDatabaseEmulator:
          client.rtdbConnectDatabaseEmulator as unknown as typeof fdb.connectDatabaseEmulator,
        ref: rtdb.ref,
        refFromURL: rtdbRefFromURL as unknown as typeof fdb.refFromURL,
      });

      expect({ logging, emulator }).toEqual(observed);
    });

    it('evaluates RTDB Security Rules under mockUserToken object and JWT options (#165)', async () => {
      const ctx = await createContext({
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
      const rtdb = ctx.rtdb as unknown as typeof fdb;

      const aliceClient = await ctx.newClient('mock-rules-alice');
      client.rtdbConnectDatabaseEmulator(
        aliceClient.db as unknown as client.ClientRtdb,
        '127.0.0.1',
        9000,
        { mockUserToken: { sub: 'alice', email: 'alice@example.com' } },
      );

      const bobClient = await ctx.newClient('mock-rules-bob');
      client.rtdbConnectDatabaseEmulator(
        bobClient.db as unknown as client.ClientRtdb,
        '127.0.0.1',
        9000,
        { mockUserToken: { user_id: 'bob' } },
      );

      const jwtPayload = btoa(JSON.stringify({ sub: 'carol', user_id: 'carol' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const carolClient = await ctx.newClient('mock-rules-carol');
      client.rtdbConnectDatabaseEmulator(
        carolClient.db as unknown as client.ClientRtdb,
        '127.0.0.1',
        9000,
        { mockUserToken: `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${jwtPayload}.` },
      );

      const anonClient = await ctx.newClient('mock-rules-anon');
      client.rtdbConnectDatabaseEmulator(
        anonClient.db as unknown as client.ClientRtdb,
        '127.0.0.1',
        9000,
      );

      const aliceDb = aliceClient.db as unknown as fdb.Database;
      const bobDb = bobClient.db as unknown as fdb.Database;
      const carolDb = carolClient.db as unknown as fdb.Database;
      const anonDb = anonClient.db as unknown as fdb.Database;

      await rtdb.set(rtdb.ref(aliceDb, 'users/alice'), { role: 'owner' });
      await rtdb.set(rtdb.ref(aliceDb, 'verified/flag'), true);
      expect((await rtdb.get(rtdb.ref(aliceDb, 'users/alice'))).val()).toEqual({
        role: 'owner',
      });
      expect((await rtdb.get(rtdb.ref(aliceDb, 'verified/flag'))).val()).toBe(true);

      const liveObserved: unknown[] = [];
      const unsub = rtdb.onValue(rtdb.ref(aliceDb, 'verified/flag'), (snap) => {
        liveObserved.push(snap.val());
      });
      await ctx.wait();
      unsub();
      expect(liveObserved).toEqual([true]);

      await rtdb.set(rtdb.ref(bobDb, 'users/bob'), { role: 'member' });
      expect((await rtdb.get(rtdb.ref(bobDb, 'users/bob'))).val()).toEqual({
        role: 'member',
      });
      await expect(rtdb.get(rtdb.ref(bobDb, 'users/alice'))).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await expect(rtdb.get(rtdb.ref(bobDb, 'verified/flag'))).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });

      await rtdb.set(rtdb.ref(carolDb, 'users/carol'), { via: 'jwt' });
      expect((await rtdb.get(rtdb.ref(carolDb, 'users/carol'))).val()).toEqual({
        via: 'jwt',
      });

      await expect(rtdb.get(rtdb.ref(anonDb, 'users/alice'))).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    });
  });
}
