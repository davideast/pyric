/**
 * Auth-lens resolution for the SharedWorker host (Pyric Studio T2).
 *
 * GOAL
 * ----
 * Prove `lensDb`'s per-op `actAs` resolution over the REAL worker host:
 *   - `{ mode: 'as', uid }` → security rules evaluate AS that uid
 *     (impersonation — the rules-debugging primitive). A signed-OUT app
 *     session can still read/write a doc the rules allow for `uid`.
 *   - absent / `{ mode: 'app-session' }` → the app's live session (here:
 *     signed out), so the same auth-gated op is DENIED.
 *   - `{ mode: 'admin' }` → resolves to the app session today (documented
 *     gap: true rule-bypass through the modular surface isn't exposed by
 *     pyric yet), so under auth-gated rules with no session it is denied.
 *
 * STRATEGY (mirrors security-per-user.test.ts)
 * --------------------------------------------
 * Build a REAL pyric sandbox + a shared `getFirestore(sandbox)` (the
 * sandbox-live "app session" handle), wire a fake MessagePort, and drive
 * `handleMessage()` directly. We deploy per-user rules and verify that the
 * SAME op (same path/data) flips allow↔deny purely on the `actAs` lens —
 * with the app itself signed OUT the whole time.
 */

import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SerializedUserCredential,
  TargetDescriptor,
} from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';

// ─── Rules: owner-gated notes (request.auth.uid drives access) ─────────────

const PER_USER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read:   if request.auth != null && resource.data.owner == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.owner == request.auth.uid;
    }
  }
}`;

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

// ─── Fake port + tiny driver (mirrors security-per-user.test.ts) ───────────

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    postMessage(msg: OutboundMessage) { messages.push(msg); },
  };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `auth-lens-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  getAuth(sandbox);
  const db = getFirestore(sandbox);
  return { db, sandbox, subs: new Map(), sessionMode: 'LOCAL' };
}

function tick(ms = 0): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

let _seq = 0;
function id(): string { return `lens-op-${++_seq}`; }

function getRes(port: FakePort, opId: string): ResMessage | undefined {
  return port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  await tick();
  const res = getRes(port, (msg as { id: string }).id);
  if (!res) throw new Error(`No res for ${(msg as { id: string }).id}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

/** Create alice, seed her note under permissive rules, deploy per-user rules,
 *  then sign the app fully OUT so the only access path is an `actAs` lens. */
async function setup(ctx: HostCtx, port: FakePort): Promise<{ aliceUid: string; alicePath: string }> {
  const created = await sendOp(ctx, port, {
    t: 'op', id: id(), method: 'auth.createUser', email: 'alice@example.com', password: 'pw-alice',
  });
  const aliceUid = okValue<SerializedUserCredential>(created).user.uid;

  const seed = await sendOp(ctx, port, {
    t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
    data: { text: "alice's note", owner: aliceUid },
  });
  const alicePath = okValue<{ path: string }>(seed).path;

  await sendOp(ctx, port, { t: 'op', id: id(), method: 'setRules', source: PER_USER_RULES });
  await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signOut' });

  return { aliceUid, alicePath };
}

function noteByOwner(owner: string): TargetDescriptor {
  return {
    __ref: 'query',
    source: { __ref: 'collection', path: 'notes' },
    constraints: [{ kind: 'where', field: 'owner', op: '==', value: owner }],
  };
}

// ════════════════════════════════════════════════════════════════════════
//  Impersonation read: { mode: 'as', uid } evaluates rules AS that uid
// ════════════════════════════════════════════════════════════════════════

describe('auth lens — impersonation read (as:uid)', () => {
  it("reads alice's note when actAs={mode:'as', uid:alice} even though the app is signed out", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid, alicePath } = await setup(ctx, port);

    // App session is signed out → the same getDoc with no lens is DENIED…
    const denied = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: alicePath,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('permission-denied');

    // …but with the impersonation lens it is ALLOWED (rules see request.auth.uid == alice).
    const allowed = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: alicePath, actAs: { mode: 'as', uid: aliceUid },
    });
    expect(allowed.ok).toBe(true);
    const snap = okValue<{ exists: boolean; data?: { json: string } }>(allowed);
    expect(snap.exists).toBe(true);
    expect(JSON.parse(snap.data!.json).text).toBe("alice's note");
  });

  it("a scoped query as alice returns her note; the same query with no lens is denied", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setup(ctx, port);

    const denied = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs', source: noteByOwner(aliceUid),
    });
    expect(denied.ok).toBe(false);

    const allowed = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs', source: noteByOwner(aliceUid), actAs: { mode: 'as', uid: aliceUid },
    });
    const value = okValue<{ docs: Array<{ data: { json: string } }> }>(allowed);
    expect(value.docs.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Impersonation write: gated by the CALLER (read-as always; write-as is a
//  deliberate "reproduce" path). The resolver itself supports write-as-user.
// ════════════════════════════════════════════════════════════════════════

describe('auth lens — impersonation write (as:uid)', () => {
  it("writes a note as alice via actAs even though the app is signed out", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setup(ctx, port);

    // No lens (signed out) → create denied.
    const denied = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: 'second', owner: aliceUid },
    });
    expect(denied.ok).toBe(false);

    // As alice → create allowed (the explicit reproduce path).
    const allowed = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: 'second', owner: aliceUid }, actAs: { mode: 'as', uid: aliceUid },
    });
    expect(allowed.ok).toBe(true);
  });

  it("cannot forge a note owned by someone else even under impersonation", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setup(ctx, port);

    // Impersonating alice but stamping owner=bob → rules still deny.
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: 'forged', owner: `${aliceUid}-not` }, actAs: { mode: 'as', uid: aliceUid },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Default lenses: absent / app-session use the app session; admin bypasses
//  rules (Gap #2 — modular `getAdminFirestore` handle, cached on ctx.adminDb).
// ════════════════════════════════════════════════════════════════════════

describe('auth lens — default lenses use the app session', () => {
  it('absent and app-session behave like the signed-out app (denied)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { alicePath } = await setup(ctx, port);

    for (const actAs of [undefined, { mode: 'app-session' as const }]) {
      const res = await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'getDoc', path: alicePath,
        ...(actAs ? { actAs } : {}),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('permission-denied');
    }
  });

  it('admin lens bypasses rules — reads the doc the signed-out app is denied', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { alicePath } = await setup(ctx, port);

    expect(ctx.adminDb).toBeUndefined();

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: alicePath, actAs: { mode: 'admin' as const },
    });
    expect(res.ok).toBe(true);
    // The admin handle is built once and cached on the ctx.
    expect(ctx.adminDb).toBeDefined();
    const firstAdmin = ctx.adminDb;
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: alicePath, actAs: { mode: 'admin' as const },
    });
    expect(ctx.adminDb).toBe(firstAdmin);
  });

  it('caches one impersonation handle per uid (lensHandles populated on first as:uid op)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid, alicePath } = await setup(ctx, port);

    expect(ctx.lensHandles).toBeUndefined();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: alicePath, actAs: { mode: 'as', uid: aliceUid },
    });
    expect(ctx.lensHandles?.has(aliceUid)).toBe(true);
    const firstHandle = ctx.lensHandles!.get(aliceUid);

    // A second as:alice op reuses the same cached handle.
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: alicePath, actAs: { mode: 'as', uid: aliceUid },
    });
    expect(ctx.lensHandles!.get(aliceUid)).toBe(firstHandle);
    expect(ctx.lensHandles!.size).toBe(1);
  });
});
