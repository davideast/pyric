/**
 * Remote Client Session Isolation across WebSocket Bridge Relay (M1).
 *
 * End-to-end characterization of multi-consumer bridge sessions:
 * - Attach handshake and unique clientSessionId assignment.
 * - Bidirectional frame tagging (worker-op, worker-res, worker-sub, worker-snap).
 * - Multi-consumer concurrent auth state and firestore rules evaluation.
 * - Peer replacement preserving clientSessionId on subscription re-issue.
 * - Consumer disconnect emitting worker-client-disconnect and cleaning up.
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
  type WorkerSubFrame,
  type WorkerSnapFrame,
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
  }
}`;

async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(RULES);
  const auth = getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'bridge-test', subs: new Map(), auth } as HostCtx;
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeTab {
  port: PortLike;
  receivedFrames: BridgeMessage[];
  disconnect: () => void;
}

function connectTab(bridge: Bridge, ctx: HostCtx): FakeTab {
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

  const disconnect = bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
  return { port, receivedFrames, disconnect };
}

interface FakeConsumer {
  session: ConsumerSession;
  sent: BridgeMessage[];
  resList: WorkerResFrame[];
  snaps: WorkerSnapFrame[];
  clientSessionId: string;
  op(payload: Record<string, unknown>): Promise<WorkerResFrame>;
  sub(subId: string, payload: Record<string, unknown>): void;
  unsub(subId: string): void;
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
    async op(payload: Record<string, unknown>) {
      const id = `cop-${++opSeq}`;
      session.handleMessage({ type: 'worker-op', id, op: payload } as BridgeMessage);
      await tick();
      const res = resList.find((r) => r.id === id);
      if (!res) throw new Error(`no res for ${id}`);
      return res;
    },
    sub(subId: string, payload: Record<string, unknown>) {
      session.handleMessage({ type: 'worker-sub', subId, sub: payload } as BridgeMessage);
    },
    unsub(subId: string) {
      session.handleMessage({ type: 'worker-unsub', subId } as BridgeMessage);
    },
  };
}

describe('remote session isolation across bridge relay (M1)', () => {
  it('assigns unique clientSessionId on attach and tags worker-op frames', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    const tab = connectTab(bridge, ctx);

    const c1 = await connectConsumer(bridge);
    const c2 = await connectConsumer(bridge);

    expect(c1.clientSessionId.length).toBeGreaterThan(0);
    expect(c2.clientSessionId.length).toBeGreaterThan(0);
    expect(c1.clientSessionId).not.toBe(c2.clientSessionId);

    // C1 sends worker-op
    await c1.op({ method: 'getVersion' });
    const opFrame1 = tab.receivedFrames.find(
      (f): f is WorkerOpFrame => f.type === 'worker-op' && (f as { clientSessionId?: string }).clientSessionId === c1.clientSessionId,
    );
    expect(opFrame1).toBeDefined();

    // C2 sends worker-op
    await c2.op({ method: 'getVersion' });
    const opFrame2 = tab.receivedFrames.find(
      (f): f is WorkerOpFrame => f.type === 'worker-op' && (f as { clientSessionId?: string }).clientSessionId === c2.clientSessionId,
    );
    expect(opFrame2).toBeDefined();
  });

  it('supports session resumption with existing clientSessionId', async () => {
    const bridge = createBridge({ version: 'test' });
    const c3 = await connectConsumer(bridge, 'resumed-session-123');
    expect(c3.clientSessionId).toBe('resumed-session-123');
  });

  it('routes auth operations and firestore rules per consumer without tab collision', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'alice', email: 'alice@example.com', password: 'password123' },
      { uid: 'bob', email: 'bob@example.com', password: 'password123' },
    ]);

    const c1 = await connectConsumer(bridge);
    const c2 = await connectConsumer(bridge);

    expect((await c1.op({ method: 'auth.signInEmail', email: 'alice@example.com', password: 'password123' })).ok).toBe(true);
    expect((await c2.op({ method: 'auth.signInEmail', email: 'bob@example.com', password: 'password123' })).ok).toBe(true);

    // C1 writes /notes/alice -> allowed
    expect((await c1.op({ method: 'setDoc', path: 'notes/alice', data: { text: 'Alice' } })).ok).toBe(true);

    // C1 writes /notes/bob -> denied
    const denied = await c1.op({ method: 'setDoc', path: 'notes/bob', data: { text: 'Forged' } });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toMatch(/permission-denied/);

    // C2 writes /notes/bob -> allowed
    expect((await c2.op({ method: 'setDoc', path: 'notes/bob', data: { text: 'Bob' } })).ok).toBe(true);
  });

  it('isolates real-time subscriptions between consumers', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'alice', email: 'alice@example.com', password: 'password123' },
      { uid: 'bob', email: 'bob@example.com', password: 'password123' },
    ]);

    const c1 = await connectConsumer(bridge);
    const c2 = await connectConsumer(bridge);

    c1.sub('c1-auth', { target: 'authState' });
    c2.sub('c2-auth', { target: 'authState' });
    await tick(20);

    expect(c1.snaps.length).toBeGreaterThan(0);
    expect(c2.snaps.length).toBeGreaterThan(0);

    const c2SnapsBefore = c2.snaps.length;

    // C1 signs in
    await c1.op({ method: 'auth.signInEmail', email: 'alice@example.com', password: 'password123' });
    await tick(20);

    // C1 received updated snap; C2 did not
    expect(c1.snaps.length).toBeGreaterThan(1);
    expect(c2.snaps.length).toBe(c2SnapsBefore);
  });

  it('re-issues consumer subscriptions with original clientSessionId on peer replacement', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);

    const c1 = await connectConsumer(bridge);
    c1.sub('c1-notes', { target: { __ref: 'doc', path: 'shared/note1' } });
    await tick();

    // Tab replacement occurs
    const tab2 = connectTab(bridge, ctx);
    await tick();

    // Tab 2 received re-issued sub with C1's sessionId
    const reissued = tab2.receivedFrames.find(
      (f): f is WorkerSubFrame => f.type === 'worker-sub' && (f as { clientSessionId?: string }).clientSessionId === c1.clientSessionId,
    );
    expect(reissued).toBeDefined();
    expect(reissued?.subId).toBeDefined();
  });

  it('consumer disconnect dispatches worker-client-disconnect to peer', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    const tab = connectTab(bridge, ctx);

    const c1 = await connectConsumer(bridge);
    c1.session.dispose();
    await tick();

    const discFrame = tab.receivedFrames.find(
      (f): f is WorkerClientDisconnectFrame => f.type === 'worker-client-disconnect' && f.clientSessionId === c1.clientSessionId,
    );
    expect(discFrame).toBeDefined();
  });
});
