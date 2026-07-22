/**
 * Oracle conformance — wires `packages/conformance/observations/firestore/firestore-*.json`
 * into the test suite so the captured real-Firebase-Firestore behavior is
 * MACHINE-CHECKED against the sandbox shim, not just cited in comments
 * (mirrors `test/auth/oracle-conformance.test.ts` and
 * `test/storage/oracle-conformance.test.ts`, which closed the same gap for
 * auth and storage — see the auth file's header for the H5/H6 rationale).
 *
 * Pattern: each test loads its observation and replays the scenario against
 * the in-process sandbox Firestore surface, asserting the environment-
 * independent facts the capture recorded (error codes, fire counts, query
 * membership + ordering, shapes, booleans, null-ness). The JSON's values are
 * the EXPECTED side wherever sensible — if a capture is re-run against prod
 * and a value changes, the test fails and surfaces the drift. Prod-specific
 * noise (real auto-ids, wall-clock timestamps, project-path strings embedded
 * in messages, run-id path segments) is not asserted.
 *
 * Where the sandbox CONTRADICTS a recorded observation, BOTH sides are pinned
 * the way the auth suite's row-31 KNOWN DIVERGENCE and the storage suite do:
 * the prod value from the JSON, and the sandbox's actual current behavior,
 * with a comment naming the divergence — never weakened to pass, never a src/
 * change to make it pass.
 *
 * Every firestore observation in the directory must be either asserted here
 * or explicitly listed in NOT_APPLICABLE with a reason — the completeness
 * test at the bottom enforces that, so a new capture can't silently go
 * un-checked.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { FirebaseError } from '../../src/app/index.js';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  or,
  and,
  startAt,
  startAfter,
  endAt,
  endBefore,
  limitToLast,
  onSnapshot,
  runTransaction,
  writeBatch,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
  getCountFromServer,
  queryEqual,
  snapshotEqual,
  Timestamp,
  Bytes,
  GeoPoint,
  type Firestore,
  type DocumentSnapshot,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

// firestore-* observations live under the 'firestore' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'firestore');

/** Observations that cannot be replayed against the sandbox, with the reason. */
const NOT_APPLICABLE: Record<string, string> = {
  'firestore-bare-getfirestore-no-default-app.json':
    "exercises the prod fallthrough (getFirestore() with no argument and no default Firebase App) — the app/no-app FirebaseError is a firebase-app concern of the prod path, not modeled by the sandbox target (which always takes an explicit Sandbox/ctx). Mirrors the auth suite's NOT_APPLICABLE for auth-bare-getauth-no-default-app.",
};

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, name), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

/** Drain the microtask queue a few times so listener fan-out settles. The
 *  sandbox delivers the initial snapshot synchronously and write-driven
 *  fires by the time the write promise resolves; this is defensive so the
 *  tests stay deterministic regardless of that timing. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** pyric_oracle/* is writable (prod's oracle namespace); everything else is
 *  denied — matches the prod project's rules, so a write/read/delete OUTSIDE
 *  pyric_oracle/* surfaces permission-denied just as the captures recorded. */
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pyric_oracle/{id} { allow read, write: if true; }
    match /{document=**} { allow read, write: if false; }
  }
}`;

/** Permissive rules — used where the fact under test is data behavior
 *  (round-trips, sentinels, cursors, composites, aggregates), not rules. */
const PERMISSIVE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

const sandboxByDb = new WeakMap<Firestore, Sandbox>();

function freshDb(rules: string = PERMISSIVE): Firestore {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, rules);
  sandboxByDb.set(db, sandbox);
  return db;
}

function seedDb(
  db: Firestore,
  documents: Record<string, Record<string, unknown>>,
): void {
  const sandbox = sandboxByDb.get(db);
  if (!sandbox) throw new Error('freshDb() did not register its Sandbox');
  seedDocuments(sandbox, documents);
}

/** Run `fn`, return the thrown error, fail if nothing threw. */
async function caught(fn: () => Promise<unknown>): Promise<{ code?: unknown; name?: string; message?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: unknown; name?: string; message?: string };
  }
  throw new Error('expected the operation to throw, but it resolved');
}

/** No-regex alphanumeric check (constraint: no regex beyond char-class). */
function isAlnum(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!ok) return false;
  }
  return true;
}

const idsOf = (snap: QuerySnapshot): string[] =>
  snap.docs.map((d) => (d as unknown as { ref: { id: string } }).ref.id);

describe('oracle conformance (firestore)', () => {
  // ── auto-id format ───────────────────────────────────────────────────

  it('firestore-adddoc-autoid-format', async () => {
    const obs = load('firestore-adddoc-autoid-format.json');
    const db = freshDb();
    // Prod mints 20-char alphanumeric auto-ids. The per-sample charset
    // facts (hasUpper/hasLower/hasDigit) are sample-specific noise — a
    // single random id may lack a class — so we assert only the
    // environment-independent invariants: length 20 and all-alphanumeric,
    // over several fresh ids.
    for (let i = 0; i < 25; i++) {
      const ref = await addDoc(collection(db, 'auto'), { i });
      expect(ref.id.length).toBe(obs.length as number);
      expect(isAlnum(ref.id)).toBe(obs.isAllAlphanumeric as boolean);
    }
  });

  // ── composite filters ────────────────────────────────────────────────

  it('firestore-and-composite', async () => {
    const obs = load('firestore-and-composite.json');
    const db = freshDb();
    seedDb(db, {
      'c/match-both': { x: 1, y: 2 },
      'c/match-x': { x: 1, y: 9 },
      'c/match-y': { x: 9, y: 2 },
      'c/match-none': { x: 0, y: 0 },
    });
    const snap = (await getDocs(
      query(collection(db, 'c'), and(where('x', '==', 1), where('y', '==', 2))),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap).sort()).toEqual((obs.matchedIds as string[]).slice().sort());
  });

  it('firestore-or-composite', async () => {
    const obs = load('firestore-or-composite.json');
    const db = freshDb();
    seedDb(db, {
      'c/match-both': { x: 1, y: 2 },
      'c/match-x': { x: 1, y: 9 },
      'c/match-y': { x: 9, y: 2 },
      'c/match-none': { x: 0, y: 0 },
    });
    const snap = (await getDocs(
      query(collection(db, 'c'), or(where('x', '==', 1), where('y', '==', 2))),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap).sort()).toEqual((obs.matchedIds as string[]).slice().sort());
  });

  it('firestore-nested-or-and-composite', async () => {
    const obs = load('firestore-nested-or-and-composite.json');
    const db = freshDb();
    // or(and(x==1, y==2), z==3) — union of "x==1 AND y==2" with "z==3".
    seedDb(db, {
      'c/both-branches': { x: 1, y: 2, z: 3 },
      'c/inner-and-match': { x: 1, y: 2, z: 0 },
      'c/outer-z-match': { x: 0, y: 0, z: 3 },
      'c/x-only': { x: 1, y: 9, z: 0 },
      'c/y-only': { x: 9, y: 2, z: 0 },
      'c/none': { x: 0, y: 0, z: 0 },
    });
    const snap = (await getDocs(
      query(
        collection(db, 'c'),
        or(and(where('x', '==', 1), where('y', '==', 2)), where('z', '==', 3)),
      ),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap).sort()).toEqual((obs.matchedIds as string[]).slice().sort());
  });

  // ── cursors ──────────────────────────────────────────────────────────

  function seedPositions(db: Firestore): void {
    seedDb(db, {
      'pos/pos-1': { pos: 1 },
      'pos/pos-2': { pos: 2 },
      'pos/pos-3': { pos: 3 },
      'pos/pos-4': { pos: 4 },
      'pos/pos-5': { pos: 5 },
    });
  }

  it('firestore-cursor-startat-inclusive', async () => {
    const obs = load('firestore-cursor-startat-inclusive.json');
    const db = freshDb();
    seedPositions(db);
    const snap = (await getDocs(
      query(collection(db, 'pos'), orderBy('pos'), startAt(3)),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap)).toEqual(obs.matchedIds as string[]);
  });

  it('firestore-cursor-startafter-exclusive', async () => {
    const obs = load('firestore-cursor-startafter-exclusive.json');
    const db = freshDb();
    seedPositions(db);
    const snap = (await getDocs(
      query(collection(db, 'pos'), orderBy('pos'), startAfter(3)),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap)).toEqual(obs.matchedIds as string[]);
  });

  it('firestore-cursor-endat-inclusive', async () => {
    const obs = load('firestore-cursor-endat-inclusive.json');
    const db = freshDb();
    seedPositions(db);
    const snap = (await getDocs(
      query(collection(db, 'pos'), orderBy('pos'), endAt(3)),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap)).toEqual(obs.matchedIds as string[]);
  });

  it('firestore-cursor-endbefore-exclusive', async () => {
    const obs = load('firestore-cursor-endbefore-exclusive.json');
    const db = freshDb();
    seedPositions(db);
    const snap = (await getDocs(
      query(collection(db, 'pos'), orderBy('pos'), endBefore(3)),
    )) as QuerySnapshot;
    expect(snap.size).toBe(obs.matched as number);
    expect(idsOf(snap)).toEqual(obs.matchedIds as string[]);
  });

  it('firestore-startat-snapshot-implicit-name', async () => {
    const obs = load('firestore-startat-snapshot-implicit-name.json');
    const db = freshDb();
    // Three equal-valued docs; startAt(snapshot of "b") uses the implicit
    // __name__ tiebreak so "a" (the equal-valued predecessor) is excluded.
    seedDb(db, {
      'c/a': { pos: 1 },
      'c/b': { pos: 1 },
      'c/c': { pos: 1 },
    });
    const anchor = (await getDoc(doc(db, 'c/b'))) as DocumentSnapshot;
    const snap = (await getDocs(
      query(collection(db, 'c'), orderBy('pos'), startAt(anchor)),
    )) as QuerySnapshot;
    expect(idsOf(snap)).toEqual(obs.idsFromB as string[]);
    const excluded = !idsOf(snap).includes('a');
    expect(excluded).toBe(obs.excludedEqualValuedPredecessor as boolean);
  });

  it('firestore#61 limitToLast without orderBy uses the production error code', async () => {
    const obs = load('firestore-limittolast-preconditions.json');
    expect(obs.noOrderByThrew).toBe(true);

    const db = freshDb();
    seedDb(db, { 'c/a': { pos: 1 }, 'c/b': { pos: 2 } });
    const e = await caught(() => getDocs(query(collection(db, 'c'), limitToLast(2))));
    expect(e.code).toBe(obs.code as string);

    // With an orderBy, limitToLast returns the trailing window — matches prod.
    const trailing = (await getDocs(
      query(collection(db, 'c'), orderBy('pos'), limitToLast(1)),
    )) as QuerySnapshot;
    expect(idsOf(trailing)).toEqual(obs.trailingIds as string[]);
  });

  // ── aggregates ───────────────────────────────────────────────────────

  it('firestore-count-aggregate-shape', async () => {
    const obs = load('firestore-count-aggregate-shape.json');
    const db = freshDb();
    // Empty collection first.
    const emptySnap = await getCountFromServer(collection(db, 'empty'));
    expect(emptySnap.data().count).toBe(obs.emptyCount as number);
    expect(typeof emptySnap.data().count).toBe(obs.emptyCountType as string);
    expect(Object.keys(emptySnap.data())).toEqual(obs.emptyDataKeys as string[]);

    // Non-empty: 3 docs, 2 matching the filter.
    seedDb(db, {
      'c/a': { status: 'open' },
      'c/b': { status: 'open' },
      'c/c': { status: 'closed' },
    });
    const fullSnap = await getCountFromServer(collection(db, 'c'));
    expect(fullSnap.data().count).toBe(obs.fullCount as number);
    expect(typeof fullSnap.data().count).toBe(obs.fullCountType as string);
    const filteredSnap = await getCountFromServer(
      query(collection(db, 'c'), where('status', '==', 'open')),
    );
    expect(filteredSnap.data().count).toBe(obs.filteredCount as number);
  });

  // ── field transforms / sentinels ─────────────────────────────────────

  it('firestore-row-100-increment-bumps-numeric', async () => {
    const obs = load('firestore-row-100-increment-bumps-numeric.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/i'), { other: 'x' });
    const before = await getDoc(doc(db, 'c/i'));
    expect('count' in (before.data() as object)).toBe(!(obs.countMissingInitially as boolean));

    await updateDoc(doc(db, 'c/i'), { count: increment(5) });
    expect((await getDoc(doc(db, 'c/i'))).data()?.count).toBe(obs.afterFirst as number);
    await updateDoc(doc(db, 'c/i'), { count: increment(3) });
    expect((await getDoc(doc(db, 'c/i'))).data()?.count).toBe(obs.afterSecond as number);
    await updateDoc(doc(db, 'c/i'), { count: increment(-2) });
    expect((await getDoc(doc(db, 'c/i'))).data()?.count).toBe(obs.afterThird as number);
  });

  it('firestore-row-101-arrayunion-dedupes', async () => {
    const obs = load('firestore-row-101-arrayunion-dedupes.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { tags: ['a', 'b'] });
    await updateDoc(doc(db, 'c/a'), { tags: arrayUnion('b', 'c') });
    expect((await getDoc(doc(db, 'c/a'))).data()?.tags).toEqual(obs.afterDedupAcrossExisting as string[]);
    await updateDoc(doc(db, 'c/a'), { tags: arrayUnion('d', 'd') });
    expect((await getDoc(doc(db, 'c/a'))).data()?.tags).toEqual(obs.afterDedupInlineArgs as string[]);
    await updateDoc(doc(db, 'c/a'), { tags: arrayRemove('b') });
    expect((await getDoc(doc(db, 'c/a'))).data()?.tags).toEqual(obs.afterArrayRemove as string[]);
  });

  it('firestore-row-102-arrayremove-strips', async () => {
    const obs = load('firestore-row-102-arrayremove-strips.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { tags: ['a', 'b', 'c'] });
    await updateDoc(doc(db, 'c/a'), { tags: arrayRemove('b', 'd') });
    expect((await getDoc(doc(db, 'c/a'))).data()?.tags).toEqual(obs.after as string[]);
  });

  it('firestore-row-103-deletefield-removes-field', async () => {
    const obs = load('firestore-row-103-deletefield-removes-field.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { keep: 1, remove: 2 });
    const before = await getDoc(doc(db, 'c/a'));
    expect(Object.keys(before.data() as object).sort()).toEqual((obs.beforeKeys as string[]).slice().sort());
    await updateDoc(doc(db, 'c/a'), { remove: deleteField() });
    const after = await getDoc(doc(db, 'c/a'));
    expect(Object.keys(after.data() as object)).toEqual(obs.afterKeys as string[]);
    expect(after.data()?.keep).toBe(obs.keepValue as number);
    expect('remove' in (after.data() as object)).toBe(obs.removePresent as boolean);
  });

  it('firestore-row-30-sentinels-in-setdoc', async () => {
    const obs = load('firestore-row-30-sentinels-in-setdoc.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { createdAt: serverTimestamp(), count: 5, tags: ['a'] });
    const snap = await getDoc(doc(db, 'c/a'));
    const data = snap.data() as Record<string, unknown>;
    expect(snap.exists()).toBe(obs.exists as boolean);
    expect(Object.keys(data).sort()).toEqual((obs.keys as string[]).slice().sort());
    const createdAt = data.createdAt as Timestamp;
    expect(createdAt instanceof Timestamp).toBe(obs.createdAtIsTimestamp as boolean);
    expect(createdAt.constructor.name).toBe(obs.createdAtCtorName as string);
    expect(typeof createdAt.seconds === 'number').toBe(obs.createdAtHasSeconds as boolean);
    expect(typeof createdAt.nanoseconds === 'number').toBe(obs.createdAtHasNanoseconds as boolean);
    expect(data.count).toBe(obs.count as number);
    expect(typeof data.count).toBe(obs.countType as string);
    expect(data.tags).toEqual(obs.tags as string[]);
  });

  it('firestore-row-36-sentinels-in-updatedoc', async () => {
    const obs = load('firestore-row-36-sentinels-in-updatedoc.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { count: 5, tags: ['a'], oldField: 'keep-then-remove' });
    await updateDoc(doc(db, 'c/a'), {
      count: increment(3),
      tags: arrayUnion('b'),
      oldField: deleteField(),
    });
    const snap = await getDoc(doc(db, 'c/a'));
    const data = snap.data() as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual((obs.keys as string[]).slice().sort());
    expect(data.count).toBe(obs.count as number);
    expect(data.tags).toEqual(obs.tags as string[]);
    expect('oldField' in data).toBe(obs.oldFieldPresent as boolean);
  });

  it('firestore-row-99-servertimestamp-resolves-to-timestamp', async () => {
    const obs = load('firestore-row-99-servertimestamp-resolves-to-timestamp.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { at: serverTimestamp() });
    const snap = await getDoc(doc(db, 'c/a'));
    const data = snap.data() as Record<string, unknown>;
    expect(snap.exists()).toBe(obs.exists as boolean);
    expect(Object.keys(data)).toEqual(obs.keys as string[]);
    const at = data.at as Timestamp;
    expect(at instanceof Timestamp).toBe(obs.atIsTimestamp as boolean);
    expect(at.constructor.name).toBe(obs.atCtorName as string);
    expect(typeof at.seconds === 'number').toBe(obs.atHasSeconds as boolean);
    expect(typeof at.nanoseconds === 'number').toBe(obs.atHasNanoseconds as boolean);
    // NOT asserted: obs.atSeconds / obs.atNanoseconds — wall-clock noise.
  });

  it('firestore-updatedoc-dotpath-fieldpath', async () => {
    const obs = load('firestore-updatedoc-dotpath-fieldpath.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/a'), { a: { b: 1, c: 3 }, top: 1 });
    // Dot-separated string key parses as a FieldPath (nested write), not a
    // literal key — preserving the sibling `a.c`.
    await updateDoc(doc(db, 'c/a'), { 'a.b': 2 });
    const data = (await getDoc(doc(db, 'c/a'))).data() as { a: { b: number; c: number }; top: number };
    expect(data).toEqual(obs.data as typeof data);
    expect(data.a.b).toBe(obs.nestedUpdated as number);
    expect(data.a.c).toBe(obs.siblingPreserved as number);
    expect('a.b' in data).toBe(obs.literalDotKeyPresent as boolean);
  });

  // ── scalar round-trips ───────────────────────────────────────────────

  it('firestore-row-109-bytes-roundtrip', async () => {
    const obs = load('firestore-row-109-bytes-roundtrip.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/b'), { payload: Bytes.fromUint8Array(new Uint8Array([1, 2, 3, 4])) });
    const snap = await getDoc(doc(db, 'c/b'));
    const data = snap.data() as Record<string, unknown>;
    expect(snap.exists()).toBe(obs.exists as boolean);
    expect(Object.keys(data)).toEqual(obs.keys as string[]);
    const payload = data.payload as Bytes;
    expect(payload instanceof Bytes).toBe(obs.payloadIsBytes as boolean);
    expect(payload.constructor.name).toBe(obs.payloadCtorName as string);
    expect(payload.toBase64()).toBe(obs.roundTrippedBase64 as string);
    expect(payload.toBase64() === (obs.originalBase64 as string)).toBe(obs.base64Matches as boolean);
    expect(Array.from(payload.toUint8Array())).toEqual(obs.roundTrippedBytes as number[]);
  });

  it('firestore-row-110-geopoint-roundtrip', async () => {
    const obs = load('firestore-row-110-geopoint-roundtrip.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/g'), { loc: new GeoPoint(37.7749, -122.4194) });
    const snap = await getDoc(doc(db, 'c/g'));
    const data = snap.data() as Record<string, unknown>;
    expect(snap.exists()).toBe(obs.exists as boolean);
    expect(Object.keys(data)).toEqual(obs.keys as string[]);
    const loc = data.loc as GeoPoint;
    expect(loc instanceof GeoPoint).toBe(obs.locIsGeoPoint as boolean);
    expect(loc.constructor.name).toBe(obs.locCtorName as string);
    expect(loc.latitude).toBe(obs.roundTrippedLat as number);
    expect(loc.longitude).toBe(obs.roundTrippedLng as number);
  });

  // ── deletes / preconditions ──────────────────────────────────────────

  it('firestore-deletedoc-missing', async () => {
    const obs = load('firestore-deletedoc-missing.json');
    const db = freshDb();
    // No throw for a delete on a non-existent doc (prod no-ops too).
    let threw = false;
    try {
      await deleteDoc(doc(db, 'c/never'));
    } catch {
      threw = true;
    }
    expect(threw).toBe(obs.threw as boolean);
  });

  it('firestore-updatedoc-missing-error', async () => {
    const obs = load('firestore-updatedoc-missing-error.json');
    // Rules permit the write (inside pyric_oracle/*); only the missing-doc
    // precondition should fire.
    const db = freshDb(RULES);
    const e = await caught(() => updateDoc(doc(db, 'pyric_oracle/never-written'), { x: 1 }));
    expect(e.code).toBe(obs.code as string);
    // errorName divergence (see denied-error tests): prod is a FirebaseError,
    // the sandbox throws a SandboxError. The `code` is the portable fact.
  });

  // ── rules-denied error codes ─────────────────────────────────────────

  it('firestore-read-denied-error-code', async () => {
    const obs = load('firestore-read-denied-error-code.json');
    const db = freshDb(RULES);
    const e = await caught(() => getDoc(doc(db, 'blocked/x')));
    expect(e.code).toBe(obs.code as string);
    expect(e instanceof Error).toBe(obs.isErrorInstance as boolean);
  });

  it('firestore#32 rules-denied setDoc preserves the production error shape', async () => {
    const obs = load('firestore-write-denied-error-code.json');

    const db = freshDb(RULES);
    const e = await caught(() => setDoc(doc(db, 'blocked/x'), { v: 1 }));
    expect(e.code).toBe(obs.code as string);
    expect(e instanceof Error).toBe(obs.isErrorInstance as boolean);
    expect(e.name).toBe(obs.errorName as string);
    expect(e.constructor.name).toBe(obs.constructorName as string);
  });

  it('firestore#21 rules-denied modular writes throw a Firebase-shaped error', async () => {
    const obs = load('firestore-rules-denied-error.json');
    const db = freshDb(RULES);
    const e = await caught(() => setDoc(doc(db, 'blocked/y'), { v: 1 }));
    expect(e.code).toBe(obs.code as string);
    expect(e instanceof Error).toBe(obs.isErrorInstance as boolean);
    expect(e.name).toBe(obs.errorName as string);
    expect(e.constructor.name).toBe(obs.constructorName as string);
    expect(e instanceof FirebaseError).toBe(obs.isFirebaseError as boolean);
  });

  it('firestore-delete-denied-error-code', async () => {
    const obs = load('firestore-delete-denied-error-code.json');
    const db = freshDb(RULES);
    // Rule is evaluated before storage is touched — the doc need not exist.
    const e = await caught(() => deleteDoc(doc(db, 'blocked/z')));
    expect(e.code).toBe(obs.code as string);
    expect(e instanceof Error).toBe(obs.isErrorInstance as boolean);
  });

  it('firestore-transaction-rules-denied-error', async () => {
    const obs = load('firestore-transaction-rules-denied-error.json');
    const db = freshDb(RULES);
    let innerRan = 0;
    const e = await caught(() =>
      runTransaction(db, async (tx) => {
        innerRan++;
        tx.set(doc(db, 'blocked/tx'), { v: 1 });
      }),
    );
    expect(e.code).toBe(obs.code as string);
    expect(innerRan).toBe(obs.innerRan as number);
  });

  // ── batch atomicity ──────────────────────────────────────────────────

  it('firestore-row-96-batch-commit-atomic', async () => {
    const obs = load('firestore-row-96-batch-commit-atomic.json') as {
      successCase: Record<string, unknown>;
      failureCase: Record<string, unknown>;
    };
    // Success path — 3 writes to 3 docs under the permitted pyric_oracle/*.
    const db = freshDb(RULES);
    await setDoc(doc(db, 'pyric_oracle/upd'), { v: 1, label: 'before-batch' });
    await setDoc(doc(db, 'pyric_oracle/del'), { v: 9 });
    const okBatch = writeBatch(db);
    okBatch.set(doc(db, 'pyric_oracle/set'), { v: 1, label: 'from-set' });
    okBatch.update(doc(db, 'pyric_oracle/upd'), { v: 2, label: 'after-batch' });
    okBatch.delete(doc(db, 'pyric_oracle/del'));
    let okThrew = false;
    try {
      await okBatch.commit();
    } catch {
      okThrew = true;
    }
    expect(okThrew).toBe(obs.successCase.threw as boolean);
    const setSnap = await getDoc(doc(db, 'pyric_oracle/set'));
    const updSnap = await getDoc(doc(db, 'pyric_oracle/upd'));
    const delSnap = await getDoc(doc(db, 'pyric_oracle/del'));
    expect(setSnap.exists()).toBe(obs.successCase.setExists as boolean);
    expect(setSnap.data()).toEqual(obs.successCase.setData as object);
    expect(updSnap.exists()).toBe(obs.successCase.updateExists as boolean);
    expect(updSnap.data()).toEqual(obs.successCase.updateData as object);
    expect(delSnap.exists()).toBe(obs.successCase.deleteExists as boolean);

    // Failure path — one write outside pyric_oracle/* rejects the WHOLE
    // batch; the previously-set doc keeps its value, the new doc never lands.
    const db2 = freshDb(RULES);
    await setDoc(doc(db2, 'pyric_oracle/u2'), { v: 1, label: 'before-batch-2' });
    const badBatch = writeBatch(db2);
    badBatch.set(doc(db2, 'pyric_oracle/s2'), { v: 1, label: 'from-set' });
    badBatch.update(doc(db2, 'pyric_oracle/u2'), { v: 2, label: 'after' });
    badBatch.set(doc(db2, 'blocked/denied'), { v: 9 });
    const e = await caught(() => badBatch.commit());
    expect(e.code).toBe(obs.failureCase.code as string);
    const s2Snap = await getDoc(doc(db2, 'pyric_oracle/s2'));
    const u2Snap = await getDoc(doc(db2, 'pyric_oracle/u2'));
    expect(s2Snap.exists()).toBe(obs.failureCase.set2Exists as boolean);
    expect(u2Snap.exists()).toBe(obs.failureCase.updateExists as boolean);
    expect(u2Snap.data()).toEqual(obs.failureCase.updateData as object);
  });

  // ── addDoc-returned ref usability ────────────────────────────────────

  it('firestore-row-42-adddoc-returned-ref-usable', async () => {
    const obs = load('firestore-row-42-adddoc-returned-ref-usable.json');
    const db = freshDb();
    const ref = await addDoc(collection(db, 'row42'), { v: 1 });
    const got = await getDoc(ref);
    expect(got.exists()).toBe(obs.getDocExists as boolean);
    expect(got.data()?.v).toBe(obs.getDocV as number);
    await setDoc(ref, { v: 2 });
    expect((await getDoc(ref)).data()?.v).toBe(obs.afterSetDocV as number);

    const fires: Array<{ exists: boolean; v: unknown }> = [];
    const unsub = onSnapshot(ref, (snap) => {
      const s = snap as DocumentSnapshot;
      fires.push({ exists: s.exists(), v: s.data()?.v });
    });
    await settle();
    expect(fires.length).toBe(obs.onSnapshotFireCount as number);
    expect(fires[0]).toEqual(obs.firstFire as { exists: boolean; v: number });
    unsub();
  });

  // ── snapshot listeners ───────────────────────────────────────────────

  it('firestore-row-80-onsnapshot-fires-initial (CONFORMS: async initial fire)', async () => {
    // Prod: the initial doc snapshot is delivered ASYNC — not during the
    // registering call (firstFireSyncDuringRegister false). The sandbox now
    // routes the initial fire through the delivery scheduler
    // (src/firestore/sandbox/local-environment.ts), matching prod's
    // "asynchronous, never during register" contract via a microtask.
    const obs = load('firestore-row-80-onsnapshot-fires-initial.json');
    expect(obs.firstFireSyncDuringRegister).toBe(false); // prod (the contract)
    expect(obs.firstFireAt).toBe('after-timeout');

    const db = freshDb();
    await setDoc(doc(db, 'c/x'), { v: 1 });
    const fires: Array<{ exists: boolean; v: unknown }> = [];
    const unsub = onSnapshot(doc(db, 'c/x'), (snap) => {
      const s = snap as DocumentSnapshot;
      fires.push({ exists: s.exists(), v: s.data()?.v });
    });
    // Conforms: NO fire synchronously during register.
    expect(fires.length).toBe(0);
    await settle();
    expect(fires.length).toBe(obs.fireCount as number);
    const firstEvent = (obs.events as Array<{ existsResult: boolean; v: number }>)[0];
    expect(fires[0]).toEqual({ exists: firstEvent.existsResult, v: firstEvent.v });
    unsub();
  });

  it('firestore-row-81-onsnapshot-query-fires-on-write', async () => {
    const obs = load('firestore-row-81-onsnapshot-query-fires-on-write.json');
    const db = freshDb();
    const sizes: number[] = [];
    const unsub = onSnapshot(collection(db, 'q'), (snap) => {
      sizes.push((snap as QuerySnapshot).size);
    });
    await settle();
    expect(sizes.length).toBe(obs.initialFireCount as number);
    expect(sizes.at(-1)).toBe(obs.initialSize as number);

    const ref = await addDoc(collection(db, 'q'), { v: 1 });
    await settle();
    expect(sizes.length).toBe(obs.afterAddFireCount as number);
    expect(sizes.at(-1)).toBe(obs.afterAddSize as number);

    await setDoc(doc(db, 'q/known-id'), { v: 2 });
    await settle();
    expect(sizes.length).toBe(obs.afterSetFireCount as number);
    expect(sizes.at(-1)).toBe(obs.afterSetSize as number);

    await deleteDoc(ref);
    await settle();
    expect(sizes.length).toBe(obs.afterDeleteFireCount as number);
    expect(sizes.at(-1)).toBe(obs.afterDeleteSize as number);
    unsub();
  });

  it('firestore-row-82-onsnapshot-missing-initial', async () => {
    const obs = load('firestore-row-82-onsnapshot-missing-initial.json');
    const event0 = (obs.events as Array<{ hasPendingWrites: boolean; fromCache: boolean }>)[0];
    const db = freshDb();
    const snaps: DocumentSnapshot[] = [];
    const unsub = onSnapshot(doc(db, 'c/missing'), (snap) => {
      snaps.push(snap as DocumentSnapshot);
    });
    await settle();
    expect(snaps.length).toBe(obs.fireCount as number);
    expect(snaps[0]!.exists()).toBe(obs.firstExists as boolean);
    expect(snaps[0]!.data() === undefined).toBe(obs.firstDataIsUndefined as boolean);
    // The listener-delivered snapshot carries a metadata block whose booleans
    // match prod's recorded event (a missing-doc initial fire is server-
    // sourced with no pending write).
    const md = (snaps[0] as unknown as { metadata: { hasPendingWrites: boolean; fromCache: boolean } }).metadata;
    expect(md.hasPendingWrites).toBe(event0.hasPendingWrites);
    expect(md.fromCache).toBe(event0.fromCache);
    unsub();
  });

  it('firestore-row-83-unsubscribe-stops-fires', async () => {
    const obs = load('firestore-row-83-unsubscribe-stops-fires.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/x'), { v: 0 });
    const fires: number[] = [];
    const unsub = onSnapshot(doc(db, 'c/x'), (snap) => {
      fires.push((snap as DocumentSnapshot).data()?.v as number);
    });
    await settle();
    expect(fires.length).toBe(obs.afterInitialFires as number);
    await setDoc(doc(db, 'c/x'), { v: 1 });
    await settle();
    expect(fires.length).toBe(obs.afterFirstWriteFires as number);
    unsub();
    await setDoc(doc(db, 'c/x'), { v: 2 });
    await settle();
    expect(fires.length).toBe(obs.afterSecondWriteFires as number);
    expect(fires).toEqual((obs.fires as Array<{ v: number }>).map((f) => f.v));
  });

  it('firestore-row-84-observer-object-form', async () => {
    const obs = load('firestore-row-84-observer-object-form.json');
    const db = freshDb();
    await setDoc(doc(db, 'c/x'), { v: 0 });
    const fnFires: number[] = [];
    const obsFires: number[] = [];
    let errorFires = 0;
    let completeCalled = false;
    const unsubFn = onSnapshot(doc(db, 'c/x'), (snap) => {
      fnFires.push((snap as DocumentSnapshot).data()?.v as number);
    });
    const unsubObs = onSnapshot(doc(db, 'c/x'), {
      next: (snap) => obsFires.push((snap as DocumentSnapshot).data()?.v as number),
      error: () => { errorFires++; },
      complete: () => { completeCalled = true; },
    });
    await settle();
    expect(fnFires.length).toBe(obs.initialFn as number);
    expect(obsFires.length).toBe(obs.initialObs as number);
    await setDoc(doc(db, 'c/x'), { v: 1 });
    await settle();
    expect(fnFires.length).toBe(obs.afterWriteFn as number);
    expect(obsFires.length).toBe(obs.afterWriteObs as number);
    expect(fnFires).toEqual((obs.fnFires as Array<{ v: number }>).map((f) => f.v));
    expect(obsFires).toEqual((obs.obsFires as Array<{ v: number }>).map((f) => f.v));
    expect(errorFires).toBe(obs.errorFireCount as number);
    expect(completeCalled).toBe(obs.completeCalled as boolean);
    unsubFn();
    unsubObs();
  });

  it('firestore-row-89-snapshot-ref-usable', async () => {
    const obs = load('firestore-row-89-snapshot-ref-usable.json');
    const db = freshDb();
    await setDoc(doc(db, 's/tracked'), { v: 1 });

    let docSnapRef: DocumentSnapshot['ref'] | null = null;
    const unsub = onSnapshot(doc(db, 's/tracked'), (snap) => {
      if (!docSnapRef) docSnapRef = (snap as DocumentSnapshot).ref;
    });
    await settle();
    expect(docSnapRef).not.toBeNull();
    // Doc-snapshot .ref round-trips through getDoc + setDoc.
    const g = await getDoc(docSnapRef!);
    expect(g.data()?.v).toBe(obs.docRefGetV as number);
    await setDoc(docSnapRef!, { v: 2, marker: obs.docRefSetMarker as string });
    const after = await getDoc(doc(db, 's/tracked'));
    expect(after.data()?.v).toBe(obs.docRefSetV as number);
    expect(after.data()?.marker).toBe(obs.docRefSetMarker as string);
    unsub();

    // Query-snapshot docs[i].ref round-trips too.
    let queryDocRef: DocumentSnapshot['ref'] | null = null;
    const unsub2 = onSnapshot(collection(db, 's'), (snap) => {
      const docs = (snap as QuerySnapshot).docs;
      if (!queryDocRef && docs.length) queryDocRef = docs[0]!.ref;
    });
    await settle();
    expect(queryDocRef).not.toBeNull();
    const g2 = await getDoc(queryDocRef!);
    expect(g2.data()?.v).toBe(obs.queryDocRefGetV as number);
    unsub2();
  });

  it('firestore-include-metadata-changes (CONFORMS: pending-write echo + ack)', async () => {
    // Prod: includeMetadataChanges:true yields an EXTRA fire per write — the
    // pending-write local echo (hasPendingWrites:true) followed by the
    // metadata-only acknowledged snapshot (hasPendingWrites:false) — so a
    // single write produces 3 fires vs the default listener's 2. The
    // sandbox's delivery scheduler now models the echo + ack: the default
    // listener gets the echo (its last snapshot stays pending, like prod's),
    // and includeMetadataChanges listeners get the settled ack fire.
    const obs = load('firestore-include-metadata-changes.json');
    const prodMeta = obs.firesMeta as Array<{ hasPendingWrites: boolean }>;
    expect(obs.afterWriteDefault).toBe(2); // prod default
    expect(obs.afterWriteMeta).toBe(3); // prod meta: the extra ack fire
    expect(prodMeta.some((f) => f.hasPendingWrites)).toBe(true); // prod echoes a pending write

    const db = freshDb();
    const firesDefault: QuerySnapshot[] = [];
    const firesMeta: QuerySnapshot[] = [];
    const unsubD = onSnapshot(collection(db, 'imc'), (s) => firesDefault.push(s as QuerySnapshot));
    const unsubM = onSnapshot(
      collection(db, 'imc'),
      { includeMetadataChanges: true },
      (s) => firesMeta.push(s as QuerySnapshot),
    );
    await settle();
    expect(firesDefault.length).toBe(obs.initialDefault as number); // 1
    expect(firesMeta.length).toBe(obs.initialMeta as number); // 1

    await setDoc(doc(db, 'imc/a'), { v: 1 });
    await settle();
    // Default listener: 2 fires, matching prod.
    expect(firesDefault.length).toBe(obs.afterWriteDefault as number); // 2
    // Meta listener: 3 fires — echo then ack — matching prod.
    expect(firesMeta.length).toBe(obs.afterWriteMeta as number); // 3
    // The echo carries hasPendingWrites:true and the ack settles it,
    // matching prod's recorded sequence.
    const metaFlags = firesMeta.map(
      (s) => (s as unknown as { metadata: { hasPendingWrites: boolean } }).metadata.hasPendingWrites,
    );
    expect(metaFlags).toEqual(prodMeta.map((f) => f.hasPendingWrites));
    unsubD();
    unsubM();
  });

  // ── query / snapshot equality ────────────────────────────────────────

  it('firestore#116 queryEqual matches captured primitive and object constraints', async () => {
    const obs = load('firestore-queryequal-structural.json');

    const db = freshDb();
    seedDb(db, { 'c/x': { v: 1 } });
    const q1 = query(collection(db, 'c'), where('v', '==', 1));
    const q2 = query(collection(db, 'c'), where('v', '==', 1));
    const q3 = query(collection(db, 'c'), where('v', '==', 2));
    const q4 = query(collection(db, 'c'), where('v', '==', { a: 1 }));
    const q5 = query(collection(db, 'c'), where('v', '==', { a: 1 }));
    const q6 = query(collection(db, 'c'), where('v', '==', { a: 2 }));
    const structuredA = query(collection(db, 'c'), where('v', '==', ['x', { enabled: true }]));
    const structuredB = query(collection(db, 'c'), where('v', '==', ['x', { enabled: true }]));
    const timestampA = query(collection(db, 'c'), where('v', '==', Timestamp.fromMillis(1_234)));
    const timestampB = query(collection(db, 'c'), where('v', '==', Timestamp.fromMillis(1_234)));
    const bytesA = query(collection(db, 'c'), where('v', '==', Bytes.fromUint8Array(new Uint8Array([1, 2]))));
    const bytesB = query(collection(db, 'c'), where('v', '==', Bytes.fromUint8Array(new Uint8Array([1, 2]))));
    const geoA = query(collection(db, 'c'), where('v', '==', new GeoPoint(10, 20)));
    const geoB = query(collection(db, 'c'), where('v', '==', new GeoPoint(10, 20)));
    const refA = query(collection(db, 'c'), where('v', '==', doc(db, 'query-equality/ref')));
    const refB = query(collection(db, 'c'), where('v', '==', doc(db, 'query-equality/ref')));
    expect(queryEqual(q1, q2)).toBe(obs.sameQueryBuiltTwice as boolean);
    expect(queryEqual(q1, q1)).toBe(obs.identity as boolean);
    expect(queryEqual(q1, q3)).toBe(obs.differentValue as boolean);
    expect(obs.objectValueBuiltTwice).toBe(true);
    expect(queryEqual(q4, q5)).toBe(obs.objectValueBuiltTwice as boolean);
    expect(queryEqual(q4, q6)).toBe(obs.objectValueChanged as boolean);
    expect(queryEqual(structuredA, structuredB)).toBe(obs.structuredValueBuiltTwice as boolean);
    expect(queryEqual(timestampA, timestampB)).toBe(obs.timestampValueBuiltTwice as boolean);
    expect(queryEqual(bytesA, bytesB)).toBe(obs.bytesValueBuiltTwice as boolean);
    expect(queryEqual(geoA, geoB)).toBe(obs.geoPointValueBuiltTwice as boolean);
    expect(queryEqual(refA, refB)).toBe(obs.referenceValueBuiltTwice as boolean);

    const changedValues = [
      ['structuredValueChanged', structuredA,
        query(collection(db, 'c'), where('v', '==', ['x', { enabled: false }]))],
      ['timestampValueChanged', timestampA,
        query(collection(db, 'c'), where('v', '==', Timestamp.fromMillis(1_235)))],
      ['bytesValueChanged', bytesA,
        query(collection(db, 'c'), where('v', '==', Bytes.fromUint8Array(new Uint8Array([1, 3]))))],
      ['geoPointValueChanged', geoA,
        query(collection(db, 'c'), where('v', '==', new GeoPoint(10, 21)))],
      ['referenceValueChanged', refA,
        query(collection(db, 'c'), where('v', '==', doc(db, 'query-equality/other')))],
    ] as const;
    for (const [observation, left, right] of changedValues) {
      expect(queryEqual(left, right)).toBe(obs[observation] as boolean);
    }
  });

  it('firestore#117 snapshotEqual returns production identity booleans', async () => {
    // Prod snapshotEqual is identity-based for these query snapshots:
    // same-object → true, two separate fetches of the same data → false.
    const obs = load('firestore-snapshotequal-structural.json');

    const db = freshDb();
    seedDb(db, { 'c/x': { v: 1 } });
    const q = query(collection(db, 'c'), where('v', '==', 1));
    const s1 = (await getDocs(q)) as QuerySnapshot;
    const s2 = (await getDocs(q)) as QuerySnapshot;
    expect(s1.size).toBe(obs.size as number);
    expect(snapshotEqual(s1, s1)).toBe(obs.identity as boolean);
    expect(snapshotEqual(s1, s2)).toBe(obs.twoFetchesSameData as boolean);
  });

  // ── completeness: every observation is asserted or explicitly N/A ─────

  it('every firestore observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter((f) => f.startsWith('firestore-') && f.endsWith('.json'));
    expect(all.length).toBeGreaterThanOrEqual(40);
    const source = readFileSync(import.meta.path, 'utf8');
    const uncovered = all.filter(
      (f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE),
    );
    expect(uncovered).toEqual([]);
  });
});
