import { describe, expect, it } from 'bun:test';
import {
  get,
  getDatabase,
  goOffline,
  goOnline,
  onDisconnect,
  push,
  ref,
  remove,
  runTransaction,
  sandbox as databaseSandbox,
  set,
  setPriority,
  setWithPriority,
  update,
} from '../../../src/database/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import type { SocketDropInFlightFatesObservation } from '../../../../conformance/probes/rtdb-modular/rtdb-modular-socket-drop-in-flight-fates.ts';
import { obs } from './capture-replay.ts';

describe('RTDB socket-drop in-flight fates capture (in-page sandbox side)', () => {
  it('validates captured @firebase/database wire fates and pins in-process settlement across goOffline/goOnline', async () => {
    const captured = obs(
      'rtdb-modular-socket-drop-in-flight-fates',
    ) as unknown as SocketDropInFlightFatesObservation;
    const wave = captured.combinedRestoreWave;

    expect(wave.pushKeyStability).toEqual({
      keyLength: 20,
      matchesPushCharset: true,
      resentIdenticalKey: true,
    });
    expect(wave.staleWriteReplyToOldRequestIdIgnored).toBe(true);
    expect(wave.staleGetReplyToOldRequestIdIgnored).toBe(true);
    expect(wave.inFlightOnDisconnectFates).toEqual({
      setResent: false,
      setSettled: false,
      setWithPriorityResent: false,
      setWithPrioritySettled: false,
      updateResent: false,
      updateSettled: false,
      removeResent: false,
      removeSettled: false,
      cancelResent: false,
      cancelSettled: false,
    });
    expect(wave.inFlightTransactionFate).toEqual({
      commitResent: false,
      settledBeforeReconnectHandshake: true,
      outcome: 'rejected',
      errorName: 'Error',
      errorMessage: 'disconnect',
      hasCode: false,
    });

    // In-page sandbox has no WebSocket: calls settle synchronously/in-process across goOffline()/goOnline().
    const sandbox = initializeSandbox({ projectId: 'demo-inpage-socket-drop-cdd' });
    try {
      const db = getDatabase(sandbox.withAuth({ uid: 'writer-1' }));
      databaseSandbox.setDefaultPolicy(db, 'allow');

      await set(ref(db, 'inflight/set'), { v: 1 });
      await update(ref(db, 'inflight/update'), { u: 2 });
      await set(ref(db, 'inflight/remove'), 'gone');
      await remove(ref(db, 'inflight/remove'));
      await set(ref(db, 'inflight/prio'), 'base');
      await setPriority(ref(db, 'inflight/prio'), 5);
      await setWithPriority(ref(db, 'inflight/withPrio'), 'val', 9);
      const pushed = push(ref(db, 'inflight/push'), { item: true });
      await pushed;
      let pushedKeyLength = 0;
      if (typeof pushed.key === 'string') {
        pushedKeyLength = pushed.key.length;
      }
      expect(pushedKeyLength).toBe(wave.pushKeyStability.keyLength);

      await set(ref(db, 'inflight/get'), wave.settledAfterReconnectReplies.getResolvedValue);
      await onDisconnect(ref(db, 'inflight/onDiscSet')).set('bye');
      await onDisconnect(ref(db, 'inflight/onDiscCancel')).cancel();

      goOffline(db);
      goOnline(db);

      const readBack = await get(ref(db, 'inflight/get'));
      expect(readBack.val()).toEqual(wave.settledAfterReconnectReplies.getResolvedValue);
      expect((await get(ref(db, 'inflight/onDiscSet'))).val()).toBe('bye');

      const txResult = await runTransaction(ref(db, 'tx/item'), (cur) => {
        let base = 0;
        if (typeof cur === 'number') {
          base = cur;
        }
        return base + 1;
      });
      expect(txResult.committed).toBe(true);
      expect(txResult.snapshot.val()).toBe(1);
    } finally {
      await sandbox.dispose();
    }
  });
});
