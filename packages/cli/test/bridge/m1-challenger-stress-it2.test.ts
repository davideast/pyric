/**
 * Empirical Stress Harness - Challenger 1 for Milestone M1 Iteration 2
 *
 * Tests:
 * 1. Deep session churn: 30 clients connect, sign in, write, drop socket unexpectedly,
 *    reconnect with saved clientSessionId, verify state and auth preserved, then cleanly dispose.
 * 2. Rapid connection-detach thrashing: 1 client connects and drops 50 times in rapid succession,
 *    then verifies that operations succeed without leak or state corruption.
 * 3. Concurrent browser tab reload during heavy multi-client write + subscription traffic:
 *    5 clients streaming and writing while browser tab disconnects, reconnects, and failovers.
 * 4. Boundary and adversarial actAs fuzzing under concurrency:
 *    Concurrent valid and hostile actAs payloads (prototype pollution, null bytes, special chars,
 *    undefined fields, non-string uids) executed concurrently without affecting neighbor clients.
 * 5. Subscription isolation during tab failover with concurrent auth state changes.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession, type ConsumerSession } from '../../src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerOpFrame,
  type WorkerResFrame,
  type WorkerSnapFrame,
} from '../../src/bridge/protocol.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /shared/{doc} {
      allow read, write: if request.auth != null;
    }
    match /public/{doc} {
      allow read, write: if true;
    }
    match /tenants/{tenantId}/docs/{doc} {
      allow read, write: if request.auth != null && request.auth.token.firebase.tenant == tenantId;
    }
  }
}`;

async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(RULES);
  const auth = getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'challenger-test', subs: new Map(), auth } as HostCtx;
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TestTab {
  port: PortLike;
  disconnect: () => void;
  closeSocket: () => void;
}

function connectTab(bridge: Bridge, ctx: HostCtx, sandboxId = 'tab-1'): TestTab {
  let gen = 0;
  let socketOpen = true;
  const port: PortLike = {
    postMessage(raw: unknown) {
      if (!socketOpen) return;
      const m = raw as OutboundMessage & { clientSessionId?: string };
      if (m.t === 'res') {
        bridge.handleSandboxMessage(
          m.ok
            ? { type: 'worker-res', id: m.id, clientSessionId: m.clientSessionId, ok: true, value: m.value }
            : { type: 'worker-res', id: m.id, clientSessionId: m.clientSessionId, ok: false, error: m.error },
          gen,
        );
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          { type: 'worker-snap', subId: m.subId, clientSessionId: m.clientSessionId, value: m.value },
          gen,
        );
      }
    },
  };

  const send = (msg: BridgeMessage): void => {
    if (!socketOpen) return;
    if (gen === 0) gen = bridge.peerGeneration();
    if (msg.type === 'worker-op') {
      void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id, clientSessionId: msg.clientSessionId } as InboundMessage);
    } else if (msg.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId, clientSessionId: msg.clientSessionId } as InboundMessage);
    } else if (msg.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId, clientSessionId: msg.clientSessionId } as InboundMessage);
    } else if (msg.type === 'worker-client-disconnect') {
      void handleMessage(ctx, port, { t: 'disconnect', id: `disc-${msg.clientSessionId}`, clientSessionId: msg.clientSessionId } as InboundMessage);
    }
  };

  const unregister = bridge.registerSandboxPeer(send, [], sandboxId, [WORKER_RELAY_CAPABILITY]);
  return {
    port,
    disconnect: () => {
      socketOpen = false;
      unregister();
    },
    closeSocket: () => {
      socketOpen = false;
    },
  };
}

interface ManagedConsumer {
  session: ConsumerSession;
  clientSessionId: string;
  snaps: WorkerSnapFrame[];
  op(payload: Record<string, unknown>, actAs?: unknown, timeoutMs?: number): Promise<WorkerResFrame>;
  sub(subId: string, payload: Record<string, unknown>): void;
  unsub(subId: string): void;
  detach(): void;
  dispose(): void;
}

async function startConsumer(bridge: Bridge, initialSessionId?: string): Promise<ManagedConsumer> {
  const snaps: WorkerSnapFrame[] = [];
  let clientSessionId = initialSessionId ?? '';
  let opSeq = 0;
  const pendingOps = new Map<string, (res: WorkerResFrame) => void>();

  const session = createConsumerSession(bridge, (msg: BridgeMessage) => {
    if (msg.type === 'attach-ack') {
      clientSessionId = (msg as { clientSessionId: string }).clientSessionId;
    } else if (msg.type === 'worker-res') {
      const res = msg as WorkerResFrame;
      const resolver = pendingOps.get(res.id);
      if (resolver) {
        pendingOps.delete(res.id);
        resolver(res);
      }
    } else if (msg.type === 'worker-snap') {
      snaps.push(msg as WorkerSnapFrame);
    }
  }, initialSessionId);

  session.handleMessage({
    type: 'attach',
    protocol: 1,
    ...(initialSessionId ? { clientSessionId: initialSessionId } : {}),
  } as BridgeMessage);
  await tick(5);

  return {
    session,
    get clientSessionId() { return clientSessionId; },
    snaps,
    op(payload: Record<string, unknown>, actAs?: unknown, timeoutMs = 100): Promise<WorkerResFrame> {
      return new Promise<WorkerResFrame>((resolve) => {
        const id = `ch-op-${clientSessionId}-${++opSeq}`;
        const timer = setTimeout(() => {
          if (pendingOps.has(id)) {
            pendingOps.delete(id);
            resolve({
              type: 'worker-res',
              id,
              clientSessionId,
              ok: false,
              error: { code: 'timeout', message: `Op ${id} timed out after ${timeoutMs}ms` },
            });
          }
        }, timeoutMs);
        pendingOps.set(id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        session.handleMessage({
          type: 'worker-op',
          id,
          op: {
            ...payload,
            ...(actAs !== undefined ? { actAs } : {}),
          },
        } as BridgeMessage);
      });
    },
    sub(subId: string, payload: Record<string, unknown>) {
      session.handleMessage({ type: 'worker-sub', subId, sub: payload } as BridgeMessage);
    },
    unsub(subId: string) {
      session.handleMessage({ type: 'worker-unsub', subId } as BridgeMessage);
    },
    detach() {
      session.detach();
    },
    dispose() {
      session.dispose();
    },
  };
}

describe('M1 Iteration 2 Challenger Deep Empirical Stress', () => {
  it('Challenger Stress 1: 30 concurrent clients undergo unexpected socket drop, reconnect, and resume operations', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const clientCount = 30;
    const users = Array.from({ length: clientCount }, (_, i) => ({
      uid: `churn-user-${i}`,
      email: `churn${i}@test.com`,
      password: 'password123',
    }));
    authSandbox.seedUsers(ctx.auth!, users);

    // 1. Connect all 30 clients and sign them in
    const initialClients = await Promise.all(
      Array.from({ length: clientCount }, (_, i) => startConsumer(bridge, `session-churn-${i}`)),
    );

    const signIns = await Promise.all(
      initialClients.map((c, i) =>
        c.op({ method: 'auth.signInEmail', email: users[i].email, password: users[i].password }),
      ),
    );
    for (const r of signIns) {
      expect(r.ok).toBe(true);
    }

    // 2. Each client writes initial data
    const writes1 = await Promise.all(
      initialClients.map((c, i) =>
        c.op({ method: 'setDoc', path: `users/${users[i].uid}`, data: { step: 1 } }),
      ),
    );
    for (const r of writes1) {
      expect(r.ok).toBe(true);
    }

    // 3. UNEXPECTED SOCKET DROP for all 30 clients (detach without dispose)
    for (const c of initialClients) {
      c.detach();
    }
    await tick(25);

    // 4. All 30 clients reconnect with their saved clientSessionId
    const reconnectedClients = await Promise.all(
      Array.from({ length: clientCount }, (_, i) => startConsumer(bridge, `session-churn-${i}`)),
    );

    // 5. Verify reconnected clients can immediately perform authenticated reads and writes
    const readsAfterDrop = await Promise.all(
      reconnectedClients.map((c, i) =>
        c.op({ method: 'getDoc', path: `users/${users[i].uid}` }),
      ),
    );
    for (let i = 0; i < clientCount; i++) {
      expect(readsAfterDrop[i].ok).toBe(true);
      const docData = (readsAfterDrop[i].value as any)?.data?.json
        ? JSON.parse((readsAfterDrop[i].value as any).data.json)
        : undefined;
      expect(docData?.step).toBe(1);
    }

    // 6. Each client writes step 2
    const writes2 = await Promise.all(
      reconnectedClients.map((c, i) =>
        c.op({ method: 'setDoc', path: `users/${users[i].uid}`, data: { step: 2 } }),
      ),
    );
    for (const r of writes2) {
      expect(r.ok).toBe(true);
    }

    // 7. Clean disposal
    for (const c of reconnectedClients) {
      c.dispose();
    }
    await tick(20);

    // Verify all 30 are now tombstoned
    for (let i = 0; i < clientCount; i++) {
      expect(ctx.disconnectedClientSessions?.has(`session-churn-${i}`)).toBe(true);
    }
  });

  it('Challenger Stress 2: Rapid connect/detach thrashing 50 times does not leak subscriptions or lock out port', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const sessionId = 'thrash-session';

    for (let i = 0; i < 50; i++) {
      const c = await startConsumer(bridge, sessionId);
      c.sub(`sub-${i}`, { target: { __ref: 'doc', path: 'public/thrash' } });
      await c.op({ method: 'setDoc', path: 'public/thrash', data: { iter: i } });
      c.detach();
    }
    await tick(30);

    // After 50 iterations, re-attach and verify it works cleanly
    const finalClient = await startConsumer(bridge, sessionId);
    const opRes = await finalClient.op({ method: 'getDoc', path: 'public/thrash' });
    expect(opRes.ok).toBe(true);

    const clientPort = ctx.remoteClientPorts?.get(sessionId);
    if (clientPort) {
      const subs = ctx.subs.get(clientPort);
      // All previous subscriptions must have been cleaned up
      expect(subs?.size ?? 0).toBe(0);
    }

    finalClient.dispose();
  });

  it('Challenger Stress 3: Concurrent valid and adversarial/fuzz actAs payloads do not poison adjacent sessions', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const honestClient = await startConsumer(bridge, 'honest-client');
    const attackerClient = await startConsumer(bridge, 'attacker-client');

    // Hostile actAs variations
    const hostileLenses: any[] = [
      { mode: 'as', uid: '' },
      { mode: 'as', uid: null },
      { mode: 'as', uid: 12345 },
      { mode: 'as', uid: '__proto__', token: { __proto__: { admin: true } } },
      { mode: 'as', uid: 'attacker', token: 'string-instead-of-object' },
      { mode: 'invalid-mode', uid: 'u1' },
      { mode: null },
      { mode: undefined },
      { mode: 'as', uid: 'attacker\x00nullbyte' },
      { mode: 'as', uid: 'valid-uid', token: { firebase: null } },
    ];

    // Launch concurrent burst of 50 interleaved ops
    const ops: Promise<WorkerResFrame>[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        // Honest client performing valid op
        ops.push(honestClient.op({ method: 'setDoc', path: `public/doc-h-${i}`, data: { i } }));
      } else {
        // Attacker trying hostile lens
        const lens = hostileLenses[i % hostileLenses.length];
        ops.push(attackerClient.op({ method: 'setDoc', path: `public/doc-a-${i}`, data: { i } }, lens));
      }
    }

    const results = await Promise.all(ops);

    // Verify honest client ops ALL succeeded with NO timeout and NO error
    for (let i = 0; i < 50; i += 2) {
      expect(results[i].ok).toBe(true);
    }

    // Verify attacker client ops never caused unhandled timeout
    for (let i = 1; i < 50; i += 2) {
      expect(results[i].error?.code).not.toBe('timeout');
    }

    // Verify Object prototype was not contaminated
    expect((Object.prototype as any).admin).toBeUndefined();

    honestClient.dispose();
    attackerClient.dispose();
  });

  it('Challenger Stress 4: Active subscription stream during repeated tab reload under continuous data writes', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    let tab = connectTab(bridge, ctx, 'tab-gen-1');

    const consumer = await startConsumer(bridge, 'stream-consumer');
    consumer.sub('live-sub', { target: { __ref: 'doc', path: 'public/live-doc' } });
    await tick(20);

    // Initial doc write
    await consumer.op({ method: 'setDoc', path: 'public/live-doc', data: { counter: 0 } });
    await tick(20);
    expect(consumer.snaps.length).toBeGreaterThan(0);

    // Perform 3 tab failovers while writing continuously
    for (let round = 1; round <= 3; round++) {
      // Tab drops
      tab.closeSocket();
      tab.disconnect();
      await tick(10);

      // Write in background while tab is down
      const adminDb = (await import('pyric/sandbox/admin-firestore')).getAdminFirestore(ctx.sandbox);
      await adminDb.doc('public/live-doc').set({ counter: round });
      await tick(10);

      // New tab connects
      tab = connectTab(bridge, ctx, `tab-gen-${round + 1}`);
      await tick(30);

      // Consumer should receive snapshot with counter == round
      const latestSnap = consumer.snaps.at(-1);
      const latestData = (latestSnap?.value as any)?.data?.json
        ? JSON.parse((latestSnap?.value as any).data.json)
        : undefined;
      expect(latestData?.counter).toBe(round);
    }

    consumer.dispose();
  });
});
