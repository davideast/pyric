/**
 * Per-user security verification for the SharedWorker host (host.ts).
 *
 * GOAL
 * ----
 * Prove the per-user notes security model holds over the REAL worker host:
 * with auth-gated rules (`resource.data.owner == request.auth.uid`), a user
 * can only read/write their OWN notes; a logged-out client can do neither;
 * and — the headline question — whether an ACTIVE `onSnapshot` listener
 * re-evaluates and loses access when the user signs out with NO data write.
 *
 * STRATEGY (mirrors host.test.ts / auth.test.ts)
 * ----------------------------------------------
 * Build a REAL pyric sandbox + a single shared `getFirestore(sandbox)` (the
 * "sandbox-live" handle the host uses), wire fake MessagePort objects, and
 * drive `handleMessage()` directly. Auth ops create/sign-in alice & bob; the
 * per-user rules below are deployed through the real `setRules` host op.
 *
 * THE RULES UNDER TEST
 * --------------------
 *   match /notes/{id} {
 *     allow read:   if request.auth != null && resource.data.owner == request.auth.uid;
 *     allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
 *     allow update, delete: if request.auth != null && resource.data.owner == request.auth.uid;
 *   }
 *
 * pyric uses the query-proof model ("rules are not filters"): a query that
 * does not PROVE it only reads docs the `read`/`list` rule allows is DENIED
 * whole — never silently filtered. So `where('owner','==', alice.uid)` is the
 * proof that discharges alice's read; an unscoped query or `owner==bob.uid`
 * (as alice) is denied.
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
  SnapMessage,
  SerializedUserCredential,
  TargetDescriptor,
} from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';

// ─── The per-user rules under test ─────────────────────────────────────────

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

// A permissive ruleset used ONLY to seed bob's note as bob before switching to
// the per-user rules — keeps the seed path independent of the rules we test.
const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

// ─── Fake port ──────────────────────────────────────────────────────────────

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

// ─── Host ctx (full auth wiring, like auth.test.ts) ────────────────────────

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();

  // Start permissive so the seed path (bob's note) is unconstrained; the
  // per-user rules are deployed via the host `setRules` op in each test.
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);

  await sandbox.enablePersistence({
    key: `sec-per-user-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });

  // Register the auth service (mirrors entry.ts) so getFirestore(sandbox)
  // reads sandbox.currentUser per-op.
  getAuth(sandbox);

  const db = getFirestore(sandbox);
  return { db, sandbox, subs: new Map(), sessionMode: 'LOCAL' };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let _seq = 0;
function id(): string { return `sec-op-${++_seq}`; }

function getRes(port: FakePort, opId: string): ResMessage | undefined {
  return port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  await tick(0);
  const opId = (msg as { id: string }).id;
  const res = getRes(port, opId);
  if (!res) throw new Error(`No res message for ${opId}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got error: ${res.error.code} ${res.error.message}`);
  return res.value as T;
}

async function createUser(ctx: HostCtx, port: FakePort, email: string, password: string): Promise<string> {
  const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.createUser', email, password });
  return okValue<SerializedUserCredential>(res).user.uid;
}

async function signIn(ctx: HostCtx, port: FakePort, email: string, password: string): Promise<void> {
  const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signInEmail', email, password });
  okValue<SerializedUserCredential>(res);
}

async function signOut(ctx: HostCtx, port: FakePort): Promise<void> {
  const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'auth.signOut' });
  okValue<void>(res);
}

async function deployPerUserRules(ctx: HostCtx, port: FakePort): Promise<void> {
  const res = await sendOp(ctx, port, { t: 'op', id: id(), method: 'setRules', source: PER_USER_RULES });
  okValue(res);
}

/** A `notes` query scoped to a single owner uid (the query-proof). */
function notesByOwner(owner: string): TargetDescriptor {
  return {
    __ref: 'query',
    source: { __ref: 'collection', path: 'notes' },
    constraints: [{ kind: 'where', field: 'owner', op: '==', value: owner }],
  };
}

// ════════════════════════════════════════════════════════════════════════
//  Setup helper: create alice + bob, seed bob's note, deploy per-user rules.
// ════════════════════════════════════════════════════════════════════════

async function setupAliceBob(ctx: HostCtx, port: FakePort): Promise<{ aliceUid: string; bobUid: string; bobNotePath: string }> {
  const aliceUid = await createUser(ctx, port, 'alice@example.com', 'password-alice');
  await signOut(ctx, port);
  const bobUid = await createUser(ctx, port, 'bob@example.com', 'password-bob');

  // Seed bob's note as bob, under the still-permissive rules.
  const seed = await sendOp(ctx, port, {
    t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
    data: { text: "bob's secret", owner: bobUid },
  });
  const bobNotePath = okValue<{ id: string; path: string }>(seed).path;

  // Now lock down with the per-user rules and sign everyone out.
  await deployPerUserRules(ctx, port);
  await signOut(ctx, port);

  return { aliceUid, bobUid, bobNotePath };
}

// ════════════════════════════════════════════════════════════════════════
//  1. Owner allowed
// ════════════════════════════════════════════════════════════════════════

describe('per-user security — owner allowed', () => {
  it('alice creates her own note and reads it back via where(owner==alice)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setupAliceBob(ctx, port);

    await signIn(ctx, port, 'alice@example.com', 'password-alice');

    // Create a note owned by alice → allowed.
    const create = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: "alice's note", owner: aliceUid },
    });
    expect(create.ok).toBe(true);

    // Query scoped to alice → the proof discharges the read; returns her note.
    const q = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs', source: notesByOwner(aliceUid),
    });
    const value = okValue<{ docs: Array<{ data: { json: string } }> }>(q);
    expect(value.docs.length).toBe(1);
    expect(JSON.parse(value.docs[0]!.data.json).text).toBe("alice's note");
  });
});

// ════════════════════════════════════════════════════════════════════════
//  2. Cross-user write denied
// ════════════════════════════════════════════════════════════════════════

describe('per-user security — cross-user write denied', () => {
  it("alice cannot create a note stamped with bob's uid", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { bobUid } = await setupAliceBob(ctx, port);

    await signIn(ctx, port, 'alice@example.com', 'password-alice');

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: 'forged', owner: bobUid },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  3. Cross-user read denied
// ════════════════════════════════════════════════════════════════════════

describe('per-user security — cross-user read denied', () => {
  it("alice cannot getDoc bob's note", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { bobNotePath } = await setupAliceBob(ctx, port);

    await signIn(ctx, port, 'alice@example.com', 'password-alice');

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: bobNotePath,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });

  it("alice's query where(owner==bob) is denied (rules are not filters)", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { bobUid } = await setupAliceBob(ctx, port);

    await signIn(ctx, port, 'alice@example.com', 'password-alice');

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs', source: notesByOwner(bobUid),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  4. Logged-out write denied
// ════════════════════════════════════════════════════════════════════════

describe('per-user security — logged-out write denied', () => {
  it('signed out → create any note is denied', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setupAliceBob(ctx, port);

    // Everyone is signed out after setup.
    expect(ctx.auth?.currentUser ?? null).toBeNull();

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: 'anon note', owner: aliceUid },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  5. Logged-out read denied
// ════════════════════════════════════════════════════════════════════════

describe('per-user security — logged-out read denied', () => {
  it("signed out → getDoc of an existing note is denied", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { bobNotePath } = await setupAliceBob(ctx, port);

    expect(ctx.auth?.currentUser ?? null).toBeNull();

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: bobNotePath,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });

  it('signed out → query is denied', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { bobUid } = await setupAliceBob(ctx, port);

    expect(ctx.auth?.currentUser ?? null).toBeNull();

    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs', source: notesByOwner(bobUid),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('permission-denied');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  6. THE KEY ONE — active listener behavior on a bare sign-out
// ════════════════════════════════════════════════════════════════════════
//
// Open an onSnapshot on where(owner==alice) as alice → it delivers alice's
// notes. Then sign out (an auth change with NO data write) and observe what
// the listener does.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ FIXED (was a verified security gap; now closed):                       │
// │                                                                        │
// │ A BARE AUTH-STATE CHANGE NOW RE-EVALUATES ACTIVE LIVE LISTENERS.       │
// │                                                                        │
// │ Behavior: after `signOut()` with NO data write, a `getFirestore(      │
// │ sandbox)` (sandbox-live) auth-gated listener RE-FIRES and LOSES        │
// │ ACCESS — it delivers a `permission-denied` error (no longer the       │
// │ stale, now-unauthorized snapshot it last saw). This matches           │
// │ production, which re-establishes the listen stream on a session auth  │
// │ change (an auth-gated listener gets permission-denied on sign-out).   │
// │                                                                        │
// │ THE FIX (pyric/src/firestore/index.ts + sandbox listener model):     │
// │   • The sandbox-live `onSnapshot` now marks its listener as           │
// │     `followsCurrentUser` (snapshot-listeners.ts / addSnapshotListener)│
// │     — threaded down via the FOLLOWS_CURRENT_USER channel.             │
// │   • SandboxImpl's currentUser change calls                            │
// │     `LocalEnvironment.reevaluateLiveListeners(newAuth)`, which         │
// │     re-captures each live listener's `auth` and re-runs the same      │
// │     per-listener eval `deployRules` uses (allowed↔denied flip).       │
// │   • Frozen-ctx (`getFirestore(ctx)`) listeners stay PINNED — they are │
// │     untouched by currentUser changes (admin/testing path).           │
// │   • Write-driven re-eval is unchanged: a write still re-evaluates     │
// │     each listener under ITS OWN captured auth.                        │
// │                                                                        │
// │ SECURITY OUTCOME: a worker-hosted onSnapshot under auth-gated rules   │
// │ no longer leaks the signed-in user's data to a now-signed-out page.  │
// │ The client SHOULD still unsubscribe on sign-out for hygiene, but the  │
// │ sandbox no longer depends on it for correctness.                     │
// │                                                                        │
// │ This test now asserts the FIXED behavior: the listener re-fires on a  │
// │ bare sign-out and loses access (error / no stale data).              │
// └──────────────────────────────────────────────────────────────────────┘

describe('per-user security — active listener on bare sign-out', () => {
  it('an active live listener IS re-evaluated on a bare sign-out and loses access', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setupAliceBob(ctx, port);

    await signIn(ctx, port, 'alice@example.com', 'password-alice');

    // alice creates a note so the listener has something to deliver.
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: "alice's live note", owner: aliceUid },
    });

    // Open the scoped listener.
    const SUB = 'alice-notes-sub';
    await handleMessage(ctx, port, { t: 'sub', subId: SUB, target: notesByOwner(aliceUid) });
    await tick();

    const snapsFor = () => port.snapMessages.filter((m) => m.subId === SUB);

    // Initial fire delivers alice's note (no __error).
    const initial = snapsFor();
    expect(initial.length).toBeGreaterThanOrEqual(1);
    const firstVal = initial.at(-1)!.value as { docs?: Array<{ data: { json: string } }>; __error?: unknown };
    expect(firstVal.__error).toBeUndefined();
    expect(firstVal.docs?.length).toBe(1);
    expect(JSON.parse(firstVal.docs![0]!.data.json).text).toBe("alice's live note");

    const countBeforeSignOut = snapsFor().length;

    // ── THE CRITICAL ACTION: a bare auth change (sign-out), NO data write. ──
    await signOut(ctx, port);
    await tick();

    const after = snapsFor();
    const newSnaps = after.slice(countBeforeSignOut);

    const lastVal = after.at(-1)!.value as { docs?: Array<{ data: { json: string } }>; __error?: { code: string } };
    const firedAgain = newSnaps.length > 0;
    const lastIsError = !!lastVal.__error;
    const lastDocCount = lastVal.docs?.length ?? null;

    // Diagnostic capture (the headline numbers for the report).
    // eslint-disable-next-line no-console
    console.log(
      `[listener-on-signout] firedAgainAfterSignOut=${firedAgain} ` +
      `newSnapCount=${newSnaps.length} lastIsError=${lastIsError} ` +
      `lastErrorCode=${lastVal.__error?.code ?? 'none'} lastDocCount=${lastDocCount}`,
    );

    // ── ASSERTING THE FIXED (secure) BEHAVIOR — see FIXED box above. ──
    // The listener RE-FIRES on a bare sign-out…
    expect(firedAgain).toBe(true);
    // …and the new snapshot is a permission-denied error, NOT alice's
    // stale data. The live listener re-evaluated under the signed-out
    // identity and lost access — matching prod's stream re-establishment.
    expect(lastIsError).toBe(true);
    expect(lastVal.__error?.code).toBe('permission-denied');
    // No stale doc leaks through.
    expect(lastDocCount).not.toBe(1);
  });

  it('mitigation: explicit unsub on sign-out stops delivery (what the Task-1 demo does)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const { aliceUid } = await setupAliceBob(ctx, port);

    await signIn(ctx, port, 'alice@example.com', 'password-alice');
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: "alice's live note", owner: aliceUid },
    });

    const SUB = 'alice-notes-sub-2';
    await handleMessage(ctx, port, { t: 'sub', subId: SUB, target: notesByOwner(aliceUid) });
    await tick();
    expect(port.snapMessages.filter((m) => m.subId === SUB).length).toBeGreaterThanOrEqual(1);

    // The correct pattern: unsubscribe BEFORE/ON sign-out.
    await handleMessage(ctx, port, { t: 'unsub', subId: SUB });
    const countAfterUnsub = port.snapMessages.filter((m) => m.subId === SUB).length;

    await signOut(ctx, port);
    await tick();
    // A subsequent write by anyone must not reach the torn-down listener.
    await signIn(ctx, port, 'alice@example.com', 'password-alice');
    await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'notes',
      data: { text: 'post-unsub', owner: aliceUid },
    });
    await tick();

    expect(port.snapMessages.filter((m) => m.subId === SUB).length).toBe(countAfterUnsub);
  });
});
