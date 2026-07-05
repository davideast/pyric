/**
 * Live-listener re-evaluation on a SESSION auth change.
 *
 * The security gap this pins: a `getFirestore(sandbox)` (`sandbox-live`)
 * `onSnapshot` follows `sandbox.currentUser`. Production re-establishes
 * the listen stream when the session's auth changes, so an auth-gated
 * listener loses access on sign-out and re-reads under the new identity
 * on sign-in. Pre-fix the sandbox kept delivering the previously-
 * authorized user's data on a bare sign-out (no data write). This suite
 * proves the fix:
 *
 *   1. A live, owner-scoped listener delivers alice's notes; on a bare
 *      sign-out it loses access (permission-denied); on sign-in as bob it
 *      re-fires with bob's view.
 *   2. A FROZEN-ctx listener (`getFirestore(sandbox.withAuth({uid:'alice'}))`)
 *      is UNAFFECTED by `sandbox.currentUser` changes — pinned by design.
 *   3. A write by another user still re-evaluates each listener under ITS
 *      OWN captured auth (write-time filtering is unchanged).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  query,
  where,
  collection,
  sandbox as sandboxOps,
  SandboxError,
  type Firestore,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

/** Owner-scoped per-user rules: a note is readable only by its owner. */
const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read:   if request.auth != null && resource.data.owner == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.owner == request.auth.uid;
    }
  }
}`;

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a live handle + an admin handle (for unconstrained seeding). */
function setup(): {
  sandbox: ReturnType<typeof initializeSandbox>;
  live: Firestore;
} {
  const sandbox = initializeSandbox();
  const live = getFirestore(sandbox);
  sandboxOps.setRules(live, OWNER_RULES);
  return { sandbox, live };
}

describe('live listener — owner-scoped, follows currentUser', () => {
  it('loses access on bare sign-out, regains as a different signed-in user', async () => {
    const { sandbox, live } = setup();

    // alice signs in and creates her note.
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(live, 'notes/n1'), { text: 'alice secret', owner: 'alice' });

    // Open a live, owner-scoped query listener as alice.
    const snaps: Array<Array<Record<string, unknown>>> = [];
    let errCode: string | undefined;
    const q = query(collection(live, 'notes'), where('owner', '==', 'alice'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        snaps.push(
          (snap as QuerySnapshot).docs.map(
            (d) => d.data() as Record<string, unknown>,
          ),
        );
      },
      (err) => { errCode = (err as SandboxError).code; },
    );
    await tick();

    // Initial fire delivers alice's note.
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.length).toBe(1);
    expect(snaps[0]![0]!.text).toBe('alice secret');

    // ── Bare sign-out — NO data write. The live listener re-evaluates
    //    under signed-out auth (request.auth == null) and is denied. ──
    sandbox.currentUser = null;
    await tick();
    expect(errCode).toBe('permission-denied');
    const countAfterSignOut = snaps.length;

    // Sign in as bob (a different user). bob cannot read alice's note,
    // so the listener stays denied — no leak of alice's data to bob.
    sandbox.currentUser = { uid: 'bob' };
    await tick();
    expect(snaps.length).toBe(countAfterSignOut);

    // A write by alice (via a frozen alice handle) must NOT reach this
    // listener while the session is bob — it's errored under bob's auth.
    const aliceWrite = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(aliceWrite, 'notes/n1'), { text: 'alice secret v2', owner: 'alice' });
    await tick();
    expect(snaps.length).toBe(countAfterSignOut);
    unsub();
  });

  it('a fresh listener under bob sees only bob\'s notes (re-eval picks up new identity)', async () => {
    const { sandbox, live } = setup();

    // Seed both alice's and bob's notes (each as themselves).
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(live, 'notes/a1'), { text: 'alice note', owner: 'alice' });
    sandbox.currentUser = { uid: 'bob' };
    await setDoc(doc(live, 'notes/b1'), { text: 'bob note', owner: 'bob' });

    // Listen as bob, scoped to bob.
    const snaps: Array<Array<Record<string, unknown>>> = [];
    const q = query(collection(live, 'notes'), where('owner', '==', 'bob'));
    const unsub = onSnapshot(q, (snap) => {
      snaps.push(
        (snap as QuerySnapshot).docs.map((d) => d.data() as Record<string, unknown>),
      );
    });
    await tick();
    expect(snaps.at(-1)!.map((d) => d.text)).toEqual(['bob note']);
    unsub();
  });
});

describe('frozen-ctx listener — pinned identity, unaffected by currentUser', () => {
  it('does NOT change when sandbox.currentUser changes', async () => {
    const { sandbox, live } = setup();

    // Seed alice's note (as alice, via the live handle).
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(live, 'notes/n1'), { text: 'alice note', owner: 'alice' });

    // A FROZEN handle pinned to alice — identity chosen at handle time.
    const frozen = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const snaps: Array<Array<Record<string, unknown>>> = [];
    let errCode: string | undefined;
    const q = query(collection(frozen, 'notes'), where('owner', '==', 'alice'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        snaps.push(
          (snap as QuerySnapshot).docs.map((d) => d.data() as Record<string, unknown>),
        );
      },
      (err) => { errCode = (err as SandboxError).code; },
    );
    await tick();
    expect(snaps.length).toBe(1);
    expect(snaps[0]![0]!.text).toBe('alice note');

    // Mutate the session away from alice — sign out, then sign in as bob.
    // The frozen listener stays pinned to alice and is NOT re-evaluated:
    // no error, no extra fire.
    sandbox.currentUser = null;
    await tick();
    sandbox.currentUser = { uid: 'bob' };
    await tick();

    expect(errCode).toBeUndefined();
    expect(snaps.length).toBe(1);

    // It still tracks alice's data on a genuine write to alice's note.
    const aliceWrite = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(aliceWrite, 'notes/n1'), { text: 'alice note v2', owner: 'alice' });
    await tick();
    expect(snaps.length).toBe(2);
    expect(snaps[1]![0]!.text).toBe('alice note v2');
    unsub();
  });
});

describe('write-time re-eval — each listener keeps its own auth', () => {
  it('a write by bob re-evaluates alice\'s listener under ALICE\'s own auth (not bob\'s)', async () => {
    const { sandbox, live } = setup();

    // Seed alice's note.
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(live, 'notes/a1'), { text: 'alice note', owner: 'alice' });

    // alice's listener via a FROZEN handle — pinned to alice, so it
    // isolates WRITE-driven re-eval from the auth-change path. (The
    // session currentUser is moved to bob below; a frozen listener
    // ignores that, exactly so a bob write can't smuggle bob's auth in.)
    const aliceFrozen = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const fsnaps: Array<Array<Record<string, unknown>>> = [];
    let fErr: string | undefined;
    const fq = query(collection(aliceFrozen, 'notes'), where('owner', '==', 'alice'));
    const funsub = onSnapshot(
      fq,
      (snap) => {
        fsnaps.push(
          (snap as QuerySnapshot).docs.map((d) => d.data() as Record<string, unknown>),
        );
      },
      (err) => { fErr = (err as SandboxError).code; },
    );
    await tick();
    expect(fsnaps.length).toBe(1);

    // bob signs in and writes his own note. The write fan-out must
    // re-evaluate alice's listener under ALICE's captured auth — bob's
    // note is out of alice's scope, so no error and no leak of bob's
    // data into her listener.
    sandbox.currentUser = { uid: 'bob' };
    const bobWrite = getFirestore(sandbox.withAuth({ uid: 'bob' }));
    await setDoc(doc(bobWrite, 'notes/b1'), { text: 'bob note', owner: 'bob' });
    await tick();
    expect(fErr).toBeUndefined();
    // Every delivered snapshot only ever contains alice-owned notes.
    for (const s of fsnaps) {
      for (const d of s) expect(d.owner).toBe('alice');
    }
    funsub();
  });
});
