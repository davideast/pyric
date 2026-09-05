/**
 * Adversarial stress harness for Milestone M1 (Bridge Session Isolation & Protocol).
 *
 * Exercises:
 * - Real-world browser peer reload with dead socket during intermediate mutation.
 * - Client reconnect after unexpected socket drop / disconnect with same clientSessionId.
 * - Rapid subscribe/unsubscribe cycles under concurrency.
 * - actAs AuthLens edge cases: invalid tokens, empty uid, malformed lens, anon <-> as switching, tenant scoping.
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
    match /notes/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /shared/{doc} {
      allow read, write: if request.auth != null;
    }
    match /public/{doc} {
      allow read, write: if true;
    }
    match /roles/{doc} {
      allow read, write: if request.auth != null && request.auth.token['role'] == 'admin';
    }
    match /tenants/{tenantId}/items/{doc} {
      allow read, write: if request.auth != null && request.auth.token.firebase.tenant == tenantId;
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

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeTab {
  port: PortLike;
  receivedFrames: BridgeMessage[];
  disconnect: () => void;
  closeSocket: () => void;
}

function connectTab(bridge: Bridge, ctx: HostCtx): FakeTab {
  let gen = 0;
  let socketOpen = true;
  const receivedFrames: BridgeMessage[] = [];
  const port: PortLike = {
    postMessage(raw: unknown) {
      if (!socketOpen) return; // Simulated closed WebSocket on tab
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
    receivedFrames.push(msg);
    if (msg.type === 'worker-op') {
      handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id, clientSessionId: msg.clientSessionId } as InboundMessage).catch((e) => {
        // Unhandled rejections from worker message handling
        // If worker fails to send error response over port, caller will hang
      });
    } else if (msg.type === 'worker-sub') {
      handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId, clientSessionId: msg.clientSessionId } as InboundMessage).catch((e) => {});
    } else if (msg.type === 'worker-unsub') {
      handleMessage(ctx, port, { t: 'unsub', subId: msg.subId, clientSessionId: msg.clientSessionId } as InboundMessage).catch((e) => {});
    } else if (msg.type === 'worker-client-disconnect') {
      handleMessage(ctx, port, { t: 'disconnect', id: `disc-${msg.clientSessionId}`, clientSessionId: msg.clientSessionId } as InboundMessage).catch((e) => {});
    }
  };

  const unregister = bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
  const disconnect = (): void => {
    socketOpen = false;
    unregister();
  };
  return {
    port,
    receivedFrames,
    disconnect,
    closeSocket: () => { socketOpen = false; },
  };
}

interface FakeConsumer {
  session: ConsumerSession;
  sent: BridgeMessage[];
  resList: WorkerResFrame[];
  snaps: WorkerSnapFrame[];
  clientSessionId: string;
  op(payload: Record<string, unknown>, actAs?: unknown, timeoutMs?: number): Promise<WorkerResFrame>;
  sub(subId: string, payload: Record<string, unknown>): void;
  unsub(subId: string): void;
  dispose(): void;
}

async function connectConsumer(bridge: Bridge, initialSessionId?: string): Promise<FakeConsumer> {
  const sent: BridgeMessage[] = [];
  const resList: WorkerResFrame[] = [];
  const snaps: WorkerSnapFrame[] = [];
  let clientSessionId = '';

  const session = createConsumerSession(bridge, (msg: BridgeMessage) => {
    sent.push(msg);
    if (msg.type === 'attach-ack') {
      clientSessionId = (msg as { clientSessionId: string }).clientSessionId;
    }
    if (msg.type === 'worker-res') resList.push(msg as WorkerResFrame);
    if (msg.type === 'worker-snap') snaps.push(msg as WorkerSnapFrame);
  }, initialSessionId);

  session.handleMessage({
    type: 'attach',
    protocol: 1,
    ...(initialSessionId ? { clientSessionId: initialSessionId } : {}),
  } as BridgeMessage);
  await tick();

  let opSeq = 0;
  return {
    session,
    sent,
    resList,
    snaps,
    get clientSessionId() { return clientSessionId; },
    async op(payload: Record<string, unknown>, actAs?: unknown, timeoutMs = 50) {
      const id = `cop-${++opSeq}`;
      session.handleMessage({
        type: 'worker-op',
        id,
        op: {
          ...payload,
          ...(actAs !== undefined ? { actAs } : {}),
        },
      } as BridgeMessage);
      await tick(timeoutMs);
      const res = resList.find((r) => r.id === id);
      if (!res) throw new Error(`NO_RES_TIMEOUT: no response frame received for op ${id}`);
      return res;
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

describe('M1 Challenger 2 Empirical Stress Verification', () => {
  it('CASE 1 (FAILING): Unexpected socket drop followed by client reconnect with saved clientSessionId', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    // Initial consumer connection
    const c1 = await connectConsumer(bridge, 'mobile-session-001');
    expect(c1.clientSessionId).toBe('mobile-session-001');

    // C1 executes a write
    const writeRes = await c1.op({ method: 'setDoc', path: 'public/doc1', data: { v: 1 } });
    expect(writeRes.ok).toBe(true);

    // UNEXPECTED SOCKET DROP: transport closes, calling session.dispose()
    c1.dispose();
    await tick(20);

    // Client reconnects with its saved clientSessionId 'mobile-session-001'
    const c1Reconnected = await connectConsumer(bridge, 'mobile-session-001');
    expect(c1Reconnected.clientSessionId).toBe('mobile-session-001');

    // Attempt operation after reconnect: MUST NOT fail with app/app-deleted
    const postReconnectOp = await c1Reconnected.op({ method: 'getDoc', path: 'public/doc1' });
    // This will empirically reveal the app/app-deleted bug
    expect(postReconnectOp.ok).toBe(true);
  });

  it('CASE 2 (FAILING): Realistic browser peer reload with data mutation while tab is dead', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    const tab1 = connectTab(bridge, ctx);

    const consumer = await connectConsumer(bridge);
    consumer.sub('sub-shared', { target: { __ref: 'doc', path: 'public/reload-test' } });
    await tick(20);

    // Set initial data
    await consumer.op({ method: 'setDoc', path: 'public/reload-test', data: { step: 1 } });
    await tick(20);

    const snapsBefore = consumer.snaps.length;
    expect(snapsBefore).toBeGreaterThan(0);

    // TAB 1 DIES (Tab reload: socket closes immediately, then bridge registers disconnect)
    tab1.closeSocket();
    tab1.disconnect();
    await tick(10);

    // WHILE TAB IS DEAD, data is modified in sandbox (e.g. background task, direct admin write)
    const adminDb = (await import('pyric/sandbox/admin-firestore')).getAdminFirestore(ctx.sandbox);
    await adminDb.doc('public/reload-test').set({ step: 2 });
    await tick(10);

    // TAB 2 ATTACHES (Tab reloaded)
    const tab2 = connectTab(bridge, ctx);
    await tick(30);

    // Does the consumer receive the updated snapshot reflecting step: 2 upon tab re-attachment?
    const latestSnap = consumer.snaps.at(-1);
    const latestData = (latestSnap?.value as any)?.data?.json
      ? JSON.parse((latestSnap?.value as any).data.json)
      : undefined;
    expect(latestData?.step).toBe(2);
  });

  it('CASE 3 (PASSING): Rapid subscribe / unsubscribe cycles under clientSessionId', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const consumer = await connectConsumer(bridge);

    // Rapid cycle 50 times
    for (let i = 0; i < 50; i++) {
      const subId = `rapid-sub-${i}`;
      consumer.sub(subId, { target: { __ref: 'doc', path: 'public/rapid' } });
      consumer.unsub(subId);
    }
    await tick(50);

    // After rapid unsub, consumer opens one final stable sub
    consumer.sub('stable-sub', { target: { __ref: 'doc', path: 'public/rapid' } });
    await tick(20);

    const countBefore = consumer.snaps.filter((s) => s.subId === 'stable-sub').length;
    await consumer.op({ method: 'setDoc', path: 'public/rapid', data: { val: 'stable' } });
    await tick(20);

    const countAfter = consumer.snaps.filter((s) => s.subId === 'stable-sub').length;
    expect(countAfter).toBeGreaterThan(countBefore);

    // Check no zombie subscriptions remain on SharedWorker ctx
    const clientPort = ctx.remoteClientPorts?.get(consumer.clientSessionId);
    if (clientPort) {
      const activeSubs = ctx.subs.get(clientPort);
      expect(activeSubs?.size).toBe(1);
    }
  });

  it('CASE 4 (FAILING): actAs edge cases: empty uid, malformed token, unknown mode causing client hang', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const consumer = await connectConsumer(bridge);

    // 4a. actAs with empty uid - must reject gracefully with error frame, NOT hang
    let err4a: any = null;
    try {
      const resEmptyUid = await consumer.op(
        { method: 'setDoc', path: 'public/doc-empty-uid', data: { a: 1 } },
        { mode: 'as', uid: '' },
        50,
      );
      expect(resEmptyUid.ok).toBe(false);
    } catch (err) {
      err4a = err;
    }
    // Should NOT throw NO_RES_TIMEOUT
    expect(err4a).toBeNull();

    // 4b. actAs with non-object token - must reject gracefully with error frame, NOT hang
    let err4b: any = null;
    try {
      const resBadToken = await consumer.op(
        { method: 'setDoc', path: 'public/doc-bad-token', data: { a: 1 } },
        { mode: 'as', uid: 'u1', token: 'not-a-token-object' as any },
        50,
      );
      expect(resBadToken.ok).toBe(false);
    } catch (err) {
      err4b = err;
    }
    expect(err4b).toBeNull();

    // 4c. actAs with unknown mode - must reject gracefully with error frame, NOT hang
    let err4c: any = null;
    try {
      const resUnknownMode = await consumer.op(
        { method: 'setDoc', path: 'public/doc-unknown-mode', data: { a: 1 } },
        { mode: 'bogus-mode' as any },
        50,
      );
      expect(resUnknownMode.ok).toBe(false);
    } catch (err) {
      err4c = err;
    }
    expect(err4c).toBeNull();
  });

  it('CASE 5 (PASSING): Rapid switching between anon and as across concurrent operations', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const consumer = await connectConsumer(bridge);

    // Launch 20 concurrent operations alternating between anon (denied on /notes/u1) and as (allowed)
    const promises: Promise<WorkerResFrame>[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        promises.push(consumer.op(
          { method: 'getDoc', path: 'notes/u1' },
          { mode: 'anon' },
          100,
        ));
      } else {
        promises.push(consumer.op(
          { method: 'getDoc', path: 'notes/u1' },
          { mode: 'as', uid: 'u1' },
          100,
        ));
      }
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        expect(results[i].ok).toBe(false);
        expect(results[i].error?.code).toMatch(/permission-denied/);
      } else {
        expect(results[i].ok).toBe(true);
      }
    }
  });

  it('CASE 6: Multi-tenant and claims scoping under actAs AuthLens', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const consumer = await connectConsumer(bridge);

    // Tenant-isolated document access
    // /tenants/tenant-A/items/doc1 requires request.auth.token.firebase.tenant == 'tenant-A'
    const tenantAAllowed = await consumer.op(
      { method: 'setDoc', path: 'tenants/tenant-A/items/doc1', data: { t: 'A' } },
      { mode: 'as', uid: 'user-tenant-a', tenant: 'tenant-A' },
    );
    expect(tenantAAllowed.ok).toBe(true);

    // Same user trying to write to tenant-B is DENIED
    const tenantBDenied = await consumer.op(
      { method: 'setDoc', path: 'tenants/tenant-B/items/doc1', data: { t: 'B' } },
      { mode: 'as', uid: 'user-tenant-a', tenant: 'tenant-A' },
    );
    expect(tenantBDenied.ok).toBe(false);
    expect(tenantBDenied.error?.code).toMatch(/permission-denied/);

    // Custom claims role == 'admin' allowed on /roles/admin-doc
    const adminClaimAllowed = await consumer.op(
      { method: 'setDoc', path: 'roles/admin-doc', data: { secret: 42 } },
      { mode: 'as', uid: 'admin-user', token: { role: 'admin' } },
    );
    expect(adminClaimAllowed.ok).toBe(true);

    // Custom claims role == 'viewer' denied on /roles/admin-doc
    const viewerClaimDenied = await consumer.op(
      { method: 'setDoc', path: 'roles/admin-doc', data: { secret: 99 } },
      { mode: 'as', uid: 'viewer-user', token: { role: 'viewer' } },
    );
    expect(viewerClaimDenied.ok).toBe(false);
    expect(viewerClaimDenied.error?.code).toMatch(/permission-denied/);
  });
});
