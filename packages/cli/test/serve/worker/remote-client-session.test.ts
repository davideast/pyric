/**
 * Remote Client Session Isolation in SharedWorker host (M1).
 *
 * Asserts:
 * - Physical browser port session isolation ($S_0 / U_0$ unaffected by remote clients).
 * - Multi-client concurrent remote sessions ($C_1 / U_1$, $C_2 / U_2$).
 * - Auth subscription stream isolation (authState/idToken scoped per client).
 * - Firestore rules evaluation under client session vs explicit actAs AuthLens.
 * - Client disconnect cleanup and virtual port teardown without affecting physical port.
 * - Peer failover re-binding physicalPort on virtual port.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
  SerializedUser,
} from '../../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getOrCreateRemoteClientPort } from '../../../src/serve/worker/remote-client-port.js';
import { relayWorkerSub } from '../../../src/serve/worker/client/connection.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /shared/{doc} {
      allow read, write: if request.auth != null;
    }
    match /admins/{doc} {
      allow read, write: if request.auth != null && request.auth.token['role'] == 'admin';
    }
    match /public/{doc} {
      allow read, write: if true;
    }
  }
}`;

interface FakePhysicalPort extends PortLike {
  messages: OutboundMessage[];
  snaps: SnapMessage[];
  resList: ResMessage[];
  messagesFor(clientSessionId?: string): OutboundMessage[];
  snapsFor(subId: string, clientSessionId?: string): SnapMessage[];
  lastRes(id: string, clientSessionId?: string): ResMessage | undefined;
}

function fakePhysicalPort(): FakePhysicalPort {
  const messages: OutboundMessage[] = [];
  const snaps: SnapMessage[] = [];
  const resList: ResMessage[] = [];
  return {
    messages,
    snaps,
    resList,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') snaps.push(msg);
      if (msg.t === 'res') resList.push(msg);
    },
    messagesFor(clientSessionId?: string) {
      return messages.filter((m) => (m as { clientSessionId?: string }).clientSessionId === clientSessionId);
    },
    snapsFor(subId: string, clientSessionId?: string) {
      return snaps.filter((s) => s.subId === subId && (s as { clientSessionId?: string }).clientSessionId === clientSessionId);
    },
    lastRes(id: string, clientSessionId?: string) {
      return resList.find((r) => r.id === id && (r as { clientSessionId?: string }).clientSessionId === clientSessionId);
    },
  };
}

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(RULES);
  const auth = getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, subs: new Map(), auth } as HostCtx;
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
let _seq = 0;
const nextOpId = (): string => `rcs-${++_seq}`;

async function sendOp(
  ctx: HostCtx,
  port: FakePhysicalPort,
  msg: Record<string, unknown>,
  clientSessionId?: string,
): Promise<ResMessage> {
  const id = nextOpId();
  const inbound = {
    id,
    ...msg,
    ...(clientSessionId ? { clientSessionId } : {}),
  } as InboundMessage;
  await handleMessage(ctx, port, inbound);
  await tick();
  const res = port.lastRes(id, clientSessionId);
  if (!res) throw new Error(`no res for op ${id} (clientSessionId: ${clientSessionId})`);
  return res;
}

async function sendSub(
  ctx: HostCtx,
  port: FakePhysicalPort,
  msg: Record<string, unknown>,
  clientSessionId?: string,
): Promise<void> {
  const inbound = {
    t: 'sub',
    ...msg,
    ...(clientSessionId ? { clientSessionId } : {}),
  } as InboundMessage;
  await handleMessage(ctx, port, inbound);
  await tick();
}

async function getCurrentUser(
  ctx: HostCtx,
  port: FakePhysicalPort,
  clientSessionId?: string,
): Promise<SerializedUser | null> {
  const res = await sendOp(ctx, port, { t: 'op', method: 'auth.getCurrentUser' }, clientSessionId);
  if (!res.ok) throw new Error(`getCurrentUser failed: ${res.error.code} ${res.error.message}`);
  return res.value as SerializedUser | null;
}

describe('remote client session isolation in SharedWorker host (M1)', () => {
  it('remote client sign-in does not mutate physical browser port session', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'u0', email: 'browser@example.com', password: 'password123' },
      { uid: 'u1', email: 'c1@example.com', password: 'password123' },
    ]);

    // Physical browser port signs in as u0
    expect((await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'browser@example.com', password: 'password123',
    })).ok).toBe(true);
    expect((await getCurrentUser(ctx, port))?.uid).toBe('u0');

    // Remote client C1 signs in as u1
    const c1Res = await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'c1@example.com', password: 'password123',
    }, 'C1');
    expect(c1Res.ok).toBe(true);
    expect((c1Res as { clientSessionId?: string }).clientSessionId).toBe('C1');

    // Physical port remains u0, remote client C1 is u1
    expect((await getCurrentUser(ctx, port))?.uid).toBe('u0');
    expect((await getCurrentUser(ctx, port, 'C1'))?.uid).toBe('u1');

    // Remote client C1 signs out
    expect((await sendOp(ctx, port, { t: 'op', method: 'auth.signOut' }, 'C1')).ok).toBe(true);
    expect(await getCurrentUser(ctx, port, 'C1')).toBeNull();
    expect((await getCurrentUser(ctx, port))?.uid).toBe('u0');
  });

  it('multiple remote clients maintain distinct concurrent sessions', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'alice-uid', email: 'alice@example.com', password: 'password123' },
      { uid: 'bob-uid', email: 'bob@example.com', password: 'password123' },
    ]);

    await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'alice@example.com', password: 'password123',
    }, 'C1');
    await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'bob@example.com', password: 'password123',
    }, 'C2');

    expect((await getCurrentUser(ctx, port, 'C1'))?.email).toBe('alice@example.com');
    expect((await getCurrentUser(ctx, port, 'C2'))?.email).toBe('bob@example.com');
    expect(await getCurrentUser(ctx, port)).toBeNull(); // Tab is signed out
  });

  it('auth subscriptions stream only events for their owning client', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'alice-uid', email: 'alice@example.com', password: 'password123' },
      { uid: 'bob-uid', email: 'bob@example.com', password: 'password123' },
    ]);

    await sendSub(ctx, port, { target: 'authState', subId: 'tab-auth' });
    await sendSub(ctx, port, { target: 'authState', subId: 'c1-auth' }, 'C1');
    await sendSub(ctx, port, { target: 'authState', subId: 'c2-auth' }, 'C2');

    expect(port.snapsFor('tab-auth').at(-1)?.value).toBeNull();
    expect(port.snapsFor('c1-auth', 'C1').at(-1)?.value).toBeNull();
    expect(port.snapsFor('c2-auth', 'C2').at(-1)?.value).toBeNull();

    const c2CountBefore = port.snapsFor('c2-auth', 'C2').length;
    const tabCountBefore = port.snapsFor('tab-auth').length;

    // C1 signs in as Alice
    await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'alice@example.com', password: 'password123',
    }, 'C1');

    expect((port.snapsFor('c1-auth', 'C1').at(-1)?.value as SerializedUser)?.email).toBe('alice@example.com');
    expect(port.snapsFor('c2-auth', 'C2').length).toBe(c2CountBefore);
    expect(port.snapsFor('tab-auth').length).toBe(tabCountBefore);
  });

  it('firestore rules evaluate under client session without actAs', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'alice', email: 'alice@example.com', password: 'password123' },
      { uid: 'bob', email: 'bob@example.com', password: 'password123' },
    ]);

    await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'alice@example.com', password: 'password123',
    }, 'C1');
    await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'bob@example.com', password: 'password123',
    }, 'C2');

    // Alice writes Alice's doc -> allowed
    const aliceOwn = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'users/alice', data: { name: 'Alice' },
    }, 'C1');
    expect(aliceOwn.ok).toBe(true);

    // Alice writes Bob's doc -> denied
    const aliceTheirs = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'users/bob', data: { name: 'Forged' },
    }, 'C1');
    expect(aliceTheirs.ok).toBe(false);
    if (!aliceTheirs.ok) expect(aliceTheirs.error.code).toMatch(/permission|denied/i);

    // Bob writes Bob's doc -> allowed
    const bobOwn = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'users/bob', data: { name: 'Bob' },
    }, 'C2');
    expect(bobOwn.ok).toBe(true);
  });

  it('explicit actAs overrides client session and app-session resolves client session', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'alice', email: 'alice@example.com', password: 'password123' },
    ]);
    await sendOp(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'alice@example.com', password: 'password123',
    }, 'C1');

    // Act as bob on C1 -> writes Bob's doc successfully
    const asBob = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'users/bob', data: { name: 'Bob by proxy' },
      actAs: { mode: 'as', uid: 'bob' },
    }, 'C1');
    expect(asBob.ok).toBe(true);

    // Admin lens on C1 bypasses rules
    const adminOp = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'admins/cfg', data: { secret: 1 },
      actAs: { mode: 'admin' },
    }, 'C1');
    expect(adminOp.ok).toBe(true);

    // app-session on C1 resolves to C1 session (Alice)
    const appSessionAlice = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'users/alice', data: { updated: true },
      actAs: { mode: 'app-session' },
    }, 'C1');
    expect(appSessionAlice.ok).toBe(true);

    // anon on C1 evaluates unauthenticated -> denied
    const anonOp = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'users/alice', data: { updated: false },
      actAs: { mode: 'anon' },
    }, 'C1');
    expect(anonOp.ok).toBe(false);
  });

  it('disconnect cleans up client virtual port and listeners without affecting physical port', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    // Open listeners on physical port and C1
    await sendSub(ctx, port, { target: { __ref: 'doc', path: 'public/doc1' }, subId: 'tab-sub' });
    await sendSub(ctx, port, { target: { __ref: 'doc', path: 'public/doc1' }, subId: 'c1-sub' }, 'C1');

    // Disconnect C1
    const disc = await sendOp(ctx, port, { t: 'disconnect', method: 'disconnect' }, 'C1');
    expect(disc.ok).toBe(true);

    // Physical port is still active and accepts operations (NOT app-deleted)
    const versionRes = await sendOp(ctx, port, { t: 'op', method: 'getVersion' });
    expect(versionRes.ok).toBe(true);

    // Write to public/doc1: tab listener receives it; C1 listener does not
    const c1SnapsBefore = port.snapsFor('c1-sub', 'C1').length;
    await sendOp(ctx, port, { t: 'op', method: 'setDoc', path: 'public/doc1', data: { v: 2 } });

    expect(port.snapsFor('tab-sub').length).toBeGreaterThan(1);
    expect(port.snapsFor('c1-sub', 'C1').length).toBe(c1SnapsBefore);

    // Subsequent operation on disconnected C1 is rejected with app/app-deleted
    const deletedRes = await sendOp(ctx, port, { t: 'op', method: 'getVersion' }, 'C1');
    expect(deletedRes.ok).toBe(false);
    if (!deletedRes.ok) {
      expect(deletedRes.error.code).toBe('app/app-deleted');
    }
  });

  it('peer failover updates physical port reference while preserving session', async () => {
    const ctx = await makeCtx();
    const tab1 = fakePhysicalPort();
    const tab2 = fakePhysicalPort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'u1', email: 'c1@example.com', password: 'password123' },
    ]);

    // Sign in on tab1 with clientSessionId: 'C1'
    await sendOp(ctx, tab1, {
      t: 'op', method: 'auth.signInEmail', email: 'c1@example.com', password: 'password123',
    }, 'C1');

    // Tab 1 closes. Message arrives on tab2 with clientSessionId: 'C1'
    const currentUserRes = await sendOp(ctx, tab2, { t: 'op', method: 'auth.getCurrentUser' }, 'C1');
    expect(currentUserRes.ok).toBe(true);
    expect((currentUserRes.value as SerializedUser)?.email).toBe('c1@example.com');

    // Ensure virtualPort.physicalPort was re-bound to tab2
    const virtualPort = ctx.remoteClientPorts?.get('C1') as import('../../../src/serve/worker/remote-client-port.js').RemoteClientPort;
    expect(virtualPort).toBeDefined();
    expect(virtualPort.physicalPort).toBe(tab2);
  });

  it('subscribing to a disconnected client session returns app/app-deleted snap error', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    // Disconnect C1
    await sendOp(ctx, port, { t: 'disconnect', method: 'disconnect' }, 'C1');

    // Subscribe on disconnected C1
    await sendSub(ctx, port, { target: { __ref: 'doc', path: 'public/doc1' }, subId: 'sub-after-disc' }, 'C1');

    const snaps = port.snapsFor('sub-after-disc', 'C1');
    expect(snaps.length).toBe(1);
    expect(snaps[0].value).toMatchObject({
      __error: { code: 'app/app-deleted' },
    });
  });

  it('malformed actAs in handleOp replies with failure frame', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    const res = await sendOp(ctx, port, {
      t: 'op', method: 'setDoc', path: 'public/doc1', data: { a: 1 },
      actAs: { mode: 'as', uid: '' },
    }, 'C1');

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('malformed actAs in handleSub replies with error snapshot frame', async () => {
    const ctx = await makeCtx();
    const port = fakePhysicalPort();

    await sendSub(ctx, port, {
      target: { __ref: 'doc', path: 'public/doc1' },
      subId: 'sub-bad-lens',
      actAs: { mode: 'as', uid: '' } as any,
    }, 'C1');

    const snaps = port.snapsFor('sub-bad-lens', 'C1');
    expect(snaps.length).toBe(1);
    expect(snaps[0].value).toMatchObject({
      __error: expect.any(Object),
    });
  });

  it('peer failover tears down stale subscriptions and re-registers fresh listeners emitting initial snapshots without zombie leaks', async () => {
    const ctx = await makeCtx();
    const tab1 = fakePhysicalPort();
    const tab2 = fakePhysicalPort();

    // 1. Establish subscription on tab1 under clientSessionId 'C1'
    await sendSub(ctx, tab1, { target: { __ref: 'doc', path: 'public/doc1' }, subId: 'sub-1' }, 'C1');
    expect(tab1.snapsFor('sub-1', 'C1').length).toBe(1);

    const virtualPort = ctx.remoteClientPorts?.get('C1')!;
    expect(ctx.subs.get(virtualPort)?.size).toBe(1);

    // 2. Data mutation occurs
    await sendOp(ctx, tab1, { t: 'op', method: 'setDoc', path: 'public/doc1', data: { value: 'updated' } });
    expect(tab1.snapsFor('sub-1', 'C1').length).toBe(2);

    // 3. Tab 1 disconnects / Tab 2 connects. Re-issue subscription on tab2 with same subId
    await sendSub(ctx, tab2, { target: { __ref: 'doc', path: 'public/doc1' }, subId: 'sub-1' }, 'C1');

    // Tab 2 MUST receive the initial snapshot with current data
    const tab2Snaps = tab2.snapsFor('sub-1', 'C1');
    expect(tab2Snaps.length).toBe(1);
    const snapVal = tab2Snaps[0].value as any;
    expect(JSON.parse(snapVal.data.json).value).toBe('updated');

    // Subscription count on virtualPort must remain exactly 1 (no zombie leak)
    expect(ctx.subs.get(virtualPort)?.size).toBe(1);

    // 4. Further data mutation: ONLY tab2 listener fires
    const tab1CountBefore = tab1.snapsFor('sub-1', 'C1').length;
    await sendOp(ctx, tab2, { t: 'op', method: 'setDoc', path: 'public/doc1', data: { value: 'final' } });

    expect(tab1.snapsFor('sub-1', 'C1').length).toBe(tab1CountBefore); // Tab 1 received NO phantom snap
    expect(tab2.snapsFor('sub-1', 'C1').length).toBe(2); // Tab 2 received the update
  });

  it('relayWorkerSub teardown sends single scoped unsub message', () => {
    const sent: InboundMessage[] = [];
    const port: import('../../../src/serve/worker/client/handles.js').ClientPort = {
      onmessage: null,
      postMessage(msg: InboundMessage) {
        sent.push(msg);
      },
      start() {},
      close() {},
    };
    const db: import('../../../src/serve/worker/client/handles.js').ClientDb = {
      __kind: 'client-db',
      port,
      appOptions: { projectId: 'test' },
      channel: null as any,
    };

    const unsub = relayWorkerSub(
      db,
      { target: { __ref: 'doc', path: 'public/test' } } as any,
      () => {},
      'C-relay-1',
    );
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ t: 'sub', clientSessionId: 'C-relay-1' });

    sent.length = 0;
    unsub();
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ t: 'unsub', clientSessionId: 'C-relay-1' });
  });
});
