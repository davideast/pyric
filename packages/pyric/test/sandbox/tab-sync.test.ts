/**
 * Tests for `sandbox.enableTabSync()` — cross-tab realtime via BroadcastChannel.
 *
 * Test strategy: inject an in-memory hub instead of a real BroadcastChannel.
 * The hub connects N `BroadcastChannelLike` endpoints: `postMessage` on one
 * endpoint delivers `{ data }` to all OTHER endpoints' message listeners,
 * synchronously (simplest; avoids async timing issues in assertions).
 *
 * Important: this means the echo-suppression and re-entrancy guard paths are
 * exercised in the same synchronous call stack — the strongest possible test.
 * Browser BroadcastChannel delivers async; we accept the sync simplification
 * here because the guard logic is the same regardless of delivery timing.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import type { BroadcastChannelLike } from '../../src/sandbox/tab-sync/index.js';
import type { Sandbox, WriteSandboxEvent } from '../../src/sandbox/index.js';

// ─── In-memory test hub ────────────────────────────────────────────────────

/**
 * A synchronous in-memory hub that connects multiple `BroadcastChannelLike`
 * endpoints. Calling `postMessage` on any endpoint delivers the message
 * synchronously to ALL OTHER endpoints' registered `message` listeners.
 *
 * Why synchronous: simplifies assertions (no async/await needed for write→receive
 * paths) and makes the re-entrancy guard's boolean-sufficiency obvious — the
 * entire write→broadcast→receive→apply cycle runs in one synchronous call stack.
 */
class TestHub {
  private endpoints: TestEndpoint[] = [];

  createEndpoint(): TestEndpoint {
    const ep = new TestEndpoint(this);
    this.endpoints.push(ep);
    return ep;
  }

  /** Called by an endpoint to deliver a message to all OTHERS. */
  broadcast(sender: TestEndpoint, message: unknown): void {
    for (const ep of this.endpoints) {
      if (ep === sender) continue; // never deliver to self (mirrors BroadcastChannel spec)
      ep.receive(message);
    }
  }

  remove(ep: TestEndpoint): void {
    this.endpoints = this.endpoints.filter((e) => e !== ep);
  }

  /** Total messages posted across all endpoints (for loop-detection). */
  get totalPosted(): number {
    return this.endpoints.reduce((acc, ep) => acc + ep.postedCount, 0);
  }
}

class TestEndpoint implements BroadcastChannelLike {
  private listeners: Array<(ev: { data: unknown }) => void> = [];
  /** Count of postMessage() calls on this endpoint. */
  postedCount = 0;
  closed = false;

  constructor(private readonly hub: TestHub) {}

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.postedCount++;
    this.hub.broadcast(this, message);
  }

  addEventListener(_type: 'message', listener: (ev: { data: unknown }) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: 'message', listener: (ev: { data: unknown }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  close(): void {
    this.closed = true;
    this.hub.remove(this);
  }

  /** Internal: receive a message from the hub. */
  receive(message: unknown): void {
    for (const l of this.listeners) {
      l({ data: message });
    }
  }
}

// ─── Open rules for tests ──────────────────────────────────────────────────

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/**
 * Rules that deny reads/writes to `restricted/doc` for everyone.
 * Used in the rules-aware test to confirm that received writes still go
 * through the listener-read-rules path.
 */
const RESTRICTED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{id} { allow read, write: if true; }
    match /restricted/{id} { allow write: if true; allow read: if false; }
  }
}`;

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create a sandbox with open rules seeded. Returns sandbox + internal env. */
function makeSandbox(rules = OPEN_RULES) {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules });
  return { sandbox, env };
}

/**
 * Collect all snapshot values delivered to a listener. Returns the array
 * (mutated in place on each delivery) and an unsubscribe function.
 *
 * Uses `env.addSnapshotListener` directly so we don't depend on the
 * firestore adapter package — keeps this test self-contained in sandbox/.
 */
function watchDoc(sandbox: Sandbox, path: string, auth = null as import('../../src/sandbox/index.js').AuthState) {
  const env = getInternalEnv(sandbox);
  const snapshots: Array<unknown> = [];
  const unsub = env.addSnapshotListener(
    { kind: 'doc', path },
    (snap) => { snapshots.push(snap); },
    {},
    auth,
  );
  // Items 3 + 5 — initial + write-driven fires are microtask-deferred; drain
  // them synchronously so this helper's callers keep their sync assertions.
  env.flushListeners();
  return { snapshots, unsub };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('sandbox.enableTabSync', () => {

  // ── 1. Cross-tab write ────────────────────────────────────────────────
  it('cross-tab write: A writes a doc, B listener fires', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB } = makeSandbox();

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();

    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    // Register a listener on B BEFORE A writes.
    const { snapshots: bSnaps } = watchDoc(sbB, 'users/1');

    // Initial snapshot fires on registration (doc doesn't exist yet).
    // snapshots[0] is the empty initial snapshot; we'll check snapshots[1].
    expect(bSnaps.length).toBe(1);

    // A writes the doc.
    envA.execute({
      method: 'set',
      path: 'users/1',
      auth: null,
      data: { name: 'Alice' },
    });

    // B's listener should have fired with the new doc data.
    getInternalEnv(sbB).flushListeners();
    expect(bSnaps.length).toBe(2);
    // The snapshot is a DocumentSnapshot-like object; check that the doc exists.
    const snap2 = bSnaps[1] as { exists: () => boolean; data: () => unknown };
    expect(snap2.exists()).toBe(true);
    expect((snap2.data() as Record<string, unknown>).name).toBe('Alice');
  });

  // ── 2. Echo / no infinite loop ────────────────────────────────────────
  it('echo suppression: A write does NOT re-broadcast (no loop)', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();

    const epA = hub.createEndpoint();
    // Only one tab in the hub — any re-broadcast would come back to epA
    // via other endpoints. Since there are none, we check postedCount.
    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });

    // Add another endpoint to observe re-broadcasts.
    const epObserver = hub.createEndpoint();
    let remoteMessages = 0;
    epObserver.addEventListener('message', () => { remoteMessages++; });

    // A writes once.
    envA.execute({ method: 'set', path: 'users/1', auth: null, data: { x: 1 } });

    // epA should have posted exactly 1 message (the write broadcast).
    // If a loop occurred, postedCount would be > 1.
    // The initial hello also posted 1, total = 2.
    // After the write: write-broadcast = 1 more, total = 3 (hello + write).
    // If looping, applying the write back would fire onEvent again → another post.
    // Since the observer receives the write and reflects it back to epA, let's count:
    //
    // Actually: epA posted `hello` (1) + the write (1) = 2 so far.
    // epObserver received the write. If epObserver were a real tab with
    // enableTabSync, applying it would be guarded. But here epObserver is
    // just a raw counter — it doesn't apply anything. We use a two-tab setup
    // in the next assertion to verify the guard in the apply path.

    // Tab A's listener fires exactly once (from the local write, not a re-apply).
    const { snapshots: aSnaps } = watchDoc(sbA, 'users/1');
    // The listener fires the initial snapshot immediately on registration.
    // The initial fire sees the doc already (we wrote it above).
    expect(aSnaps.length).toBe(1);

    // No extra write from A after the initial one.
    const totalBeforeSecondWrite = epA.postedCount;
    envA.execute({ method: 'set', path: 'users/2', auth: null, data: { y: 2 } });
    // Should be exactly 1 more post (the new write broadcast).
    expect(epA.postedCount).toBe(totalBeforeSecondWrite + 1);
  });

  it('two-tab echo: A writes, B applies under guard, B does NOT re-broadcast', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB } = makeSandbox();

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();

    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    // Record all write events emitted on B.
    const bWriteEvents: WriteSandboxEvent[] = [];
    sbB.onEvent((ev) => { if (ev.kind === 'write') bWriteEvents.push(ev); });

    // Also track re-broadcasts: messages epB sends that are NOT its initial hello.
    // After enableTabSync, epB immediately posts hello (1 post).
    const epBHelloCount = epB.postedCount; // 1

    // A writes.
    envA.execute({ method: 'set', path: 'users/1', auth: null, data: { v: 1 } });

    // B received the write and applied it via admin. The admin apply emits a
    // write event on B (via LocalEnvironment internals). We verify it was NOT
    // re-broadcast by checking epB.postedCount didn't increase.
    //
    // Wait — actually adminSetDocument goes through notifyListenersForPaths
    // but does NOT emit a WriteSandboxEvent (it's not wired through emitWrite).
    // Let's verify: no write event on B means the admin path is pure state-only.
    // Either way, epB.postedCount must not have increased from the hello baseline.
    expect(epB.postedCount).toBe(epBHelloCount); // no re-broadcast

    // And A's doc is now visible in B's env.
    const bDoc = getInternalEnv(sbB).getDocument('users/1');
    expect(bDoc).toEqual({ v: 1 });
  });

  // ── 3. Delete propagates ──────────────────────────────────────────────
  it('delete propagates: A deletes a doc, B listener sees removal', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB, env: envB } = makeSandbox();

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();

    // Seed both envs with the same doc so B's listener fires on init.
    envA.seed({ rules: OPEN_RULES, documents: { 'items/1': { name: 'thing' } } });
    envB.seed({ rules: OPEN_RULES, documents: { 'items/1': { name: 'thing' } } });

    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    const { snapshots: bSnaps } = watchDoc(sbB, 'items/1');
    expect(bSnaps.length).toBe(1); // initial fire: doc exists

    // A deletes the doc.
    envA.execute({ method: 'delete', path: 'items/1', auth: null });

    // B's listener should have fired again; doc no longer exists.
    envB.flushListeners();
    expect(bSnaps.length).toBe(2);
    const snap2 = bSnaps[1] as { exists: () => boolean };
    expect(snap2.exists()).toBe(false);
  });

  // ── 4. Late join ──────────────────────────────────────────────────────
  it('late join: B joins after A has written data, state handshake seeds B', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB } = makeSandbox();

    const epA = hub.createEndpoint();

    // A enables tab sync and writes some docs FIRST.
    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    envA.execute({ method: 'set', path: 'users/alice', auth: null, data: { role: 'admin' } });
    envA.execute({ method: 'set', path: 'users/bob', auth: null, data: { role: 'user' } });

    // B now joins late.
    const epB = hub.createEndpoint();
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    // After enableTabSync, B sent a `hello`. A responded with `state`.
    // B applied the state to its local env (which was empty).
    const bEnv = getInternalEnv(sbB);
    expect(bEnv.getDocument('users/alice')).toEqual({ role: 'admin' });
    expect(bEnv.getDocument('users/bob')).toEqual({ role: 'user' });
  });

  it('late join: B with existing data ignores the state response', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB, env: envB } = makeSandbox();

    const epA = hub.createEndpoint();

    // A writes.
    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    envA.execute({ method: 'set', path: 'users/alice', auth: null, data: { role: 'admin' } });

    // B already has its own data.
    envB.seed({ rules: OPEN_RULES, documents: { 'users/local': { owned: true } } });

    const epB = hub.createEndpoint();
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    // B's hello triggered a state reply from A. But B had existing data,
    // so it must NOT have overwritten its local store with A's snapshot.
    expect(envB.getDocument('users/local')).toEqual({ owned: true });
    // A's doc should NOT be in B (B's data was not clobbered by state).
    // Note: if A's write arrived after B's join as a write-broadcast,
    // it WOULD be in B. But A wrote BEFORE B joined, so the only way
    // B sees it is via the state message — which we declined.
    expect(envB.getDocument('users/alice')).toBeNull();
  });

  // ── 5. Disable ───────────────────────────────────────────────────────
  it('disable: after disable, new A writes do NOT reach B', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB, env: envB } = makeSandbox();

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();

    const disableA = sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    // A writes once while enabled — B should receive it.
    envA.execute({ method: 'set', path: 'users/1', auth: null, data: { x: 1 } });
    expect(envB.getDocument('users/1')).toEqual({ x: 1 });

    // Disable A's sync.
    disableA();

    // A writes again — B should NOT receive this one.
    envA.execute({ method: 'set', path: 'users/2', auth: null, data: { y: 2 } });
    expect(envB.getDocument('users/2')).toBeNull();

    // B's own state (users/1 from the first write) is still intact.
    expect(envB.getDocument('users/1')).toEqual({ x: 1 });
  });

  it('disable: channel listener is detached (no stray deliveries)', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB } = makeSandbox();

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();

    const disableA = sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    disableA();

    // After disabling A, epA should no longer post anything.
    const postCountBeforeWrite = epA.postedCount;
    envA.execute({ method: 'set', path: 'docs/x', auth: null, data: { v: 1 } });
    expect(epA.postedCount).toBe(postCountBeforeWrite); // no new posts
  });

  // ── 6. Rules-aware on receive ─────────────────────────────────────────
  it('rules-aware: B listener under deny-read rule does NOT fire for denied path', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox(RESTRICTED_RULES);
    const { sandbox: sbB, env: envB } = makeSandbox(RESTRICTED_RULES);

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();

    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });

    // B registers a listener on `restricted/doc` as an unauthenticated user.
    // The rules say `allow read: if false` for restricted/* — so the listener
    // will be marked errored on the initial fire (permission-denied), and
    // no further snapshots will be delivered.
    const snapsFromRestricted: unknown[] = [];
    const errors: unknown[] = [];
    envB.addSnapshotListener(
      { kind: 'doc', path: 'restricted/doc' },
      (snap) => { snapsFromRestricted.push(snap); },
      {},
      null, // auth: anonymous
      (err) => { errors.push(err); },
    );

    // B also registers a listener on `users/1` which IS readable.
    const snapsFromUsers: unknown[] = [];
    envB.addSnapshotListener(
      { kind: 'doc', path: 'users/1' },
      (snap) => { snapsFromUsers.push(snap); },
      {},
      null,
    );

    // Initial fires: restricted → error (not delivered as snapshot); users/1 → OK.
    envB.flushListeners();
    expect(errors.length).toBe(1); // restriction errored the listener
    expect(snapsFromRestricted.length).toBe(0); // no snapshot delivered (errored)
    expect(snapsFromUsers.length).toBe(1); // initial fire for users/1 (empty doc)

    // A writes to both paths. The restricted write is allowed at the WRITE level
    // (RESTRICTED_RULES allows write: if true for restricted/*).
    envA.execute({ method: 'set', path: 'restricted/doc', auth: null, data: { secret: 'x' } });
    envA.execute({ method: 'set', path: 'users/1', auth: null, data: { pub: 'y' } });
    envB.flushListeners();

    // The admin apply in B for `restricted/doc` calls notifyListenersForPaths,
    // which re-evaluates the listener under its registered auth (null). The
    // listener is already errored so it won't fire again (markErrored is final).
    // Net result: no snapshot delivered to the restricted listener.
    expect(snapsFromRestricted.length).toBe(0);

    // users/1 write should have propagated and fired B's listener.
    expect(snapsFromUsers.length).toBe(2);
    const usersSnap = snapsFromUsers[1] as { exists: () => boolean; data: () => unknown };
    expect(usersSnap.exists()).toBe(true);
    expect((usersSnap.data() as Record<string, unknown>).pub).toBe('y');

    // Verify that the admin apply DID land in B's env (write itself succeeded).
    expect(envB.getDocument('restricted/doc')).toEqual({ secret: 'x' });
    expect(envB.getDocument('users/1')).toEqual({ pub: 'y' });
  });

  // ── 7. Multiple tabs ──────────────────────────────────────────────────
  it('three tabs: write from A propagates to both B and C', () => {
    const hub = new TestHub();
    const { sandbox: sbA, env: envA } = makeSandbox();
    const { sandbox: sbB, env: envB } = makeSandbox();
    const { sandbox: sbC, env: envC } = makeSandbox();

    const epA = hub.createEndpoint();
    const epB = hub.createEndpoint();
    const epC = hub.createEndpoint();

    sbA.enableTabSync({ channel: epA, originId: 'tab-A' });
    sbB.enableTabSync({ channel: epB, originId: 'tab-B' });
    sbC.enableTabSync({ channel: epC, originId: 'tab-C' });

    envA.execute({ method: 'set', path: 'posts/1', auth: null, data: { title: 'Hello' } });

    expect(envB.getDocument('posts/1')).toEqual({ title: 'Hello' });
    expect(envC.getDocument('posts/1')).toEqual({ title: 'Hello' });
  });
});
