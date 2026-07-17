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
import { getAuth } from 'pyric/auth';

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
      identity: { uid: 'github.com:bob@x.com', email: 'bob@x.com', displayName: null, customClaims: {}, providerId: 'github.com' },
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
      identity: { uid: 'google.com:eve@x.com', email: 'eve@x.com', displayName: null, customClaims: {}, providerId: 'google.com' },
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
      customClaims: {}, providerId: 'google.com',
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
