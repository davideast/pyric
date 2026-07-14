/**
 * `{ mode: 'anon' }` auth lens — genuinely UNAUTHENTICATED ops (remote
 * sandbox, slice 2; spike GAP 5).
 *
 * THE HAZARD UNDER TEST
 * ---------------------
 * A relayed op with NO lens resolves to the PORT'S SESSION — whoever the
 * browser tab happens to be signed in as. Remote code that means "no auth"
 * (`getFirestore(sandbox.withAuth(null))`) must therefore pin
 * `{ mode: 'anon' }`; without the lens, "anonymous" silently runs as the
 * tab's user. These tests prove, for EVERY lens-resolving service
 * (Firestore via `lensDb`, RTDB via `lensRtdb`, Storage via `lensStorage`,
 * and Firestore subscriptions via `handleSub`→`lensDb`):
 *
 *   - anon        → rules see `request.auth == null` / `auth == null`
 *   - absent      → the port's session (signed-in uid) — the leak the lens
 *                   exists to avoid
 *   - as-uid      → rules evaluate as that uid
 *   - admin       → rules bypassed
 *
 * The rules DISTINGUISH all four: an auth-gated zone (auth required) and an
 * anon-only zone (auth must be ABSENT) — so anon can't be confused with a
 * signed-in identity in either direction, and admin is provably a bypass
 * (it writes where every authenticated identity is denied).
 *
 * Harness: REAL sandbox + fake ports driving `handleMessage()` directly
 * (mirrors auth-lens.test.ts / storage-ops.test.ts).
 */

import 'fake-indexeddb/auto';
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
  SnapMessage,
  SerializedUserCredential,
} from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { getAuth } from 'pyric/auth';

// ─── Rules that DISTINGUISH the four lenses ────────────────────────────────

// /notes: any signed-in user. /anonOnly: ONLY the unauthenticated context —
// a signed-in session (or the `as` lens) is denied there, so an anon op that
// accidentally carried an identity fails loudly.
const FS_LENS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
    match /anonOnly/{id} {
      allow read, write: if request.auth == null;
    }
  }
}`;

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const RTDB_LENS_RULES = {
  rules: {
    notes: { '.read': 'auth != null', '.write': 'auth != null' },
    anonOnly: { '.read': 'auth == null', '.write': 'auth == null' },
  },
};

const STORAGE_LENS_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /notes/{file} {
      allow read, write: if request.auth != null;
    }
    match /anonOnly/{file} {
      allow read, write: if request.auth == null;
    }
  }
}`;

// ─── Harness ────────────────────────────────────────────────────────────────

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

let dbSeq = 0;
async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  // Firestore rules start permissive (seeding); each test deploys the lens
  // rules through the real host op. Storage rules are first-call-per-sandbox,
  // so they're configured here, up front.
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  getStorageSandbox(sandbox, {
    dbName: `pyric-anon-lens-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`,
    rules: STORAGE_LENS_RULES,
  });
  await sandbox.enablePersistence({
    key: `anon-lens-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'anon-lens-test', subs: new Map(), sessionMode: 'LOCAL' };
}

function tick(ms = 0): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

let _seq = 0;
function id(): string { return `anon-op-${++_seq}`; }

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  await tick();
  const opId = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
  if (!res) throw new Error(`No res for ${opId}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

/** Per-service denial codes: Firestore `permission-denied`, RTDB
 *  `PERMISSION_DENIED`, Storage `storage/unauthorized`. */
function expectDenied(res: ResMessage, code = 'permission-denied'): void {
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error.code).toBe(code);
}

/** Create + leave signed IN on `port` (the port session — the leak vector). */
async function signInAlice(ctx: HostCtx, port: FakePort): Promise<string> {
  const res = await sendOp(ctx, port, {
    t: 'op', id: id(), method: 'auth.createUser',
    email: 'alice@example.com', password: 'pw-alice',
  });
  return okValue<SerializedUserCredential>(res).user.uid;
}

async function deployFsRules(ctx: HostCtx, port: FakePort): Promise<void> {
  okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'setRules', source: FS_LENS_RULES }));
}

// ════════════════════════════════════════════════════════════════════════════

describe('anon lens — Firestore (lensDb)', () => {
  it('anon vs port-session vs as-uid vs admin, distinguished by rules', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const aliceUid = await signInAlice(ctx, port); // port session: alice
    await deployFsRules(ctx, port);

    // Absent lens → the PORT'S SESSION: the auth-gated write is ALLOWED.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'notes/session', data: { by: 'session' },
    }));

    // THE GAP-5 REGRESSION: the same op with the anon lens must NOT inherit
    // the signed-in port session — auth-gated read AND write are denied.
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'notes/anon', data: { by: 'anon' },
      actAs: { mode: 'anon' },
    }));
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: 'notes/session',
      actAs: { mode: 'anon' },
    }));

    // …and the anon lens IS genuinely unauthenticated: the anon-ONLY zone
    // (request.auth == null) admits it while denying every signed identity.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'anonOnly/probe', data: { by: 'anon' },
      actAs: { mode: 'anon' },
    }));
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'anonOnly/leak', data: { by: 'session' },
    })); // port session (signed in) — denied where auth must be absent
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'anonOnly/leak', data: { by: 'as' },
      actAs: { mode: 'as', uid: aliceUid },
    }));

    // as-uid → auth-gated zone allowed (rules evaluate as alice).
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: 'notes/session',
      actAs: { mode: 'as', uid: aliceUid },
    }));

    // admin → bypass everywhere, including the anon-only zone.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'anonOnly/admin', data: { by: 'admin' },
      actAs: { mode: 'admin' },
    }));
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: 'notes/session',
      actAs: { mode: 'admin' },
    }));
  });

  it('subscriptions honor the anon lens (handleSub → lensDb)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await signInAlice(ctx, port);
    await deployFsRules(ctx, port);

    // Anon-lensed listener on the auth-gated doc → snap-error, even though
    // the port itself is signed in.
    await handleMessage(ctx, port, {
      t: 'sub', subId: 'anon-sub-1', target: { __ref: 'doc', path: 'notes/x' },
      actAs: { mode: 'anon' },
    });
    await tick(10);
    const errSnap = port.snaps.find((s) => s.subId === 'anon-sub-1');
    expect(errSnap).toBeDefined();
    const v = (errSnap!.value ?? {}) as { __error?: { code: string } };
    expect(v.__error?.code).toBe('permission-denied');

    // The SAME target without a lens (port session) delivers a snapshot.
    await handleMessage(ctx, port, {
      t: 'sub', subId: 'session-sub-1', target: { __ref: 'doc', path: 'notes/x' },
    });
    await tick(10);
    const okSnap = port.snaps.find((s) => s.subId === 'session-sub-1');
    expect(okSnap).toBeDefined();
    expect((okSnap!.value as { __error?: unknown }).__error).toBeUndefined();
  });
});

describe('anon lens — RTDB (lensRtdb)', () => {
  it('anon vs port-session vs as-uid vs admin, distinguished by rules', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const aliceUid = await signInAlice(ctx, port);
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDatabaseRules', source: RTDB_LENS_RULES,
    }));

    // Absent lens → the port's session (alice): auth-gated write allowed.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.set', path: 'notes/session', value: 1,
    }));

    // Anon lens: auth-gated zone denied (no session leak)…
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.set', path: 'notes/anon', value: 1,
      actAs: { mode: 'anon' },
    }), 'PERMISSION_DENIED');
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.get', path: 'notes/session',
      actAs: { mode: 'anon' },
    }), 'PERMISSION_DENIED');
    // …anon-only zone allowed (genuinely `auth == null`).
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.set', path: 'anonOnly/probe', value: 1,
      actAs: { mode: 'anon' },
    }));
    // The signed identities are denied in the anon-only zone.
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.set', path: 'anonOnly/leak', value: 1,
    }), 'PERMISSION_DENIED');
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.set', path: 'anonOnly/leak', value: 1,
      actAs: { mode: 'as', uid: aliceUid },
    }), 'PERMISSION_DENIED');

    // as-uid → auth-gated zone allowed; admin → bypass everywhere.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.get', path: 'notes/session',
      actAs: { mode: 'as', uid: aliceUid },
    }));
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'rtdb.set', path: 'anonOnly/admin', value: 1,
      actAs: { mode: 'admin' },
    }));
  });
});

describe('anon lens — Storage (lensStorage)', () => {
  const put = (path: string, actAs?: { mode: 'anon' } | { mode: 'admin' } | { mode: 'as'; uid: string }): InboundMessage => ({
    t: 'op', id: id(), method: 'storage.putBytes', path,
    dataB64: bytesToBase64(new Uint8Array([1, 2, 3])), contentType: 'application/octet-stream',
    ...(actAs ? { actAs } : {}),
  });

  it('anon vs absent vs as-uid vs admin, distinguished by rules', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const aliceUid = await signInAlice(ctx, port);

    // Anon lens: auth-gated zone denied, anon-only zone allowed.
    expectDenied(await sendOp(ctx, port, put('notes/a.bin', { mode: 'anon' })), 'storage/unauthorized');
    okValue(await sendOp(ctx, port, put('anonOnly/a.bin', { mode: 'anon' })));

    // Absent lens uses this port's app session, just like Firestore and RTDB.
    okValue(await sendOp(ctx, port, put('notes/b.bin')));
    expectDenied(await sendOp(ctx, port, put('anonOnly/b.bin')), 'storage/unauthorized');

    // as-uid → auth-gated zone allowed, anon-only zone denied.
    okValue(await sendOp(ctx, port, put('notes/c.bin', { mode: 'as', uid: aliceUid })));
    expectDenied(await sendOp(ctx, port, put('anonOnly/c.bin', { mode: 'as', uid: aliceUid })), 'storage/unauthorized');

    // admin → bypass both zones; reads honor the lens too.
    okValue(await sendOp(ctx, port, put('notes/d.bin', { mode: 'admin' })));
    okValue(await sendOp(ctx, port, put('anonOnly/d.bin', { mode: 'admin' })));
    expectDenied(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'storage.getBytes', path: 'notes/c.bin',
      actAs: { mode: 'anon' },
    }), 'storage/unauthorized');
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'storage.getBytes', path: 'notes/c.bin',
      actAs: { mode: 'admin' },
    }));
  });
});
