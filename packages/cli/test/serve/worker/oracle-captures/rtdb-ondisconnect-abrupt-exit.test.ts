import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox, type PersistenceBackend } from 'pyric/sandbox';
import * as client from '../../../../src/serve/worker/index.js';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import {
  resetRtdbClientLeaseIntervalMs,
  setRtdbClientLeaseIntervalMs,
} from '../../../../src/serve/worker/client/rtdb-port-lease.js';
import {
  RTDB_PORT_LEASE_STALE_MS,
  expireStaleRtdbPortLeases,
  resetRtdbLeaseNow,
  setRtdbLeaseNow,
} from '../../../../src/serve/worker/host/rtdb-port-leases.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { allowWorkerServicesForTransportTests } from '../permissive-services.js';
import { connectClientToHost, makeHostCtx, sleep } from '../integration-support.js';
import {
  cleanupServerProcessFixtures,
  loadAbruptExitBehavior,
  openRegisteredServerHost,
  spawnRegisteredNodeChild,
  waitForCondition,
} from './rtdb-server-process-support.ts';
import { restoreSharedWorker } from './support.ts';

restoreSharedWorker();

const OPEN_RTDB_RULES = {
  rules: {
    '.read': true,
    '.write': true,
  },
};

async function makePersistentHostCtx(
  persistKey: string,
  injectedBackend: PersistenceBackend,
): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  allowWorkerServicesForTransportTests(sandbox, persistKey);
  await sandbox.enablePersistence({
    key: persistKey,
    injectedBackend,
  });
  ipGetAuth(sandbox);
  return {
    db: ipGetFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };
}

describe('RTDB abrupt writer termination oracle capture (rtdb-modular#M84)', () => {
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    setRtdbLeaseNow(() => clock);
  });

  afterEach(async () => {
    resetRtdbLeaseNow();
    resetRtdbClientLeaseIntervalMs();
    await cleanupServerProcessFixtures();
  });

  it('replays rtdb-modular-ondisconnect-abrupt-exit across SharedWorker RTDB port leases + durable persistence (repeatCount=3)', async () => {
    const observed = loadAbruptExitBehavior();
    expect(observed.exitWasForced).toBe(true);
    expect(observed.acknowledgement.registered).toBe(true);
    expect(observed.repeatCount).toBeGreaterThanOrEqual(3);

    const durableBackend = createMemoryBackend();
    const persistKey = 'rtdb-abrupt-exit-persist';
    const ctx = await makePersistentHostCtx(persistKey, durableBackend);
    setDatabaseRules(ctx, undefined, OPEN_RTDB_RULES);

    // Observer arms a fast client keepalive (25ms) so its own armed onDisconnect
    // stays fresh while crashed writer ports stop heartbeating completely.
    setRtdbClientLeaseIntervalMs(25);
    const observerConn = connectClientToHost(ctx, 'worker://abrupt-observer');
    const observerDb = client.rtdbGetDatabase(observerConn.db);
    const observerPresencePath = 'pyric_oracle/abrupt_lease/observer_alive';
    const observerPresenceRef = client.rtdbRef(observerDb, observerPresencePath);
    await client.rtdbSet(observerPresenceRef, { state: 'observer-online' });
    await client.rtdbOnDisconnect(observerPresenceRef).set({ state: 'observer-dropped' });

    // Crashed writers use an unreached interval to simulate a frozen/killed renderer.
    setRtdbClientLeaseIntervalMs(3_600_000);

    try {
      for (let cycle = 0; cycle < observed.repeatCount; cycle += 1) {
        const path = `pyric_oracle/abrupt_lease/cycle_${cycle}`;
        const observedTransitions: Array<Record<string, unknown>> = [];
        const observerRef = client.rtdbRef(observerDb, path);
        const unsub = client.rtdbOnValue(observerRef, (snap) => {
          const val = snap.val();
          if (val !== null && typeof val === 'object') {
            observedTransitions.push(val as Record<string, unknown>);
          }
        });
        await sleep(30);

        const writerConn = connectClientToHost(ctx, `worker://abrupt-writer-${cycle}`);
        const writerDb = client.rtdbGetDatabase(writerConn.db);
        const writerRef = client.rtdbRef(writerDb, path);

        await client.rtdbSet(writerRef, { state: 'online' });
        await client.rtdbOnDisconnect(writerRef).set(observed.terminal);
        await waitForCondition(
          () => observedTransitions.length >= 1,
          `SharedWorker cycle ${cycle} online delivery`,
        );

        // Advance past half the lease window while observer's 25ms keepalive fires
        // idempotent rtdb.goOnline frames that refresh only observer's host lease.
        const halfWindow = Math.floor(RTDB_PORT_LEASE_STALE_MS / 2);
        clock += halfWindow;
        await sleep(40);
        clock += halfWindow + 10;
        await sleep(40);

        const evicted = await expireStaleRtdbPortLeases(ctx);
        expect(evicted).toBe(1);

        await waitForCondition(
          () => observedTransitions.length >= observed.events.length,
          `SharedWorker cycle ${cycle} abrupt offline delivery`,
        );
        expect(observedTransitions).toEqual(observed.events);
        expect((await client.rtdbGet(observerRef)).val()).toEqual(observed.terminal);
        expect((await client.rtdbGet(observerPresenceRef)).val()).toEqual({
          state: 'observer-online',
        });

        const recordIds = await durableBackend.listRecords(persistKey);
        expect(recordIds.length).toBeGreaterThan(0);
        const serializedRecords: string[] = [];
        for (const id of recordIds) {
          serializedRecords.push(JSON.stringify(await durableBackend.getRecord(persistKey, id)));
        }
        expect(serializedRecords.join('\n')).toContain('"offline"');

        unsub();
      }
    } finally {
      await client.rtdbOnDisconnect(observerPresenceRef).cancel();
    }
  });

  it('disarms SharedWorker RTDB port leases on cancel() and goOffline() without sending keepalives while offline', async () => {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, undefined, OPEN_RTDB_RULES);

    setRtdbClientLeaseIntervalMs(20);
    const conn = connectClientToHost(ctx, 'worker://abrupt-disarm');
    const db = client.rtdbGetDatabase(conn.db);
    const targetRef = client.rtdbRef(db, 'pyric_oracle/abrupt_lease/disarm_guard');

    // 1. Cancel removes the last armed path and disarms the host lease.
    await client.rtdbSet(targetRef, { state: 'online' });
    await client.rtdbOnDisconnect(targetRef).set({ state: 'cancelled-should-not-fire' });
    await client.rtdbOnDisconnect(targetRef).cancel();
    clock += RTDB_PORT_LEASE_STALE_MS + 50;
    expect(await expireStaleRtdbPortLeases(ctx)).toBe(0);
    expect((await client.rtdbGet(targetRef)).val()).toEqual({ state: 'online' });

    // 2. goOffline drains once, stops client keepalives, and keeps .info/connected false.
    const connectedStates: boolean[] = [];
    const stopConnected = client.rtdbOnValue(client.rtdbRef(db, '.info/connected'), (snap) => {
      connectedStates.push(Boolean(snap.val()));
    });
    await sleep(25);
    await client.rtdbOnDisconnect(targetRef).set({ state: 'drained-cleanly' });
    client.rtdbGoOffline(db);
    await sleep(60);
    expect(connectedStates[connectedStates.length - 1]).toBe(false);
    clock += RTDB_PORT_LEASE_STALE_MS + 50;
    expect(await expireStaleRtdbPortLeases(ctx)).toBe(0);
    stopConnected();
  });

  it('replays rtdb-modular-ondisconnect-abrupt-exit across @pyric/cli/register SIGKILL child processes (repeatCount=3)', async () => {
    const observed = loadAbruptExitBehavior();
    const host = await openRegisteredServerHost({ databaseRules: OPEN_RTDB_RULES });
    const adminDb = await host.openAdminObserver();

    for (let cycle = 0; cycle < observed.repeatCount; cycle += 1) {
      const abruptPath = `pyric_oracle/abrupt_sigkill/cycle_${cycle}`;
      const abruptEvents: Array<Record<string, unknown>> = [];
      const listener = (snap: { val(): unknown }) => {
        const value = snap.val();
        if (value !== null && typeof value === 'object') {
          abruptEvents.push(value as Record<string, unknown>);
        }
      };
      adminDb.ref(abruptPath).on('value', listener);

      const script = `
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, onDisconnect } from 'firebase/database';

const app = initializeApp({
  apiKey: 'demo',
  appId: 'demo',
  projectId: 'demo-oracle',
  databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
});
const db = getDatabase(app);
await set(ref(db, '${abruptPath}'), { state: 'online' });
await onDisconnect(ref(db, '${abruptPath}')).set(${JSON.stringify(observed.terminal)});
console.log(JSON.stringify({ registered: true }));
`;
      const spawned = spawnRegisteredNodeChild(
        host.projectDir,
        `m84-abrupt-${cycle}.mjs`,
        script,
        {
          PYRIC_SANDBOX: `remote:${host.serveUrl}`,
          PYRIC_SANDBOX_INSTANCE: host.instanceId,
        },
      );
      await waitForCondition(
        () => spawned.stdout().includes('"registered":true'),
        `SIGKILL cycle ${cycle} registration`,
      );
      await sleep(80);
      expect(spawned.child.exitCode).toBeNull();
      spawned.child.kill('SIGKILL');
      const killed = await spawned.waitExit();
      expect(killed.signal).toBe('SIGKILL');

      await waitForCondition(
        () => abruptEvents.length >= observed.events.length,
        `SIGKILL cycle ${cycle} offline delivery`,
      );
      expect(abruptEvents).toEqual(observed.events);
      expect((await adminDb.ref(abruptPath).get()).val()).toEqual(observed.terminal);
      adminDb.ref(abruptPath).off('value', listener);
    }
  }, 45_000);
});
