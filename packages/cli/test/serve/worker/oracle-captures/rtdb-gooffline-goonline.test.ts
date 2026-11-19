import { describe, expect, it } from 'bun:test';
import { disconnectClient } from '../../../../src/serve/worker/client/disconnect.js';
import * as client from '../../../../src/serve/worker/index.js';
import {
  observeDeletedDatabaseConnectionGuards,
  observeGoOfflineGoOnlineContract,
  type GoOfflineGoOnlineObservation,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-gooffline-goonline-queue-and-isolation.ts';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

const PLANES: ReadonlyArray<[string, () => Promise<ServedRtdbAdminContext>]> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

for (const [planeName, createContext] of PLANES) {
  describe(`RTDB goOffline and goOnline queue and isolation capture (${planeName})`, () => {
    it('replays rtdb-modular-gooffline-goonline-queue-and-isolation across writer and observer clients', async () => {
      const expected = load(
        'rtdb-modular-gooffline-goonline-queue-and-isolation',
      ) as unknown as GoOfflineGoOnlineObservation;
      const ctx = await createContext();
      const observer = await ctx.newClient('observer');

      const live = await observeGoOfflineGoOnlineContract({
        writerDb: ctx.db as never,
        observerDb: observer.db as never,
        basePath: 'pyric_oracle/offline_replay',
        goOffline: ctx.rtdb.goOffline as never,
        goOnline: ctx.rtdb.goOnline as never,
        ref: ctx.rtdb.ref as never,
        get: ctx.rtdb.get as never,
        set: ctx.rtdb.set as never,
        update: ctx.rtdb.update as never,
        remove: ctx.rtdb.remove as never,
        onValue: ctx.rtdb.onValue as never,
        onDisconnect: ctx.rtdb.onDisconnect as never,
        runTransaction: ctx.rtdb.runTransaction as never,
      });

      const deletedGuards = await observeDeletedDatabaseConnectionGuards({
        async openDeletedDatabase() {
          const hostCtx = await makeHostCtx();
          const { db: rawClient } = connectClientToHost(
            hostCtx,
            `worker://deleted-offline-${Math.random()}`,
          );
          const tempDb = client.rtdbGetDatabase(rawClient);
          client.rtdbGoOffline(tempDb);
          await disconnectClient(rawClient);
          return {
            db: tempDb as never,
            goOffline: client.rtdbGoOffline as never,
            goOnline: client.rtdbGoOnline as never,
          };
        },
      });

      expect({ live, deletedGuards }).toEqual(expected);
    });
  });
}
