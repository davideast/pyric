/**
 * `getFirestore(sandbox)` — live-identity sandbox target.
 *
 * Covers the `(sandbox: Sandbox)` overload that reads
 * `sandbox.currentUser` per-op. Counterpart to the frozen-ctx
 * `getFirestore(ctx)` overload (covered in `sandbox-target.test.ts`).
 *
 * The integration seam: `pyric/auth`'s sandbox backend writes
 * through to `sandbox.currentUser`. App code that uses both
 * `pyric/auth` and `pyric/firestore` against the same `Sandbox`
 * should see auth-state changes live — every Firestore op evaluates
 * rules under whatever user is currently signed in, without
 * re-binding the Firestore handle.
 *
 * These tests don't depend on `pyric/auth`; they mutate
 * `sandbox.currentUser` directly to simulate what `signIn*` /
 * `setUser` would do. That keeps the test surface focused on the
 * `pyric/firestore` behavior and avoids a cross-package
 * dependency cycle.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  query,
  where,
  onSnapshot,
  refEqual,
  SandboxError,
  type Firestore,
  type DocumentSnapshot,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

/**
 * Rules that gate writes/reads by `request.auth.uid`. Tight enough
 * that a stale identity surfaces as `permission-denied`, loose
 * enough that a fresh anonymous read of `/public/*` works.
 */
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /public/{id} {
      allow read: if true;
      allow write: if request.auth == null;
    }
    match /items/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

/**
 * Build a sandbox + a live-identity Firestore handle and seed rules.
 * Returns both so tests can mutate `sandbox.currentUser` directly.
 */
function setup(): { sandbox: ReturnType<typeof initializeSandbox>; db: Firestore } {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox);
  setRules(sandbox, RULES);
  return { sandbox, db };
}

describe('getFirestore(sandbox) — handle construction', () => {
  it('returns a Firestore handle for a bare Sandbox', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    // Smoke: every Firestore handle exposes the `TARGET_SYMBOL` brand
    // (we don't import the symbol; the existence check is enough).
    expect(db).toBeTruthy();
    expect(typeof db).toBe('object');
  });

  it('two getFirestore(sandbox) handles share the same sandbox', async () => {
    const { sandbox, db } = setup();
    const db2 = getFirestore(sandbox);
    sandbox.currentUser = { uid: 'shared' };
    await setDoc(doc(db, 'users/shared'), { source: 'db1' });
    // db2 reads via the same sandbox — should see the doc db wrote.
    const snap = await getDoc(doc(db2, 'users/shared'));
    expect(snap.data()?.source).toBe('db1');
  });
});

describe('per-op identity reads', () => {
  it('write under alice lands under alice', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'users/alice'), { name: 'Alice' });
    const state = sandbox.snapshot().firestore;
    expect(state['users/alice']).toEqual({ name: 'Alice' });
  });

  it('identity change between calls — alice then bob', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'users/alice'), { name: 'Alice' });

    sandbox.currentUser = { uid: 'bob' };
    await setDoc(doc(db, 'users/bob'), { name: 'Bob' });

    const state = sandbox.snapshot().firestore;
    expect(state['users/alice']).toEqual({ name: 'Alice' });
    expect(state['users/bob']).toEqual({ name: 'Bob' });
  });

  it('switching to bob denies a write under alice\'s path', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'users/alice'), { name: 'Alice' });

    sandbox.currentUser = { uid: 'bob' };
    // Bob trying to write to alice's doc — rules deny.
    let err: unknown;
    try {
      await setDoc(doc(db, 'users/alice'), { name: 'Spoofed' });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
  });

  it('anonymous fallback — currentUser=null lets the public path through', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = null;
    // /public/* allows writes only when auth IS null — verifies that
    // `sandbox.currentUser = null` materializes as `request.auth == null`.
    await setDoc(doc(db, 'public/p1'), { title: 'open' });
    const snap = await getDoc(doc(db, 'public/p1'));
    expect(snap.data()?.title).toBe('open');
  });

  it('signed-in user is blocked from the anonymous-only public path', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    // /public allows writes only for `auth == null`. Alice signed in
    // should be denied — confirms identity actually surfaces to rules.
    let err: unknown;
    try {
      await setDoc(doc(db, 'public/p2'), { title: 'blocked' });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
  });

  it('held doc ref re-resolves under the current user', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    // Build the ref under alice's auth. The ref itself doesn't lock
    // an identity — the next op should re-resolve.
    const ref = doc(db, 'users/bob');

    sandbox.currentUser = { uid: 'bob' };
    // Same ref, different user. Now bob can write to bob's doc.
    await setDoc(ref, { name: 'Bob' });
    const state = sandbox.snapshot().firestore;
    expect(state['users/bob']).toEqual({ name: 'Bob' });
  });

  it('addDoc result is a tagged live ref usable in follow-up calls', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    const ref = await addDoc(collection(db, 'items'), { tag: 'auto' });
    expect(ref.path).toMatch(/^items\/[A-Za-z0-9]+$/);
    // Follow-up under same user: read should succeed.
    const snap = await getDoc(ref);
    expect(snap.data()?.tag).toBe('auto');
  });

  it('updateDoc re-evaluates auth per call', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'users/alice'), { name: 'Alice', age: 1 });

    sandbox.currentUser = { uid: 'bob' };
    // Bob updating alice's doc — denied.
    let err: unknown;
    try {
      await updateDoc(doc(db, 'users/alice'), { age: 99 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
  });
});

describe('query identity tracking', () => {
  it('query results re-evaluate under the current user', async () => {
    const { sandbox, db } = setup();
    // Seed shared items under alice (rules allow any signed-in user
    // to read /items/*).
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'items/i1'), { owner: 'alice', n: 1 });
    await setDoc(doc(db, 'items/i2'), { owner: 'bob', n: 2 });

    // Build a query AS alice; execute AS bob. Both have read access
    // to /items, so both see all rows.
    const q = query(collection(db, 'items'), where('n', '>=', 1));

    sandbox.currentUser = { uid: 'bob' };
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
  });

  it('doc read denied when current user lacks read access', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'items/i1'), { n: 1 });

    // Sign out — anonymous users can't read /items (rule requires
    // request.auth != null). Same path, different auth → deny.
    sandbox.currentUser = null;
    let err: unknown;
    try {
      await getDoc(doc(db, 'items/i1'));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
  });
});

describe('cross-target equality', () => {
  it('refEqual returns true for live and frozen refs at the same path', () => {
    const sandbox = initializeSandbox();
    const liveDb = getFirestore(sandbox);
    const frozenDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const a = doc(liveDb, 'users/x');
    const b = doc(frozenDb, 'users/x');
    expect(refEqual(a, b)).toBe(true);
  });

  it('refEqual returns false for different paths under the same flavor', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const a = doc(db, 'users/x');
    const b = doc(db, 'users/y');
    expect(refEqual(a, b)).toBe(false);
  });
});

describe('onSnapshot identity persistence', () => {
  it('live listener registered as alice LOSES access after setUser → bob (auth-change re-eval)', async () => {
    const { sandbox, db } = setup();
    // Seed: alice's doc.
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'users/alice'), { name: 'Alice', count: 0 });

    // Listen as alice on a live handle (`getFirestore(sandbox)`). The
    // listener captures alice's identity AND follows `currentUser`:
    // switching the session to bob must re-establish the listener under
    // bob's auth — and bob cannot read `users/alice` (rules require
    // `auth.uid == uid`), so the listener loses access. This matches
    // production, which re-establishes the listen stream on a session
    // auth change. (Pre-fix this kept emitting alice's data — the
    // security gap this fix closes.)
    const seen: Array<Record<string, unknown> | undefined> = [];
    let errCode: string | undefined;
    const unsub = onSnapshot(
      doc(db, 'users/alice'),
      (snap) => {
        seen.push((snap as DocumentSnapshot).data() as Record<string, unknown> | undefined);
      },
      (err) => { errCode = (err as SandboxError).code; },
    );
    // Allow the initial fire to land.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(1);
    expect(seen[0]?.count).toBe(0);

    // Swap the session to bob — a bare auth change, no data write. The
    // live listener re-evaluates under bob and is denied.
    sandbox.currentUser = { uid: 'bob' };
    await new Promise((r) => setTimeout(r, 10));
    expect(errCode).toBe('permission-denied');

    // A subsequent write to alice's doc (as alice) must NOT reach the
    // now-errored listener — it lost access on the auth change.
    const aliceWrite = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(aliceWrite, 'users/alice'), { name: 'Alice', count: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(1);
    unsub();
  });

  it('listener registered as anonymous on /public keeps firing after sign-in', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, RULES);

    // Seed a public doc anonymously.
    sandbox.currentUser = null;
    await setDoc(doc(db, 'public/p1'), { v: 0 });

    const seen: Array<Record<string, unknown> | undefined> = [];
    const unsub = onSnapshot(doc(db, 'public/p1'), (snap) => {
      seen.push((snap as DocumentSnapshot).data() as Record<string, unknown> | undefined);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]?.v).toBe(0);

    // Sign in — the listener was registered while signed-out. The
    // public path is readable by anyone, so the listener keeps
    // firing regardless of subsequent identity mutations.
    sandbox.currentUser = { uid: 'alice' };
    // Update via an admin path to avoid auth complications.
    sandbox.admin.setDocument('public/p1', { v: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[seen.length - 1]?.v).toBe(1);
    unsub();
  });

  it('snapshot ref is usable in subsequent ops under the new user', async () => {
    const { sandbox, db } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(db, 'users/alice'), { v: 1 });

    let snapRef: { path?: string } | null = null;
    const unsub = onSnapshot(doc(db, 'users/alice'), (snap) => {
      // `snap.ref` should be tagged & wired so a follow-up op routes
      // correctly. Capture once.
      if (!snapRef) snapRef = (snap as { ref?: { path?: string } }).ref ?? null;
    });
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(snapRef).not.toBeNull();
    expect((snapRef as unknown as { path: string }).path).toBe('users/alice');
    // A follow-up read through the snap ref still resolves under
    // the CURRENT user — alice can read alice's doc.
    const followUp = await getDoc(snapRef as unknown as Parameters<typeof getDoc>[0]);
    expect((followUp.data() as { v: number } | undefined)?.v).toBe(1);
  });
});

describe('query identity-equality across flavors', () => {
  it('cross-flavor refEqual via QuerySnapshot doc refs', async () => {
    const sandbox = initializeSandbox();
    const liveDb = getFirestore(sandbox);
    const frozenDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    setRules(sandbox, RULES);
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(liveDb, 'items/q1'), { n: 1 });

    const liveSnap = await getDocs(collection(liveDb, 'items')) as QuerySnapshot;
    const frozenRef = doc(frozenDb, 'items/q1');
    // The snapshot's doc[0].ref should compare equal to a fresh
    // frozen-ctx ref at the same path.
    const snapDocRef = (liveSnap.docs[0] as unknown as { ref: Parameters<typeof refEqual>[0] }).ref;
    expect(refEqual(snapDocRef, frozenRef)).toBe(true);
  });
});
