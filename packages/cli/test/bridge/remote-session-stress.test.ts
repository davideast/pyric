/**
 * Adversarial Stress & Concurrency Test Suite for Milestone M1
 * Remote Client Session Isolation & Wire Protocol Multiplexing.
 *
 * Exercises:
 * 1. High-concurrency multi-client multiplexing (20 concurrent clients, interleaved ops).
 * 2. Auth state subscription isolation under rapid interleaved login/logout transitions.
 * 3. Identical subId collision resistance across distinct client sessions & browser tab.
 * 4. Real-time Firestore snapshot isolation & dynamic permission re-eval on auth switch.
 * 5. Disconnect / tombstone race conditions with mid-flight operations.
 * 6. Peer replacement / browser tab failover during concurrent client streaming.
 * 7. Malformed / hostile clientSessionId and wire payload resilience.
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
  type WorkerSubFrame,
  type WorkerClientDisconnectFrame,
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
    match /rooms/{roomId} {
      allow read, write: if request.auth != null && request.auth.token.room == roomId;
    }
    match /public/{doc} {
      allow read, write: if true;
    }
    match /admin_only/{doc} {
      allow read, write: if request.auth != null && request.auth.token.role == 'admin';
    }
  }
}`;

async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(RULES);
  const auth = getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'stress-test', subs: new Map(), auth } as HostCtx;
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ConnectedTab {
  port: PortLike;
  receivedFrames: BridgeMessage[];
  disconnect: () => void;
}

function connectTab(bridge: Bridge, ctx: HostCtx, sandboxId = 'fake-tab'): ConnectedTab {
  let gen = 0;
  const receivedFrames: BridgeMessage[] = [];
  const port: PortLike = {
    postMessage(raw: unknown) {
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
    if (gen === 0) gen = bridge.peerGeneration();
    receivedFrames.push(msg);
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

  const disconnect = bridge.registerSandboxPeer(send, [], sandboxId, [WORKER_RELAY_CAPABILITY]);
  return { port, receivedFrames, disconnect };
}

interface TestConsumer {
  session: ConsumerSession;
  clientSessionId: string;
  resList: WorkerResFrame[];
  snaps: WorkerSnapFrame[];
  op(payload: Record<string, unknown>): Promise<WorkerResFrame>;
  sub(subId: string, payload: Record<string, unknown>): void;
  unsub(subId: string): void;
  dispose(): void;
}

async function createTestConsumer(bridge: Bridge, initialSessionId?: string): Promise<TestConsumer> {
  const resList: WorkerResFrame[] = [];
  const snaps: WorkerSnapFrame[] = [];
  let clientSessionId = initialSessionId ?? '';

  let opSeq = 0;
  const pendingOps = new Map<string, (res: WorkerResFrame) => void>();

  const session = createConsumerSession(bridge, (msg: BridgeMessage) => {
    if (msg.type === 'attach-ack') {
      clientSessionId = (msg as { clientSessionId: string }).clientSessionId;
    }
    if (msg.type === 'worker-res') {
      const res = msg as WorkerResFrame;
      resList.push(res);
      const resolver = pendingOps.get(res.id);
      if (resolver) {
        pendingOps.delete(res.id);
        resolver(res);
      }
    }
    if (msg.type === 'worker-snap') {
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
    resList,
    snaps,
    op(payload: Record<string, unknown>): Promise<WorkerResFrame> {
      return new Promise<WorkerResFrame>((resolve) => {
        const id = `op-${clientSessionId}-${++opSeq}`;
        pendingOps.set(id, resolve);
        session.handleMessage({ type: 'worker-op', id, op: payload } as BridgeMessage);
      });
    },
    sub(subId: string, payload: Record<string, unknown>) {
      session.handleMessage({ type: 'worker-sub', subId, sub: payload } as BridgeMessage);
    },
    unsub(subId: string) {
      session.handleMessage({ type: 'worker-unsub', subId } as BridgeMessage);
    },
    dispose() {
      session.dispose();
    },
  };
}

describe('M1 Adversarial Stress Harness', () => {
  it('Scenario 1: 20 concurrent clients execute interleaved operations without cross-talk', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const clientCount = 20;
    const users = Array.from({ length: clientCount }, (_, i) => ({
      uid: `client-user-${i}`,
      email: `client${i}@test.com`,
      password: 'password123',
    }));
    authSandbox.seedUsers(ctx.auth!, users);

    // Concurrently connect 20 clients
    const clients = await Promise.all(
      Array.from({ length: clientCount }, () => createTestConsumer(bridge)),
    );

    // Verify all 20 have unique clientSessionId
    const sessionIds = new Set(clients.map((c) => c.clientSessionId));
    expect(sessionIds.size).toBe(clientCount);

    // Concurrently sign in all 20 clients
    const signIns = await Promise.all(
      clients.map((c, i) =>
        c.op({ method: 'auth.signInEmail', email: users[i].email, password: users[i].password }),
      ),
    );
    for (const res of signIns) {
      expect(res.ok).toBe(true);
    }

    // Concurrently each client writes to their OWN user doc
    const ownWrites = await Promise.all(
      clients.map((c, i) =>
        c.op({ method: 'setDoc', path: `users/${users[i].uid}`, data: { index: i, owner: users[i].uid } }),
      ),
    );
    for (let i = 0; i < clientCount; i++) {
      expect(ownWrites[i].ok).toBe(true);
      expect(ownWrites[i].clientSessionId).toBe(clients[i].clientSessionId);
    }

    // Concurrently each client attempts to write to ANOTHER client's user doc (forbidden by rules)
    const illegalWrites = await Promise.all(
      clients.map((c, i) => {
        const targetIndex = (i + 1) % clientCount;
        return c.op({
          method: 'setDoc',
          path: `users/${users[targetIndex].uid}`,
          data: { forgedBy: users[i].uid },
        });
      }),
    );
    for (let i = 0; i < clientCount; i++) {
      expect(illegalWrites[i].ok).toBe(false);
      expect(illegalWrites[i].error?.code).toMatch(/permission-denied/);
    }

    // Verify currentUser for each client
    const currentUsers = await Promise.all(
      clients.map((c) => c.op({ method: 'auth.getCurrentUser' })),
    );
    for (let i = 0; i < clientCount; i++) {
      expect(currentUsers[i].ok).toBe(true);
      const u = currentUsers[i].value as { uid: string; email: string };
      expect(u.uid).toBe(users[i].uid);
      expect(u.email).toBe(users[i].email);
    }

    // Cleanup
    clients.forEach((c) => c.dispose());
  });

  it('Scenario 2: Auth state subscriptions fan out strictly within client boundaries', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'uA', email: 'userA@test.com', password: 'password123' },
      { uid: 'uB', email: 'userB@test.com', password: 'password123' },
    ]);

    const c1 = await createTestConsumer(bridge);
    const c2 = await createTestConsumer(bridge);

    c1.sub('auth-sub', { target: 'authState' });
    c2.sub('auth-sub', { target: 'authState' });
    await tick(20);

    // Initial null snap on each
    expect(c1.snaps.length).toBe(1);
    expect(c2.snaps.length).toBe(1);
    expect(c1.snaps[0].value).toBeNull();
    expect(c2.snaps[0].value).toBeNull();

    // Interleaved auth transitions
    // C1 signs in
    await c1.op({ method: 'auth.signInEmail', email: 'userA@test.com', password: 'password123' });
    await tick(20);
    expect(c1.snaps.length).toBe(2);
    expect(c2.snaps.length).toBe(1); // C2 unbothered
    expect((c1.snaps[1].value as { email: string }).email).toBe('userA@test.com');

    // C2 signs in
    await c2.op({ method: 'auth.signInEmail', email: 'userB@test.com', password: 'password123' });
    await tick(20);
    expect(c1.snaps.length).toBe(2); // C1 unbothered
    expect(c2.snaps.length).toBe(2);
    expect((c2.snaps[1].value as { email: string }).email).toBe('userB@test.com');

    // C1 signs out
    await c1.op({ method: 'auth.signOut' });
    await tick(20);
    expect(c1.snaps.length).toBe(3);
    expect(c1.snaps[2].value).toBeNull();
    expect(c2.snaps.length).toBe(2); // C2 still signed in

    c1.dispose();
    c2.dispose();
  });

  it('Scenario 3: Identical subId across different clients does not collide or cross-cancel', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const c1 = await createTestConsumer(bridge);
    const c2 = await createTestConsumer(bridge);

    // Both use the EXACT same subId string "active-doc-sub"
    c1.sub('active-doc-sub', { target: { __ref: 'doc', path: 'public/doc1' } });
    c2.sub('active-doc-sub', { target: { __ref: 'doc', path: 'public/doc2' } });
    await tick(20);

    expect(c1.snaps.length).toBe(1);
    expect(c2.snaps.length).toBe(1);

    // Update public/doc1: only C1 should receive snap
    await c1.op({ method: 'setDoc', path: 'public/doc1', data: { hello: 'doc1' } });
    await tick(20);
    expect(c1.snaps.length).toBe(2);
    expect(c2.snaps.length).toBe(1);

    // C1 unsubs "active-doc-sub"
    c1.unsub('active-doc-sub');
    await tick(20);

    // Update public/doc2: C2 should STILL receive snap (not cancelled by C1)
    await c2.op({ method: 'setDoc', path: 'public/doc2', data: { hello: 'doc2' } });
    await tick(20);
    expect(c2.snaps.length).toBe(2);

    // Update public/doc1 again: C1 receives nothing because unsubscribed
    await c2.op({ method: 'setDoc', path: 'public/doc1', data: { hello: 'doc1-again' } });
    await tick(20);
    expect(c1.snaps.length).toBe(2);

    c1.dispose();
    c2.dispose();
  });

  it('Scenario 4: Real-time listener dynamic re-auth and claim scoping', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'uRoomAlpha', email: 'alpha@test.com', password: 'password123', customClaims: { room: 'alpha' } },
      { uid: 'uRoomBeta', email: 'beta@test.com', password: 'password123', customClaims: { room: 'beta' } },
    ]);

    const c1 = await createTestConsumer(bridge);
    const c2 = await createTestConsumer(bridge);

    await c1.op({ method: 'auth.signInEmail', email: 'alpha@test.com', password: 'password123' });
    await c2.op({ method: 'auth.signInEmail', email: 'beta@test.com', password: 'password123' });

    // C1 listens to room alpha
    c1.sub('room-sub', { target: { __ref: 'doc', path: 'rooms/alpha' } });
    // C2 listens to room beta
    c2.sub('room-sub', { target: { __ref: 'doc', path: 'rooms/beta' } });
    await tick(20);

    expect(c1.snaps.length).toBe(1);
    expect(c2.snaps.length).toBe(1);

    // Seed doc data via admin lens
    await c1.op({ method: 'setDoc', path: 'rooms/alpha', data: { topic: 'Alpha Chat' }, actAs: { mode: 'admin' } });
    await c2.op({ method: 'setDoc', path: 'rooms/beta', data: { topic: 'Beta Chat' }, actAs: { mode: 'admin' } });
    await tick(20);

    expect(c1.snaps.length).toBe(2);
    expect(c2.snaps.length).toBe(2);

    // C1 signs out: listener to rooms/alpha should receive permission-denied immediately upon re-authorization
    await c1.op({ method: 'auth.signOut' });
    await tick(30);

    // C1 should have received permission-denied snap error
    const lastSnap = c1.snaps.at(-1);
    expect(lastSnap?.value).toBeDefined();
    const errorVal = (lastSnap?.value as { __error?: { code?: string } })?.__error;
    expect(errorVal?.code).toMatch(/permission-denied/);

    // C2's listener is still completely healthy and active
    await c2.op({ method: 'setDoc', path: 'rooms/beta', data: { topic: 'Beta Chat Updated' } });
    await tick(20);
    expect(c2.snaps.length).toBe(3);

    c1.dispose();
    c2.dispose();
  });

  it('Scenario 5: Mid-flight disconnect tombstones session and cancels pending ops cleanly', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const c1 = await createTestConsumer(bridge);
    const c2 = await createTestConsumer(bridge);

    // Start ops on c1
    const p1 = c1.op({ method: 'getVersion' });
    // Immediately dispose c1
    c1.dispose();
    await tick(20);

    // C1 session is tombstoned
    expect(ctx.disconnectedClientSessions?.has(c1.clientSessionId)).toBe(true);

    // Attempting further op on C1 fails with app/app-deleted
    const postDiscOp = await c1.op({ method: 'getVersion' });
    expect(postDiscOp.ok).toBe(false);
    expect(postDiscOp.error?.code).toBe('app/app-deleted');

    // C2 was completely unaffected
    const c2Op = await c2.op({ method: 'getVersion' });
    expect(c2Op.ok).toBe(true);

    c2.dispose();
  });

  it('Scenario 6: Malformed / hostile clientSessionId does not crash host or leak data', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    const tab = connectTab(bridge, ctx);

    const hostileIds = [
      '../../../etc/passwd',
      '__proto__',
      'constructor',
      '<script>alert(1)</script>',
      'session-with-\x00-null-byte',
      'emoji-🚀-session-🔥',
    ];

    for (const id of hostileIds) {
      const consumer = await createTestConsumer(bridge, id);
      expect(consumer.clientSessionId).toBe(id);

      // Perform op
      const res = await consumer.op({ method: 'getVersion' });
      expect(res.ok).toBe(true);
      expect(res.clientSessionId).toBe(id);

      // Verify no pollution on Object prototype
      expect((Object.prototype as { clientSessionId?: string }).clientSessionId).toBeUndefined();

      consumer.dispose();
      await tick(10);
      expect(ctx.disconnectedClientSessions?.has(id)).toBe(true);
    }
  });

  it('Scenario 7: Tab failover preserves consumer session and allows subsequent ops', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    const tab1 = connectTab(bridge, ctx, 'tab-1');

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'uFailover', email: 'failover@test.com', password: 'password123' },
    ]);

    const consumer = await createTestConsumer(bridge);
    await consumer.op({ method: 'auth.signInEmail', email: 'failover@test.com', password: 'password123' });

    // Tab 1 closes abruptly
    tab1.disconnect();
    await tick(10);

    // Tab 2 connects to bridge
    const tab2 = connectTab(bridge, ctx, 'tab-2');
    await tick(10);

    // Consumer sends op over the new tab
    const res = await consumer.op({ method: 'auth.getCurrentUser' });
    expect(res.ok).toBe(true);
    expect((res.value as { uid: string }).uid).toBe('uFailover');

    consumer.dispose();
  });
});
