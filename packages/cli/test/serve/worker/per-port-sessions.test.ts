/**
 * Per-port sessions drive DATA ops + listeners (#754 acceptance, worker seam).
 *
 * The multi-user headline without any Studio lens: each port signs in with a
 * REAL auth op, and its Firestore ops/subs (no `actAs`) evaluate rules under
 * that port's session — `request.auth.uid` and `request.auth.token.*` per
 * port, on one shared store with live cross-port fan-out.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import {
  bytesToBase64,
  type OutboundMessage,
  type ResMessage,
  type SnapMessage,
  type SerializedUserCredential,
} from '../../../src/serve/worker/protocol.js';
import type {
  SerializedIdTokenResult,
} from '../../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { getStorageSandbox } from 'pyric/storage';

// Owner-only claims + admin-gated collection: pins uid AND token claims.
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /claims/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /shared/{d} {
      allow read, write: if request.auth != null;
    }
    match /admins/{d} {
      allow read, write: if request.auth != null && request.auth.token['role'] == 'admin';
    }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /admins/{path=**} {
    allow read, write: if request.auth != null && request.auth.token['role'] == 'admin';
  }
}`;

function fakePort(): PortLike & { messages: OutboundMessage[]; snaps: SnapMessage[] } {
  const messages: OutboundMessage[] = [];
  const snaps: SnapMessage[] = [];
  return {
    messages,
    snaps,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') snaps.push(msg);
    },
  };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(RULES);
  setDatabaseRules(sandbox, {
    rules: {
      admins: {
        '.read': "auth != null && auth.token.role == 'admin'",
        '.write': "auth != null && auth.token.role == 'admin'",
      },
    },
  });
  getStorageSandbox(sandbox, {
    dbName: `per-port-session-${Math.random()}`,
    rules: STORAGE_RULES,
  });
  const auth = getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, subs: new Map(), auth } as HostCtx;
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
let _seq = 0;
const opId = (): string => `pps-${++_seq}`;

function lastRes(port: FakePort, id: string): ResMessage {
  const r = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!r) throw new Error(`no res ${id}`);
  return r;
}

async function op(ctx: HostCtx, port: FakePort, msg: Record<string, unknown>): Promise<ResMessage> {
  const id = opId();
  await handleMessage(ctx, port, { id, ...msg } as never);
  await tick();
  return lastRes(port, id);
}

async function signInAnon(ctx: HostCtx, port: FakePort): Promise<string> {
  const res = await op(ctx, port, { t: 'op', method: 'auth.signInAnonymously' });
  if (!res.ok) throw new Error('anon sign-in failed');
  return (res.value as SerializedUserCredential).user.uid;
}

describe('per-port sessions drive data ops (#754)', () => {
  it('each port writes as ITS OWN uid: own doc allowed, other port doc denied', async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    const uidA = await signInAnon(ctx, portA);
    const uidB = await signInAnon(ctx, portB);
    expect(uidA).not.toBe(uidB);

    // A writes A's doc — allowed.
    const own = await op(ctx, portA, { t: 'op', method: 'setDoc', path: `claims/${uidA}`, data: { ok: true } });
    expect(own.ok).toBe(true);

    // A writes B's doc — DENIED (request.auth.uid is A on port A).
    const theirs = await op(ctx, portA, { t: 'op', method: 'setDoc', path: `claims/${uidB}`, data: { ok: false } });
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(theirs.error.code).toMatch(/permission|denied/i);

    // And symmetrically for B.
    expect((await op(ctx, portB, { t: 'op', method: 'setDoc', path: `claims/${uidB}`, data: { ok: true } })).ok).toBe(true);
    expect((await op(ctx, portB, { t: 'op', method: 'setDoc', path: `claims/${uidA}`, data: { ok: false } })).ok).toBe(false);
  });

  it('a signed-out port is unauthenticated: authed-only writes are denied', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const res = await op(ctx, port, { t: 'op', method: 'setDoc', path: 'shared/x', data: { n: 1 } });
    expect(res.ok).toBe(false);
  });

  it("A's write reaches B's ACTIVE onSnapshot (as B's own session) — live multi-user sync", async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    await signInAnon(ctx, portA);
    await signInAnon(ctx, portB);

    // B opens a live sub with NO lens — it runs under B's session.
    await handleMessage(ctx, portB, { t: 'sub', subId: 'b-watch', target: { __ref: 'doc', path: 'shared/x' } });
    await tick();

    const write = await op(ctx, portA, { t: 'op', method: 'setDoc', path: 'shared/x', data: { by: 'A', n: 1 } });
    expect(write.ok).toBe(true);
    await tick();

    const last = portB.snaps.filter((s) => s.subId === 'b-watch').at(-1);
    const val = (last?.value ?? {}) as { exists?: boolean; data?: { json: string }; __error?: unknown };
    expect(val.__error).toBeUndefined();
    expect(val.exists).toBe(true);
    expect(JSON.parse(val.data!.json)).toEqual({ by: 'A', n: 1 });
  });

  it('custom claims ride the port session (request.auth.token.role)', async () => {
    const ctx = await makeCtx();
    const admin = fakePort();
    const pleb = fakePort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'boss', email: 'boss@example.com', password: 'password123', customClaims: { role: 'admin' } },
      { uid: 'norm', email: 'norm@example.com', password: 'password123' },
    ]);

    expect((await op(ctx, admin, { t: 'op', method: 'auth.signInEmail', email: 'boss@example.com', password: 'password123' })).ok).toBe(true);
    expect((await op(ctx, pleb, { t: 'op', method: 'auth.signInEmail', email: 'norm@example.com', password: 'password123' })).ok).toBe(true);

    expect((await op(ctx, admin, { t: 'op', method: 'setDoc', path: 'admins/x', data: { ok: true } })).ok).toBe(true);
    expect((await op(ctx, pleb, { t: 'op', method: 'setDoc', path: 'admins/y', data: { ok: false } })).ok).toBe(false);
  });

  it('does not reuse a same-uid data handle after refreshed claims change', async () => {
    const ctx = await makeCtx();
    const firstPort = fakePort();
    const refreshedPort = fakePort();

    authSandbox.seedUsers(ctx.auth!, [
      { uid: 'same-user', email: 'same@example.com', password: 'password123', customClaims: { role: 'admin' } },
    ]);
    expect((await op(ctx, firstPort, {
      t: 'op', method: 'auth.signInEmail', email: 'same@example.com', password: 'password123',
    })).ok).toBe(true);
    expect((await op(ctx, firstPort, {
      t: 'op', method: 'setDoc', path: 'admins/before-refresh', data: { ok: true },
    })).ok).toBe(true);

    expect((await op(ctx, firstPort, {
      t: 'op', method: 'auth.adminUpdateUser', uid: 'same-user', request: { customClaims: { role: 'member' } },
    })).ok).toBe(true);
    expect((await op(ctx, refreshedPort, {
      t: 'op', method: 'auth.restorePortSession', uid: 'same-user',
    })).ok).toBe(true);

    const afterRefresh = await op(ctx, refreshedPort, {
      t: 'op', method: 'setDoc', path: 'admins/after-refresh', data: { ok: false },
    });
    expect(afterRefresh.ok).toBe(false);
  });

  it('forced token refresh reauthorizes the same port across every data service and live listeners', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    authSandbox.seedUsers(ctx.auth!, [{
      uid: 'refresh-user',
      email: 'refresh@example.com',
      password: 'password123',
      customClaims: { role: 'admin' },
    }]);
    expect((await op(ctx, port, {
      t: 'op', method: 'auth.signInEmail', email: 'refresh@example.com', password: 'password123',
    })).ok).toBe(true);

    expect((await op(ctx, port, {
      t: 'op', method: 'setDoc', path: 'admins/live', data: { before: true },
    })).ok).toBe(true);
    expect((await op(ctx, port, {
      t: 'op', method: 'rtdb.set', path: 'admins/live', value: { before: true },
    })).ok).toBe(true);
    const storageBefore = await op(ctx, port, {
      t: 'op', method: 'storage.putBytes', path: 'admins/live.txt',
      dataB64: bytesToBase64(new TextEncoder().encode('before')),
    });
    expect(storageBefore.ok, JSON.stringify(storageBefore)).toBe(true);

    await handleMessage(ctx, port, {
      t: 'sub', subId: 'refresh-listener', target: { __ref: 'doc', path: 'admins/live' },
    });
    await tick();
    expect((port.snaps.at(-1)?.value as { __error?: unknown }).__error).toBeUndefined();

    expect((await op(ctx, port, {
      t: 'op', method: 'auth.adminUpdateUser', uid: 'refresh-user',
      request: { customClaims: { role: 'member' } },
    })).ok).toBe(true);
    const refreshed = await op(ctx, port, {
      t: 'op', method: 'auth.getIdTokenResult', forceRefresh: true,
    });
    expect(refreshed.ok).toBe(true);
    expect((refreshed.value as SerializedIdTokenResult).claims.role).toBe('member');
    await tick();

    expect((await op(ctx, port, {
      t: 'op', method: 'setDoc', path: 'admins/firestore-after', data: { after: true },
    })).ok).toBe(false);
    expect((await op(ctx, port, {
      t: 'op', method: 'rtdb.set', path: 'admins/rtdb-after', value: { after: true },
    })).ok).toBe(false);
    expect((await op(ctx, port, {
      t: 'op', method: 'storage.putBytes', path: 'admins/storage-after.txt',
      dataB64: bytesToBase64(new TextEncoder().encode('after')),
    })).ok).toBe(false);

    const listenerSnap = port.snaps.filter((snap) => snap.subId === 'refresh-listener').at(-1);
    expect(listenerSnap?.value).toMatchObject({
      __error: { code: expect.stringMatching(/permission|denied/i) },
    });
  });

  it('an explicit Studio lens still overrides the port session', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await signInAnon(ctx, port);

    // admin lens bypasses rules regardless of the port's session.
    const res = await op(ctx, port, {
      t: 'op', method: 'setDoc', path: 'admins/z', data: { seeded: true },
      actAs: { mode: 'admin' },
    });
    expect(res.ok).toBe(true);
  });
});
