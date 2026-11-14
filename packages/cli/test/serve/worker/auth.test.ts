/**
 * Tests for the SharedWorker AUTH surface — host.ts auth handlers.
 *
 * Strategy mirrors host.test.ts: build a REAL pyric sandbox + getAuth(sandbox),
 * fake MessagePort objects, and call handleMessage() directly — no SharedWorker
 * runtime.
 *
 * PER-PORT SESSIONS (#754): the worker hosts ONE user pool + data store, but
 * each port owns its OWN session. Coverage:
 *   - createUser / signInEmail / signInAnonymously / signOut bind THIS port's
 *     session; the shared auth handle's global currentUser stays null.
 *   - ISOLATION: a sign-in on port A fires ONLY port A's onAuthStateChanged;
 *     two ports can be two different signed-in users at once.
 *   - getIdToken(Result) resolve the port's session (claims/signInProvider).
 *   - Errors: wrong-password, email-already-in-use serialize with `.code`.
 *   - RESTORE: `auth.restorePortSession` re-establishes a session for an
 *     existing identity on a fresh worker (user DB rides the snapshot);
 *     unknown uids resolve null (soft), never an error.
 */

import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  cleanupPort,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import { reconcilePortSessions } from '../../../src/serve/worker/host-auth.js';
import { authAccountsFor, getClock } from 'pyric/sandbox/internal';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
  SerializedUser,
  SerializedUserCredential,
  SerializedIdTokenResult,
  AuthPersistenceMode,
} from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
  type PersistenceBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { applyFullState, captureFullState } from 'pyric/sandbox';
import { getAuth, sandbox as authSandboxOps, type SeedUser } from 'pyric/auth';
import { defaultAvatarDataUri } from 'pyric/auth/internal';

// ─── Helpers ──────────────────────────────────────────────────────────────

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

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

async function makeCtx(opts?: {
  backend?: PersistenceBackend;
  key?: string;
  sessionMode?: AuthPersistenceMode;
}): Promise<HostCtx & { backend: PersistenceBackend }> {
  const backend = opts?.backend ?? createMemoryBackend();
  const key = opts?.key ?? 'auth-worker-test';

  const sandbox = initializeSandbox();

  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);

  await sandbox.enablePersistence({ key, injectedBackend: backend });

  // Register the auth service with the persistence registry (mirrors entry.ts).
  getAuth(sandbox);

  const db = getFirestore(sandbox);
  const ctx: HostCtx & { backend: PersistenceBackend } = {
    db,
    sandbox,
    subs: new Map(),
    sessionBackend: backend,
    sessionMode: opts?.sessionMode ?? 'LOCAL',
    backend,
  } as HostCtx & { backend: PersistenceBackend };
  return ctx;
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getRes(port: FakePort, id: string): ResMessage | undefined {
  return port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  await tick(0);
  const id = (msg as { id: string }).id;
  const res = getRes(port, id);
  if (!res) throw new Error(`No res message for ${id}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got error: ${res.error.code} ${res.error.message}`);
  return res.value as T;
}

async function currentUser(ctx: HostCtx, port: FakePort): Promise<SerializedUser | null> {
  return okValue<SerializedUser | null>(
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getCurrentUser' }),
  );
}

let _idSeq = 0;
function id(): string { return `auth-op-${++_idSeq}`; }

// ─── createUser / signIn / signOut (per-port) ─────────────────────────────

describe('worker auth — createUser / signIn / signOut bind the PORT session', () => {
  it('createUserWithEmailAndPassword signs THIS port in; global currentUser stays null', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'alice@example.com', password: 'password123',
    });
    const cred = okValue<SerializedUserCredential>(res);
    expect(cred.user.email).toBe('alice@example.com');
    expect(cred.user.isAnonymous).toBe(false);
    expect(cred.operationType).toBe('signIn');
    // The PORT is signed in…
    expect((await currentUser(ctx, port))?.email).toBe('alice@example.com');
    // …but the shared handle's GLOBAL session is untouched (#754).
    expect(ctx.auth?.currentUser ?? null).toBeNull();
  });

  it('signInWithEmailAndPassword works after createUser (same port, after signOut)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'bob@example.com', password: 'hunter2pw',
    });
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signOut' });
    expect(await currentUser(ctx, port)).toBeNull();

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.signInEmail',
      email: 'bob@example.com', password: 'hunter2pw',
    });
    const cred = okValue<SerializedUserCredential>(res);
    expect(cred.user.email).toBe('bob@example.com');
    expect((await currentUser(ctx, port))?.email).toBe('bob@example.com');
  });

  it('signInAnonymously mints an anonymous user; repeat call on the SAME port reuses it', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const first = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.signInAnonymously',
    }));
    expect(first.user.isAnonymous).toBe(true);
    expect(first.user.email).toBeNull();

    // StrictMode double-mount semantics: same port ⇒ same anonymous identity.
    const second = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.signInAnonymously',
    }));
    expect(second.user.uid).toBe(first.user.uid);
  });

  it('signOut clears ONLY this port', async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    await sendOp(ctx, portA, { t: 'op', id: id(), method: 'auth.signInAnonymously' });
    await sendOp(ctx, portB, { t: 'op', id: id(), method: 'auth.signInAnonymously' });
    await sendOp(ctx, portB, { t: 'op', id: id(), method: 'auth.signOut' });

    expect(await currentUser(ctx, portB)).toBeNull();
    expect(await currentUser(ctx, portA)).not.toBeNull();
  });
});

// ─── PER-PORT ISOLATION (the #754 headline) ───────────────────────────────

describe('worker auth — per-port sessions are isolated', () => {
  it('two ports signing in anonymously are two DISTINCT users', async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    const a = okValue<SerializedUserCredential>(await sendOp(ctx, portA, {
      t: 'op', id: id(), method: 'auth.signInAnonymously',
    }));
    const b = okValue<SerializedUserCredential>(await sendOp(ctx, portB, {
      t: 'op', id: id(), method: 'auth.signInAnonymously',
    }));
    expect(a.user.uid).not.toBe(b.user.uid);
  });

  it("a sign-in on port A fires port A's onAuthStateChanged and NOT port B's", async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    await handleMessage(ctx, portA, { t: 'sub', subId: 'a-state', target: 'authState' });
    await handleMessage(ctx, portB, { t: 'sub', subId: 'b-state', target: 'authState' });
    await tick();

    // Initial fire: both signed out.
    expect(portA.snapMessages.at(-1)!.value).toBeNull();
    expect(portB.snapMessages.at(-1)!.value).toBeNull();
    const bSnapsBefore = portB.snapMessages.length;

    await sendOp(ctx, portA, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'eve@example.com', password: 'password123',
    });
    await tick();

    // Port A saw its own sign-in; port B saw NOTHING (its session is its own).
    expect((portA.snapMessages.at(-1)!.value as SerializedUser)?.email).toBe('eve@example.com');
    expect(portB.snapMessages.length).toBe(bSnapsBefore);
  });

  it('an authState sub opened AFTER sign-in fires with THIS port session', async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    await sendOp(ctx, portA, { t: 'op', id: id(), method: 'auth.signInAnonymously' });

    await handleMessage(ctx, portA, { t: 'sub', subId: 'a-late', target: 'authState' });
    await handleMessage(ctx, portB, { t: 'sub', subId: 'b-late', target: 'authState' });
    await tick();

    expect((portA.snapMessages.at(-1)!.value as SerializedUser)?.isAnonymous).toBe(true);
    expect(portB.snapMessages.at(-1)!.value).toBeNull();
  });

  it('cleanupPort drops the session (a reconnecting port starts signed out)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signInAnonymously' });
    expect(await currentUser(ctx, port)).not.toBeNull();

    cleanupPort(ctx, port);
    const reconnectedPort = fakePort();
    expect(await currentUser(ctx, reconnectedPort)).toBeNull();
  });

  it('cleanupPort drops the port SESSION-BOUND SUB RECORDS (a later session change does not resurrect them)', async () => {
    // cleanupPort tears down the port's LIVE listeners (ctx.subs) — but a
    // session-bound sub is tracked TWICE: the live unsub in `ctx.subs`, and a
    // separate RECORD of the original sub message, kept so an auth transition
    // can re-establish the listener under the new identity (#754). Tearing
    // down only the live listener leaves that record behind, and the next
    // session change on the port re-registers the listener from it — a
    // disconnected port's listeners coming back to life, fed by whoever signs
    // in next. This test pins the record teardown, which is invisible to any
    // assertion that stops at `ctx.subs`.
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signInAnonymously' });
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'items/one', data: { v: 1 },
    });

    // A SESSION-BOUND listener: no `actAs` lens, so it is recorded against the
    // port's session and re-established on that port's auth transitions.
    const SUB = 'cleanup-session-sub';
    await handleMessage(ctx, port, {
      t: 'sub', subId: SUB, target: { __ref: 'collection', path: 'items' },
    });
    await tick();

    const snapsFor = () => port.snapMessages.filter((m) => m.subId === SUB);
    expect(snapsFor().length).toBeGreaterThanOrEqual(1); // the listener is live
    expect(ctx.subs.has(port)).toBe(true);

    // ── The port disconnects. ──
    cleanupPort(ctx, port);
    expect(ctx.subs.has(port)).toBe(false); // live listener torn down
    const countAtCleanup = snapsFor().length;

    // ── A LATER session change on that same port. ──
    // If cleanupPort left the session-bound RECORD behind, this transition
    // re-establishes the listener on the cleaned-up port: the sub comes back
    // and delivers a fresh snapshot to a port that is already gone.
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signInAnonymously' });
    await tick();

    // No snapshot was delivered after cleanup…
    expect(snapsFor().length).toBe(countAtCleanup);
    // …and no listener was re-registered for the dead port.
    expect(ctx.subs.has(port)).toBe(false);
  });
});

// ─── Token accessors ──────────────────────────────────────────────────────

describe('worker auth — token accessors (port session)', () => {
  it('getIdToken returns a token string', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'grace@example.com', password: 'password123',
    });
    const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdToken' });
    const token = okValue<string>(res);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('getIdTokenResult returns claims + signInProvider', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'heidi@example.com', password: 'password123',
    });
    const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdTokenResult' });
    const result = okValue<SerializedIdTokenResult>(res);
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.claims).toBeDefined();
    expect(result.signInProvider).toBe('password');
  });

  it('getIdToken with no session on THIS port fails with auth/no-current-user', async () => {
    const ctx = await makeCtx();
    const signedIn = fakePort();
    await sendOp(ctx, signedIn, { t: 'op', id: id(), method: 'auth.signInAnonymously' });

    // A DIFFERENT port has no session — another port's sign-in doesn't help it.
    const port = fakePort();
    const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdToken' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth/no-current-user');
  });
});

// ─── #1950: an invalidated account is signed out on this port ─────────────

describe('worker auth — a refused refresh signs the port out (#1950)', () => {
  async function signedInPort(email: string): Promise<{ ctx: HostCtx; port: FakePort; uid: string }> {
    const ctx = await makeCtx();
    const port = fakePort();
    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser', email, password: 'password123',
    }));
    await handleMessage(ctx, port, { t: 'sub', subId: 'state', target: 'authState' });
    return { ctx, port, uid: cred.user.uid };
  }

  function lastAuthState(port: FakePort): unknown {
    return port.snapMessages.filter((m) => m.subId === 'state').at(-1)?.value;
  }

  it.each([
    ['auth.getIdToken', 'disabled', 'auth/user-disabled'],
    ['auth.getIdTokenResult', 'disabled', 'auth/user-disabled'],
    ['auth.reload', 'disabled', 'auth/user-disabled'],
    ['auth.getIdToken', 'deleted', 'auth/user-token-expired'],
    ['auth.getIdTokenResult', 'deleted', 'auth/user-token-expired'],
    ['auth.reload', 'deleted', 'auth/user-token-expired'],
  ] as const)('%s for a %s account rejects %s and the port signs out', async (method, change, code) => {
    const { ctx, port, uid } = await signedInPort(`${method}-${change}@example.com`);
    const auth = getAuth(ctx.sandbox);
    if (change === 'disabled') authSandboxOps.updateUser(auth, uid, { disabled: true });
    else authSandboxOps.deleteUser(auth, uid);

    const res = await sendOp(ctx, port, { t: 'op', id: id(), method, forceRefresh: true } as InboundMessage);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(code);
    expect(await currentUser(ctx, port)).toBeNull();
    expect(lastAuthState(port)).toBeNull();
  });

  it('a password change on one port refuses the other port\'s refresh and keeps its own', async () => {
    const { ctx, port: changing } = await signedInPort('two-ports@example.com');
    const other = fakePort();
    await handleMessage(ctx, other, { t: 'sub', subId: 'state', target: 'authState' });
    okValue(await sendOp(ctx, other, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'two-ports@example.com', password: 'password123',
    }));
    // Production stores the revocation on a whole second; move past the sign-ins'.
    getClock(ctx.sandbox).advance(2000);

    okValue(await sendOp(ctx, changing, { t: 'op', id: id(), method: 'auth.updatePassword', password: 'changed-password' }));

    const kept = await sendOp(ctx, changing, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(kept.ok).toBe(true);
    const refused = await sendOp(ctx, other, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('auth/user-token-expired');
    expect(await currentUser(ctx, other)).toBeNull();
    expect(lastAuthState(other)).toBeNull();
    expect((await currentUser(ctx, changing))?.email).toBe('two-ports@example.com');
  });

  it('a port reloaded after changing its own password resumes its session and keeps refreshing; the other port is refused', async () => {
    const { ctx, port: changing, uid } = await signedInPort('reload-after-change@example.com');
    const other = fakePort();
    okValue(await sendOp(ctx, other, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'reload-after-change@example.com', password: 'password123',
    }));
    getClock(ctx.sandbox).advance(2000);
    okValue(await sendOp(ctx, changing, { t: 'op', id: id(), method: 'auth.updatePassword', password: 'changed-password' }));
    const held = await currentUser(ctx, changing);
    expect(held?.sessionKey).toBeString();

    // The reload: a new port restores the uid with the key the page stored.
    const reloaded = fakePort();
    const restored = okValue<SerializedUser | null>(await sendOp(ctx, reloaded, {
      t: 'op', id: id(), method: 'auth.restorePortSession', uid, sessionKey: held?.sessionKey,
    }));
    expect(restored?.uid).toBe(uid);
    expect(restored?.sessionKey).toBe(held?.sessionKey);
    const kept = await sendOp(ctx, reloaded, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(kept.ok).toBe(true);
    expect((await currentUser(ctx, reloaded))?.uid).toBe(uid);

    const refused = await sendOp(ctx, other, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('auth/user-token-expired');
  });

  it('a port restored with the other port\'s key after a password change stays refused', async () => {
    const { ctx, uid } = await signedInPort('reload-other@example.com');
    const other = fakePort();
    okValue(await sendOp(ctx, other, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'reload-other@example.com', password: 'password123',
    }));
    const otherKey = (await currentUser(ctx, other))?.sessionKey;
    getClock(ctx.sandbox).advance(2000);
    authSandboxOps.updateUser(getAuth(ctx.sandbox), uid, { password: 'changed-password' });

    const reloaded = fakePort();
    okValue(await sendOp(ctx, reloaded, {
      t: 'op', id: id(), method: 'auth.restorePortSession', uid, sessionKey: otherKey,
    }));
    const refused = await sendOp(ctx, reloaded, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('auth/user-token-expired');
  });

  it('a port restored without a matching key does not borrow a later sign-in of the account', async () => {
    const { ctx, port: changing, uid } = await signedInPort('borrow@example.com');
    const refusedPort = fakePort();
    okValue(await sendOp(ctx, refusedPort, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'borrow@example.com', password: 'password123',
    }));
    getClock(ctx.sandbox).advance(2000);
    okValue(await sendOp(ctx, changing, { t: 'op', id: id(), method: 'auth.updatePassword', password: 'changed-password' }));
    const refused = await sendOp(ctx, refusedPort, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(refused.ok).toBe(false);
    // A later sign-in to the account, on a third port.
    getClock(ctx.sandbox).advance(2000);
    const later = fakePort();
    okValue(await sendOp(ctx, later, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'borrow@example.com', password: 'changed-password',
    }));

    for (const sessionKey of [undefined, 'bogus']) {
      const restored = fakePort();
      okValue(await sendOp(ctx, restored, {
        t: 'op', id: id(), method: 'auth.restorePortSession', uid, ...(sessionKey === undefined ? {} : { sessionKey }),
      }));
      const answer = await sendOp(ctx, restored, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.error.code).toBe('auth/user-token-expired');
      expect(await currentUser(ctx, restored)).toBeNull();
    }
    const kept = await sendOp(ctx, later, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(kept.ok).toBe(true);
  });

  it('updateCurrentUser on a fresh port does not borrow a later sign-in of the account', async () => {
    const { ctx, port: changing, uid } = await signedInPort('update-current@example.com');
    const refusedPort = fakePort();
    okValue(await sendOp(ctx, refusedPort, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'update-current@example.com', password: 'password123',
    }));
    const refusedKey = (await currentUser(ctx, refusedPort))?.sessionKey;
    getClock(ctx.sandbox).advance(2000);
    okValue(await sendOp(ctx, changing, { t: 'op', id: id(), method: 'auth.updatePassword', password: 'changed-password' }));
    expect((await sendOp(ctx, refusedPort, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true })).ok).toBe(false);
    getClock(ctx.sandbox).advance(2000);
    okValue(await sendOp(ctx, fakePort(), {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'update-current@example.com', password: 'changed-password',
    }));

    for (const sessionKey of [undefined, refusedKey]) {
      const fresh = fakePort();
      okValue(await sendOp(ctx, fresh, {
        t: 'op', id: id(), method: 'auth.updateCurrentUser', uid, ...(sessionKey === undefined ? {} : { sessionKey }),
      }));
      const answer = await sendOp(ctx, fresh, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.error.code).toBe('auth/user-token-expired');
    }
  });

  it('updateCurrentUser with the user a port holds keeps its session refreshing after it changed the password', async () => {
    const { ctx, port, uid } = await signedInPort('update-current-own@example.com');
    getClock(ctx.sandbox).advance(2000);
    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.updatePassword', password: 'changed-password' }));
    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.updateCurrentUser', uid }));
    expect((await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true })).ok).toBe(true);
  });

  it('a port restored without a key refreshes while nothing revoked the account', async () => {
    const { ctx, uid } = await signedInPort('restore-unrevoked@example.com');
    getClock(ctx.sandbox).advance(2000);
    const restored = fakePort();
    okValue(await sendOp(ctx, restored, { t: 'op', id: id(), method: 'auth.restorePortSession', uid }));
    const answer = await sendOp(ctx, restored, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(answer.ok).toBe(true);
  });

  it('a checkpoint restore and its reconcile keep a held port signed in and refreshing', async () => {
    const { ctx, port } = await signedInPort('checkpoint@example.com');
    // The state carries the clock, so capture it after the sign-in's second.
    getClock(ctx.sandbox).advance(2000);
    const state = await captureFullState(ctx.sandbox);
    await applyFullState(ctx.sandbox, state);
    reconcilePortSessions(ctx);
    expect((await currentUser(ctx, port))?.email).toBe('checkpoint@example.com');
    const answer = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(answer.ok).toBe(true);
  });

  it('a port revoked by a password change before a checkpoint stays refused after the worker restores it (#2021)', async () => {
    const { ctx, port, uid } = await signedInPort('checkpoint-revoked@example.com');
    getClock(ctx.sandbox).advance(2000);
    authSandboxOps.updateUser(getAuth(ctx.sandbox), uid, { password: 'changed-password' });
    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'checkpoint', name: 'after-revoke' }));

    const revoked = authAccountsFor(ctx.sandbox)?.standing(uid);
    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'restore', name: 'after-revoke' }));

    // The restore's reconcile is a refresh-token exchange: the refused port signs out.
    expect(authAccountsFor(ctx.sandbox)?.standing(uid)).toEqual(revoked!);
    expect(await currentUser(ctx, port)).toBeNull();
    expect(lastAuthState(port)).toBeNull();
  });

  it('an account deleted before a checkpoint stays deleted after the worker restores it (#2021)', async () => {
    const { ctx, port, uid } = await signedInPort('checkpoint-deleted@example.com');
    authSandboxOps.deleteUser(getAuth(ctx.sandbox), uid);
    okValue(await sendOp(ctx, fakePort(), { t: 'op', id: id(), method: 'checkpoint', name: 'after-delete' }));

    okValue(await sendOp(ctx, fakePort(), { t: 'op', id: id(), method: 'restore', name: 'after-delete' }));

    expect(authAccountsFor(ctx.sandbox)?.standing(uid)).toEqual({ kind: 'deleted' });
    expect(await currentUser(ctx, port)).toBeNull();
  });

  it('a port reloaded after the restore of a checkpoint taken after a revocation stays refused (#2021)', async () => {
    const { ctx, port, uid } = await signedInPort('checkpoint-reload@example.com');
    const sessionKey = (await currentUser(ctx, port))?.sessionKey;
    getClock(ctx.sandbox).advance(2000);
    authSandboxOps.updateUser(getAuth(ctx.sandbox), uid, { password: 'changed-password' });
    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'checkpoint', name: 'before-reload' }));
    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'restore', name: 'before-reload' }));

    const reloaded = fakePort();
    okValue(await sendOp(ctx, reloaded, { t: 'op', id: id(), method: 'auth.restorePortSession', uid, sessionKey }));
    const refused = await sendOp(ctx, reloaded, { t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('auth/user-token-expired');
  });

  it('a rules or state reconcile signs out a port whose refresh is refused', async () => {
    const { ctx, port, uid } = await signedInPort('reconcile@example.com');
    authSandboxOps.updateUser(getAuth(ctx.sandbox), uid, { disabled: true });
    reconcilePortSessions(ctx);
    expect(await currentUser(ctx, port)).toBeNull();
  });
});

// ─── Errors serialize with `.code` ────────────────────────────────────────

describe('worker auth — error serialization', () => {
  it('wrong password serializes with the right code', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'ivan@example.com', password: 'correct-pw',
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.signInEmail',
      email: 'ivan@example.com', password: 'WRONG-pw',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toMatch(/^auth\/(wrong-password|invalid-credential)$/);
    }
  });

  it('email-already-in-use serializes with the right code', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'judy@example.com', password: 'password123',
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'judy@example.com', password: 'password123',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth/email-already-in-use');
  });
});

// ─── Per-tab session restore (auth.restorePortSession, #754) ──────────────

describe('worker auth — restorePortSession (per-tab reload / full close)', () => {
  it('restores a session for an existing identity on a fresh worker (user DB rides the snapshot)', async () => {
    const backend = createMemoryBackend();
    const key = 'auth-persist-rt';

    // ── Worker lifetime 1: create + sign in a user on some port. ──
    const ctx1 = await makeCtx({ backend, key });
    const port1 = fakePort();
    const created = okValue<SerializedUserCredential>(await sendOp(ctx1, port1, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'kate@example.com', password: 'password123',
    }));
    await tick();
    await ctx1.sandbox.flush();

    // ── Worker lifetime 2: all tabs closed → worker died → reopen. The PAGE
    // kept the uid in web storage and re-establishes ITS port's session. ──
    const ctx2 = await makeCtx({ backend, key });
    const port2 = fakePort();
    const restored = okValue<SerializedUser | null>(await sendOp(ctx2, port2, {
      t: 'op', id: id(), method: 'auth.restorePortSession', uid: created.user.uid,
    }));
    expect(restored?.uid).toBe(created.user.uid);
    expect(restored?.email).toBe('kate@example.com');
    expect((await currentUser(ctx2, port2))?.uid).toBe(created.user.uid);
    // Global session still untouched.
    expect(ctx2.auth?.currentUser ?? null).toBeNull();
  });

  it('resolves null (soft) for unknown uids — a stale record means signed out', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.restorePortSession', uid: 'gone-uid',
    });
    expect(okValue<SerializedUser | null>(res)).toBeNull();
    expect(await currentUser(ctx, port)).toBeNull();
  });

  it('fires THIS port authState on a successful restore', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'lara@example.com', password: 'password123',
    });
    const uid = (await currentUser(ctx, port))!.uid;
    cleanupPort(ctx, port);

    const fresh = fakePort();
    await handleMessage(ctx, fresh, { t: 'sub', subId: 'f-state', target: 'authState' });
    await tick();
    expect(fresh.snapMessages.at(-1)!.value).toBeNull();

    await sendOp(ctx, fresh, { t: 'op', id: id(), method: 'auth.restorePortSession', uid });
    await tick();
    expect((fresh.snapMessages.at(-1)!.value as SerializedUser)?.uid).toBe(uid);
  });
});

// ─── Provider sign-in bridge (auth.acceptIdentity) ─────────────────────────

describe('auth.acceptIdentity — provider sign-in bridge', () => {
  /** Enable a provider the way Studio's toggle does — via the worker op. */
  async function enableProvider(ctx: HostCtx, port: FakePort, providerId: string): Promise<void> {
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId, enabled: true,
    }));
  }

  it('seeds + signs THIS PORT in; currentUser + claims resolve', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'google.com');

    const identity = {
      uid: 'google.com:alice@example.com',
      email: 'alice@example.com',
      displayName: 'Alice',
      photoURL: null,
      customClaims: { role: 'admin' },
      providerId: 'google.com',
    };

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity', identity,
    });
    const cred = okValue<SerializedUserCredential>(res);
    expect(cred.user.uid).toBe(identity.uid);
    expect(cred.user.email).toBe('alice@example.com');
    expect(cred.providerId).toBe('google.com');
    expect(cred.operationType).toBe('signIn');

    expect((await currentUser(ctx, port))?.uid).toBe(identity.uid);

    const tok = okValue<SerializedIdTokenResult>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdTokenResult' }),
    );
    expect(tok.claims.role).toBe('admin');
  });

  // Production marks a Google account's email verified, on the user and on
  // the ID token. The dialog lets a developer type any address, and the
  // worker must report it verified for a new and for a returning identity.
  it('a Google identity is email-verified on the wire user, the token, and the record', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'google.com');
    const identity = {
      uid: 'provider-ada', email: 'ada@example.com', displayName: 'Ada',
      photoURL: null, customClaims: {}, providerId: 'google.com',
    };

    for (const round of ['new', 'returning']) {
      const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.acceptIdentity', identity,
      }));
      expect(cred.user.emailVerified, round).toBe(true);
      expect((await currentUser(ctx, port))?.emailVerified, round).toBe(true);
      const tok = okValue<SerializedIdTokenResult>(
        await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdTokenResult' }),
      );
      expect(tok.claims.email_verified, round).toBe(true);
      expect(tok.signInProvider, round).toBe('google.com');
    }
    const account = authSandboxOps.listUsers(getAuth(ctx.sandbox)).find((user) => user.uid === identity.uid);
    expect(account?.emailVerified).toBe(true);
  });

  // An existing password or other-provider account keeps its own flag:
  // production trusts Google for linking only on @gmail.com, and there it
  // removes the unverified password, which the sandbox does not do.
  it('an unverified password account stays unverified after a Google sign-in, and its password still works', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'google.com');
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser', email: 'victim@gmail.com', password: 'password123',
    });
    const uid = (await currentUser(ctx, port))!.uid;
    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: { uid, email: 'victim@gmail.com', displayName: null, photoURL: null, customClaims: {}, providerId: 'google.com' },
    }));
    expect(cred.user.emailVerified).toBe(false);
    expect(cred.user.providerData.map((entry) => entry.providerId)).toEqual(['password', 'google.com']);
    const signedIn = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.signInEmail', email: 'victim@gmail.com', password: 'password123',
    }));
    expect(signedIn.user.uid).toBe(uid);
    expect(signedIn.user.emailVerified).toBe(false);
    const tok = okValue<SerializedIdTokenResult>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdTokenResult' }),
    );
    expect(tok.claims.email_verified).toBe(false);
  });

  it('a GitHub identity followed by a Google sign-in for the same address stays unverified', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'github.com');
    await enableProvider(ctx, port, 'google.com');
    const base = { uid: 'provider-ada', email: 'ada@example.com', displayName: null, photoURL: null, customClaims: {} };
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity', identity: { ...base, providerId: 'github.com' },
    }));
    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity', identity: { ...base, providerId: 'google.com' },
    }));
    expect(cred.user.emailVerified).toBe(false);
    const tok = okValue<SerializedIdTokenResult>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getIdTokenResult' }),
    );
    expect(tok.claims.email_verified).toBe(false);
  });

  it('a non-Google identity keeps an unverified email', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'github.com');
    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: { uid: 'provider-gh', email: 'gh@example.com', displayName: null, photoURL: null, customClaims: {}, providerId: 'github.com' },
    }));
    expect(cred.user.emailVerified).toBe(false);
  });

  it('does NOT fan the bridged sign-in out to other ports (per-port sessions)', async () => {
    const ctx = await makeCtx();
    const watcher = fakePort();
    await handleMessage(ctx, watcher, { t: 'sub', subId: 'w-auth', target: 'authState' });
    await tick();
    const watcherSnaps = watcher.snapMessages.length;

    const actor = fakePort();
    await enableProvider(ctx, actor, 'github.com');
    await sendOp(ctx, actor, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: { uid: 'github.com:bob@x.com', email: 'bob@x.com', displayName: null, photoURL: null, customClaims: {}, providerId: 'github.com' },
    });
    await tick();

    // The actor's port session is bob; the watcher's session is untouched.
    expect((await currentUser(ctx, actor))?.uid).toBe('github.com:bob@x.com');
    expect(watcher.snapMessages.length).toBe(watcherSnaps);
    expect(await currentUser(ctx, watcher)).toBeNull();
  });

  // ── Provider gating at the shared authority (the served OAuth blocker fix):
  // the page-local sandbox delegates its gate in worker mode, so THIS op is
  // where Studio's Sign-in-provider toggles must bite.
  it('rejects auth/operation-not-allowed for a provider the worker has disabled', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'google.com', enabled: false,
    }));
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: { uid: 'google.com:eve@x.com', email: 'eve@x.com', displayName: null, photoURL: null, customClaims: {}, providerId: 'google.com' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth/operation-not-allowed');
    // Gate fires BEFORE any user-DB write: the identity was not seeded.
    const users = okValue<Array<{ uid: string }>>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.listUsers' }),
    );
    expect(users.some((u) => u.uid === 'google.com:eve@x.com')).toBe(false);
    expect(await currentUser(ctx, port)).toBeNull();
  });

  it('toggle matrix: enable → accepted; disable again → rejected (config is live)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const identity = {
      uid: 'google.com:ann@x.com', email: 'ann@x.com', displayName: null,
      photoURL: null, customClaims: {}, providerId: 'google.com',
    };

    await enableProvider(ctx, port, 'google.com');
    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity', identity,
    }));
    expect(cred.user.uid).toBe(identity.uid);

    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'google.com', enabled: false,
    }));
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity', identity,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth/operation-not-allowed');
  });

  it('provider acceptance preserves changed passwords and authoritative account fields', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    try {
      const auth = getAuth(ctx.sandbox);
      authSandboxOps.seedUsers(auth, [{
        uid: 'preserved', email: 'preserved@example.com', password: 'original-password',
        customClaims: { role: 'editor' }, tenantId: 'account-tenant',
        emailVerified: true, createdAt: '2020-01-01T00:00:00.000Z',
      }]);
      await enableProvider(ctx, port, 'google.com');
      okValue(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.signInEmail', tenantId: 'account-tenant',
        email: 'preserved@example.com', password: 'original-password',
      }));
      okValue(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.updatePassword', password: 'changed-password',
      }));
      const crossTenant = await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.acceptIdentity', tenantId: 'session-tenant',
        identity: { uid: 'preserved', email: 'preserved@example.com', displayName: 'Updated',
          photoURL: null, customClaims: { role: 'stale' }, providerId: 'google.com' },
      });
      expect(crossTenant).toMatchObject({ ok: false, error: { code: 'auth/tenant-id-mismatch' } });
      const accepted = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.acceptIdentity', tenantId: 'account-tenant',
        identity: { uid: 'preserved', email: 'preserved@example.com', displayName: 'Updated',
          photoURL: null, customClaims: { role: 'stale' }, providerId: 'google.com' },
      }));
      expect(accepted.user.tenantId).toBe('account-tenant');
      expect(accepted.user.providerData.map(provider => provider.providerId)).toEqual(['password', 'google.com']);
      const token = okValue<SerializedIdTokenResult>(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.getIdTokenResult',
      }));
      expect(token.signInProvider).toBe('google.com');
      expect(token.claims.role).toBe('editor');
      const account = authSandboxOps.listUsers(auth).find(user => user.uid === 'preserved');
      expect(account).toMatchObject({ tenantId: 'account-tenant', emailVerified: true,
        createdAt: '2020-01-01T00:00:00.000Z', customClaims: { role: 'editor' } });
      const signedIn = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.signInEmail', tenantId: 'account-tenant', email: 'preserved@example.com', password: 'changed-password',
      }));
      expect(signedIn.user.uid).toBe('preserved');
      const stalePassword = await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.signInEmail', tenantId: 'account-tenant', email: 'preserved@example.com', password: 'original-password',
      });
      expect(stalePassword).toMatchObject({ ok: false, error: { code: 'auth/wrong-password' } });
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('rejects disabled accounts without changing their profile or linked providers', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    try {
      const auth = getAuth(ctx.sandbox);
      authSandboxOps.seedUsers(auth, [{ uid: 'disabled', email: 'disabled@example.com',
        password: 'original-password', displayName: 'Original', disabled: true }]);
      await enableProvider(ctx, port, 'google.com');
      const before = authSandboxOps.listUsers(auth);
      const result = await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'auth.acceptIdentity',
        identity: { uid: 'disabled', email: 'disabled@example.com', displayName: 'Replacement',
          photoURL: 'https://example.com/replacement.png', customClaims: {}, providerId: 'google.com' },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'auth/user-disabled' } });
      expect(authSandboxOps.listUsers(auth)).toEqual(before);
      expect(await currentUser(ctx, port)).toBeNull();
    } finally { ctx.sandbox.dispose(); }
  });

  // ── Profile photo: the identity carries it, the seed record stores it, and
  // the serialized user hands it back to the page. An identity that carries
  // NO photo gets the mint this worker was booted with — here, the built-in
  // one, because this ctx never applied an init payload. `serve-init.test.ts`
  // covers the payload-driven mints a real `pyric dev` boot installs.
  const PHOTO = 'https://cdn.example.com/avatars/ada.png';

  function exportedSeed(ctx: HostCtx, uid: string): SeedUser | undefined {
    return authSandboxOps.exportUsers(getAuth(ctx.sandbox)).find((seed) => seed.uid === uid);
  }

  it('a photo-bearing identity seeds a stored user whose exported seed carries photoUrl', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'google.com');

    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: {
        uid: 'google.com:ada@x.com', email: 'ada@x.com', displayName: 'Ada',
        photoURL: PHOTO, customClaims: {}, providerId: 'google.com',
      },
    }));

    // Serialization: the wire user carries the photo (SerializedUser.photoURL).
    expect(cred.user.photoURL).toBe(PHOTO);
    expect(
      cred.user.providerData.find((entry) => entry.providerId === 'google.com')?.photoURL,
    ).toBe(PHOTO);
    expect((await currentUser(ctx, port))?.photoURL).toBe(PHOTO);

    // Round-trip: the stored record exports as a SeedUser carrying photoUrl.
    expect(exportedSeed(ctx, 'google.com:ada@x.com')?.photoUrl).toBe(PHOTO);
  });

  it('an identity without a photo is born with the built-in default avatar', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'google.com');

    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: {
        uid: 'google.com:noel@x.com', email: 'noel@x.com', displayName: null,
        photoURL: null, customClaims: {}, providerId: 'google.com',
      },
    }));

    const expected = defaultAvatarDataUri({
      uid: 'google.com:noel@x.com',
      displayName: null,
      email: 'noel@x.com',
    });
    expect(cred.user.photoURL).toBe(expected);
    expect(exportedSeed(ctx, 'google.com:noel@x.com')?.photoUrl).toBe(expected);
  });

  it('re-accepting the identity without a photo does NOT clear the stored one', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await enableProvider(ctx, port, 'google.com');
    const withPhoto = {
      uid: 'google.com:ada@x.com', email: 'ada@x.com', displayName: 'Ada',
      photoURL: PHOTO, customClaims: {}, providerId: 'google.com',
    };

    await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.acceptIdentity', identity: withPhoto });
    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.acceptIdentity',
      identity: { ...withPhoto, photoURL: null },
    }));

    expect(cred.user.photoURL).toBe(PHOTO);
    expect(exportedSeed(ctx, 'google.com:ada@x.com')?.photoUrl).toBe(PHOTO);
  });
});

// ─── auth.updateProfile (#746) ─────────────────────────────────────────────

describe('auth.updateProfile — port session profile update', () => {
  it('updates the port session user + is visible via getCurrentUser', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'ivy@example.com', password: 'password123',
    });

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.updateProfile',
      displayName: 'Ivy', photoURL: 'http://example.com/ivy.png',
    });
    const updated = okValue<SerializedUser>(res);
    expect(updated.displayName).toBe('Ivy');
    expect(updated.photoURL).toBe('http://example.com/ivy.png');
    expect(updated.providerData[0]?.displayName).toBe('Ivy');

    // Subsequent getCurrentUser reflects it (port session mutated in place).
    const cur = await currentUser(ctx, port);
    expect(cur?.displayName).toBe('Ivy');
    expect(cur?.photoURL).toBe('http://example.com/ivy.png');

    // Stored record persisted (admin listUsers).
    const users = okValue<Array<{ uid: string; displayName: string | null; photoUrl: string | null }>>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.listUsers' }),
    );
    const rec = users.find((u) => u.uid === updated.uid);
    expect(rec?.displayName).toBe('Ivy');
    expect(rec?.photoUrl).toBe('http://example.com/ivy.png');
  });

  it('null clears a field; omitted field untouched', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser',
      email: 'judy@example.com', password: 'password123',
    });
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.updateProfile',
      displayName: 'Judy', photoURL: 'http://example.com/j.png',
    });
    // Clear displayName only.
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.updateProfile', displayName: null,
    });
    const updated = okValue<SerializedUser>(res);
    expect(updated.displayName).toBeNull();
    expect(updated.photoURL).toBe('http://example.com/j.png');
  });

  it('fails with auth/no-current-user when the port is signed out', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.updateProfile', displayName: 'Nobody',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth/no-current-user');
  });
});

// ─── auth.getProviderConfig / auth.setProviderConfig (S-AUTH sign-in providers) ──

describe('auth.getProviderConfig / auth.setProviderConfig — worker op round-trip', () => {
  it('getProviderConfig returns the documented defaults (password + anonymous enabled)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getProviderConfig' });
    const config = okValue<Array<{ providerId: string; enabled: boolean }>>(res);
    const byId = Object.fromEntries(config.map((c) => [c.providerId, c.enabled]));
    expect(byId).toEqual({ password: true, anonymous: true });
  });

  it('setProviderConfig toggles a provider; getProviderConfig reflects it round-trip', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'google.com', enabled: false,
    });
    let config = okValue<Array<{ providerId: string; enabled: boolean }>>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getProviderConfig' }),
    );
    expect(config.find((c) => c.providerId === 'google.com')?.enabled).toBe(false);

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'google.com', enabled: true,
    });
    config = okValue<Array<{ providerId: string; enabled: boolean }>>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.getProviderConfig' }),
    );
    expect(config.find((c) => c.providerId === 'google.com')?.enabled).toBe(true);
  });

  it('a disabled provider is enforced by the sign-in ops the SAME worker serves', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'anonymous', enabled: false,
    });
    const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signInAnonymously' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth/operation-not-allowed');
  });

  it('setProviderConfig fires a provider_config_update sandbox event another port can observe', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'sub', subId: 'ev', target: 'events' });
    await tick();
    const before = port.messages.filter((m) => m.t === 'event').length;

    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'github.com', enabled: false,
    });
    await tick();
    const eventMsgs = port.messages.filter((m): m is Extract<OutboundMessage, { t: 'event' }> => m.t === 'event');
    expect(eventMsgs.length).toBeGreaterThan(before);
    const last = eventMsgs.at(-1)!;
    expect(last.events.some((e) => (e as { op?: string }).op === 'provider_config_update')).toBe(true);
  });

  it('config round-trips across a worker restart via the persisted `auth` service snapshot', async () => {
    const backend = createMemoryBackend();
    const key = 'auth-provider-config-persist-rt';

    const ctx1 = await makeCtx({ backend, key });
    const port1 = fakePort();
    await sendOp(ctx1, port1, {
      t: 'op', id: id(), method: 'auth.setProviderConfig', providerId: 'google.com', enabled: false,
    });
    await ctx1.sandbox.flush();

    const ctx2 = await makeCtx({ backend, key });
    const port2 = fakePort();
    const config = okValue<Array<{ providerId: string; enabled: boolean }>>(
      await sendOp(ctx2, port2, { t: 'op', id: id(), method: 'auth.getProviderConfig' }),
    );
    expect(config.find((c) => c.providerId === 'google.com')?.enabled).toBe(false);
  });
});

// ─── auth.adminGetAccountStanding / auth.adminRevokeRefreshTokens ───────────

describe('auth.adminGetAccountStanding / auth.adminRevokeRefreshTokens — admin standing & revocation', () => {
  it('returns standing across active, disabled, deleted, and unrecorded accounts and revokes refresh tokens', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    expect(
      okValue<{ kind: string }>(
        await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.adminGetAccountStanding', uid: 'missing-uid' }),
      ),
    ).toEqual({ kind: 'unrecorded' });

    const missingRevoke = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.adminRevokeRefreshTokens', uid: 'missing-uid',
    });
    expect(missingRevoke.ok).toBe(false);
    if (!missingRevoke.ok) expect(missingRevoke.error.code).toBe('auth/user-not-found');

    const cred = okValue<SerializedUserCredential>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.createUser', email: 'standing@example.com', password: 'password123',
    }));
    const uid = cred.user.uid;

    const initialStanding = okValue<{ kind: string; tokensValidAfterMs: number | null }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.adminGetAccountStanding', uid }),
    );
    expect(initialStanding).toEqual({ kind: 'active', tokensValidAfterMs: null });

    getClock(ctx.sandbox).advance(2_000);
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.adminRevokeRefreshTokens', uid,
    }));

    const revokedStanding = okValue<{ kind: string; tokensValidAfterMs: number | null }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.adminGetAccountStanding', uid }),
    );
    expect(revokedStanding.kind).toBe('active');
    expect(typeof revokedStanding.tokensValidAfterMs).toBe('number');

    const refreshAfterRevoke = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.getIdToken', forceRefresh: true,
    });
    expect(refreshAfterRevoke.ok).toBe(false);
    if (!refreshAfterRevoke.ok) expect(refreshAfterRevoke.error.code).toBe('auth/user-token-expired');

    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.adminUpdateUser', uid, request: { disabled: true },
    }));
    const disabledStanding = okValue<{ kind: string; tokensValidAfterMs: number | null }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.adminGetAccountStanding', uid }),
    );
    expect(disabledStanding.kind).toBe('disabled');

    okValue(await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.adminDeleteUser', uid }));
    const deletedStanding = okValue<{ kind: string }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.adminGetAccountStanding', uid }),
    );
    expect(deletedStanding).toEqual({ kind: 'deleted' });

    const deletedRevoke = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'auth.adminRevokeRefreshTokens', uid,
    });
    expect(deletedRevoke.ok).toBe(false);
    if (!deletedRevoke.ok) expect(deletedRevoke.error.code).toBe('auth/user-not-found');
  });
});

