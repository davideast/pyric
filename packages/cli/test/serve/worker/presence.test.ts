/**
 * Connected-page presence (#227) — worker host registry tests.
 *
 * Fake ports + controllable clock: registration, heartbeat renewal, clean
 * disconnect, stale lease expiry, duplicate logical-client registration,
 * multi-subscriber fan-out, and background-throttling survival (one delayed
 * heartbeat must not evict a live hidden page).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  handleMessage,
  cleanupPort,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import {
  setPresenceNow,
  resetPresenceNow,
  expireStalePresence,
  getPresenceSnapshot,
  PRESENCE_STALE_MS,
} from '../../../src/serve/worker/host/presence.js';
import type {
  InboundMessage,
  OutboundMessage,
  PresenceSnapshot,
  ResMessage,
  SnapMessage,
} from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

function fakePort(): PortLike & { messages: OutboundMessage[]; snapMessages: SnapMessage[] } {
  const messages: OutboundMessage[] = [];
  const snapMessages: SnapMessage[] = [];
  return {
    messages,
    snapMessages,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') snapMessages.push(msg);
    },
  };
}

type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(`
    rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /{document=**} { allow read, write: if true; }
      }
    }
  `);
  await sandbox.enablePersistence({
    key: `presence-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'test', subs: new Map() };
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  const id = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!res) throw new Error(`No res for ${id}`);
  return res;
}

function lastPresenceSnap(port: FakePort, subId: string): PresenceSnapshot | undefined {
  for (let i = port.snapMessages.length - 1; i >= 0; i--) {
    const m = port.snapMessages[i]!;
    if (m.subId === subId) return m.value as PresenceSnapshot;
  }
  return undefined;
}

describe('presence registry', () => {
  let ctx: HostCtx;
  let clock: number;

  beforeEach(async () => {
    ctx = await makeCtx();
    clock = 1_000_000;
    setPresenceNow(() => clock);
  });

  afterEach(() => {
    resetPresenceNow();
  });

  it('registers two logical clients and fans the snapshot to a subscriber', async () => {
    const app = fakePort();
    const studio = fakePort();
    const sub = fakePort();

    await handleMessage(ctx, sub, { t: 'sub', subId: 'p1', target: 'presence' });
    expect(lastPresenceSnap(sub, 'p1')?.clients).toEqual([]);

    await sendOp(ctx, app, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'app-1',
      kind: 'app',
      route: '/shop',
      visibility: 'visible',
    });
    await sendOp(ctx, studio, {
      t: 'op',
      id: 'r2',
      method: 'presence.register',
      clientId: 'studio-1',
      kind: 'studio',
      route: '/__pyric/studio/',
      visibility: 'visible',
    });

    const snap = lastPresenceSnap(sub, 'p1');
    expect(snap?.clients).toHaveLength(2);
    expect(snap?.clients.map((c) => c.clientId).sort()).toEqual(['app-1', 'studio-1']);
    expect(snap?.clients.find((c) => c.clientId === 'app-1')?.kind).toBe('app');
    expect(snap?.clients.find((c) => c.clientId === 'studio-1')?.kind).toBe('studio');
  });

  it('re-registering the same clientId does not duplicate the entry', async () => {
    const portA = fakePort();
    const portB = fakePort();
    await sendOp(ctx, portA, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'page-1',
      kind: 'app',
      route: '/a',
      visibility: 'visible',
    });
    clock += 5_000;
    await sendOp(ctx, portB, {
      t: 'op',
      id: 'r2',
      method: 'presence.register',
      clientId: 'page-1',
      kind: 'app',
      route: '/b',
      visibility: 'hidden',
    });
    const snap = getPresenceSnapshot(ctx);
    expect(snap.clients).toHaveLength(1);
    expect(snap.clients[0]?.route).toBe('/b');
    expect(snap.clients[0]?.visibility).toBe('hidden');
  });

  it('clean disconnect removes the client promptly', async () => {
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'page-1',
      kind: 'app',
      route: '/',
      visibility: 'visible',
    });
    expect(getPresenceSnapshot(ctx).clients).toHaveLength(1);
    await sendOp(ctx, port, {
      t: 'op',
      id: 'd1',
      method: 'presence.disconnect',
      clientId: 'page-1',
    });
    expect(getPresenceSnapshot(ctx).clients).toHaveLength(0);
  });

  it('stale lease expiry removes a client that never heartbeats', async () => {
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'gone',
      kind: 'app',
      route: '/',
      visibility: 'visible',
    });
    clock += PRESENCE_STALE_MS + 1;
    expect(expireStalePresence(ctx)).toBe(true);
    expect(getPresenceSnapshot(ctx).clients).toHaveLength(0);
  });

  it('one delayed heartbeat under background throttling does not evict a live page', async () => {
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'bg',
      kind: 'app',
      route: '/',
      visibility: 'hidden',
    });
    // Advance just under the stale threshold (one delayed heartbeat survives).
    clock += PRESENCE_STALE_MS - 1_000;
    await sendOp(ctx, port, {
      t: 'op',
      id: 'h1',
      method: 'presence.heartbeat',
      clientId: 'bg',
    });
    clock += PRESENCE_STALE_MS - 1_000;
    expect(expireStalePresence(ctx)).toBe(false);
    expect(getPresenceSnapshot(ctx).clients).toHaveLength(1);
  });

  it('cleanupPort removes a client when it was the last associated port', async () => {
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'page-1',
      kind: 'studio',
      route: '/',
      visibility: 'visible',
    });
    cleanupPort(ctx, port);
    expect(getPresenceSnapshot(ctx).clients).toHaveLength(0);
  });

  it('fans presence updates to multiple subscribers', async () => {
    const a = fakePort();
    const b = fakePort();
    await handleMessage(ctx, a, { t: 'sub', subId: 'sa', target: 'presence' });
    await handleMessage(ctx, b, { t: 'sub', subId: 'sb', target: 'presence' });
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'x',
      kind: 'app',
      route: '/x',
      visibility: 'visible',
    });
    expect(lastPresenceSnap(a, 'sa')?.clients).toHaveLength(1);
    expect(lastPresenceSnap(b, 'sb')?.clients).toHaveLength(1);
  });

  it('presence.update refreshes route and visibility', async () => {
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op',
      id: 'r1',
      method: 'presence.register',
      clientId: 'p',
      kind: 'app',
      route: '/old',
      visibility: 'visible',
    });
    await sendOp(ctx, port, {
      t: 'op',
      id: 'u1',
      method: 'presence.update',
      clientId: 'p',
      route: '/new',
      visibility: 'hidden',
    });
    const c = getPresenceSnapshot(ctx).clients[0];
    expect(c?.route).toBe('/new');
    expect(c?.visibility).toBe('hidden');
  });
});
