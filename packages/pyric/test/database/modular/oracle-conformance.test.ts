/**
 * Oracle conformance (RTDB, `rtdb-modular-*` surface) — wires the frozen
 * `packages/conformance/observations/rtdb-modular/rtdb-modular-*.json` captures into the
 * test suite so the recorded real-Firebase-RTDB behavior is MACHINE-
 * CHECKED against the in-process modular sandbox, not just cited in
 * comments (mirrors the auth suite at
 * `test/auth/oracle-conformance.test.ts` — see that file's header for the
 * H5/H6 rationale, and the storage suite for how a capture that
 * contradicts the shim is pinned on both sides rather than weakened).
 *
 * This file covers the `rtdb-modular-*` observations; the non-modular
 * `rtdb-*` captures live in `test/database/oracle-conformance.test.ts`.
 * The completeness test at the bottom filters to `rtdb-modular-*` so the
 * two suites partition the RTDB observation set.
 *
 * Pattern: each test loads its observation and replays the scenario
 * against the sandbox modular surface (`getDatabase`, `ref`, `get`,
 * `set`, `update`, `onValue`, `onChild*`, `query`, `runTransaction`, …),
 * asserting the environment-independent facts the capture recorded (fire
 * counts, orderings, error shapes, null-ness, booleans). The JSON's
 * values are the EXPECTED side wherever sensible. Prod-specific noise
 * (real auto-ids, wall-clock `ts` fields) is NOT asserted.
 *
 * KNOWN DIVERGENCES (pinned on BOTH sides, never weakened to pass) —
 * these are the most important output; each is called out with a
 * `KNOWN DIVERGENCE` comment at its test:
 *   - rtdb-modular-orderbyvalue-numeric: prod threw `Index not defined`;
 *     the sandbox does not enforce `.indexOn` and returns the window.
 *   - rtdb-modular-onchildmoved-with-orderby: prod fired child_moved once
 *     under an ordered query; the sandbox's `onChildMoved` (plain-ref,
 *     no ordered-query overload) never fires on reorder.
 *   - rtdb-modular-childchanged-cofire-with-childmoved: under an ordered
 *     query prod co-fired child_changed AND child_moved on a reorder (and
 *     on an ordered-field value change); the sandbox fires window-aware
 *     child_changed (conforms) but ordered-query child_moved is
 *     unimplemented, so it never fires child_moved on reorder.
 *   - rtdb-modular-onchildmoved-previouschildname-sequencing: prod fired
 *     child_moved three times with previousChildName [k3, k2, null] as a
 *     child was moved end→middle→front; the sandbox never fires
 *     ordered-query child_moved (0 moves).
 *   - rtdb-modular-runtransaction-current-value-arg: prod invoked the
 *     update fn twice (speculative null, then the real value); the
 *     sandbox invokes it exactly once with the actual current value.
 *
 * REPLAYS GREEN (conformance, not divergence):
 *   - rtdb-modular-runtransaction-warm-client-speculation: even with a
 *     WARMED client cache, prod invokes the update fn exactly once with
 *     the cached value (no cold-cache speculative null-first); the sandbox
 *     already does this, so the warm-client contract conforms.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onChildMoved,
  off,
  runTransaction,
  increment,
  query,
  orderByChild,
  orderByKey,
  orderByValue,
  startAt,
  startAfter,
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
  sandbox as rtdbSandbox,
  type DataSnapshot,
} from '../../../src/database/index.js';

// rtdb-modular-* observations live under the 'rtdb-modular' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'rtdb-modular');

/** Observations that cannot be replayed against the sandbox, with the reason. */
const NOT_APPLICABLE: Record<string, string> = {
  'rtdb-modular-ondisconnect-abrupt-exit.json':
    'requires terminating the writer process; the sandbox boundary is pinned as a documented divergence in M84',
};

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, name), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

/** Matched keys in snapshot iteration order. */
function snapKeys(snap: DataSnapshot): string[] {
  const out: string[] = [];
  snap.forEach((c) => {
    if (c.key) out.push(c.key);
    return false;
  });
  return out;
}

/** Matched values in snapshot iteration order. */
function snapValues<T = unknown>(snap: DataSnapshot): T[] {
  const out: T[] = [];
  snap.forEach((c) => {
    out.push(c.val() as T);
    return false;
  });
  return out;
}

const DENY_ALL = { rules: { '.read': 'false', '.write': 'false' } };

describe('oracle conformance (rtdb-modular)', () => {
  // ── reads ────────────────────────────────────────────────────────────

  it('rtdb-modular-get-missing-path', async () => {
    const obs = load('rtdb-modular-get-missing-path.json');
    const { db } = setup();
    let threw = false;
    let snap: DataSnapshot | undefined;
    try {
      snap = await get(ref(db, 'nope/missing'));
    } catch {
      threw = true;
    }
    expect(threw).toBe(obs.threw as boolean); // false — missing path is NOT an error
    expect(snap!.val()).toBe(obs.val as null); // null
    expect(snap!.exists()).toBe(obs.exists as boolean); // false
    expect(snap!.val() === null).toBe(obs.valIsNull as boolean);
  });

  it('rtdb-modular-get-snapshot-shape', async () => {
    const obs = load('rtdb-modular-get-snapshot-shape.json');
    const { db } = setup();
    await set(ref(db, 'parent'), obs.val as Record<string, number>); // {a:1,b:2,c:3}
    const snap = await get(ref(db, 'parent'));
    // Method / getter presence (modular uses the `size` getter, NOT `numChildren()`).
    expect(typeof snap.val === 'function').toBe(obs.hasVal as boolean);
    expect(typeof snap.exists === 'function').toBe(obs.hasExists as boolean);
    expect('key' in snap).toBe(obs.hasKey as boolean);
    expect('ref' in snap).toBe(obs.hasRef as boolean);
    expect(typeof snap.size === 'number').toBe(obs.hasSize as boolean);
    expect(typeof snap.hasChildren === 'function').toBe(obs.hasHasChildren as boolean);
    expect(typeof snap.hasChild === 'function').toBe(obs.hasHasChild as boolean);
    expect(typeof snap.forEach === 'function').toBe(obs.hasForEach as boolean);
    expect('numChildren' in snap).toBe(obs.hasNumChildren as boolean); // false
    // Values.
    expect(snap.size).toBe(obs.size as number); // 3
    expect(snap.hasChildren()).toBe(obs.hasChildrenResult as boolean);
    expect(snap.exists()).toBe(obs.existsResult as boolean);
    expect(snap.val()).toEqual(obs.val as Record<string, number>);
    expect(snapKeys(snap)).toEqual(obs.forEachKeys as string[]); // [a,b,c]
    expect(snap.key).toBe(obs.key as string); // 'parent'
  });

  // ── writes: set / update / remove ────────────────────────────────────

  it('rtdb-modular-set-null-equals-remove', async () => {
    const obs = load('rtdb-modular-set-null-equals-remove.json');
    const { db } = setup();
    await set(ref(db, 'x'), { keep: 1 });
    expect((await get(ref(db, 'x'))).exists()).toBe(obs.beforeExists as boolean); // true
    await set(ref(db, 'x'), null);
    const snap = await get(ref(db, 'x'));
    expect(snap.exists()).toBe(obs.afterExists as boolean); // false
    expect(snap.val()).toBe(obs.afterVal as null); // null
    expect(snap.val() === null && !snap.exists()).toBe(obs.nullRemovesPath as boolean);
  });

  it('rtdb-modular-set-replaces-not-merges', async () => {
    const obs = load('rtdb-modular-set-replaces-not-merges.json');
    const { db } = setup();
    await set(ref(db, 'doc'), { a: 1, b: 2 });
    await set(ref(db, 'doc'), { a: 1 }); // REPLACE, not merge
    const snap = await get(ref(db, 'doc'));
    expect(snap.val()).toEqual(obs.final as Record<string, number>); // {a:1}
    expect(Object.keys(snap.val() as object)).toEqual(obs.finalKeys as string[]); // [a]
    expect(!('b' in (snap.val() as object))).toBe(obs.bIsAbsent as boolean);
  });

  it('rtdb-modular-update-merges-keys', async () => {
    const obs = load('rtdb-modular-update-merges-keys.json');
    const { db } = setup();
    await set(ref(db, 'doc'), { a: 1, b: 2 });
    await update(ref(db, 'doc'), { a: 10 }); // partial merge — b preserved
    const snap = await get(ref(db, 'doc'));
    expect(snap.val()).toEqual(obs.final as Record<string, number>); // {a:10,b:2}
    const v = snap.val() as { a: number; b: number };
    expect(v.a === 10).toBe(obs.aUpdated as boolean);
    expect(v.b === 2).toBe(obs.bPreserved as boolean);
  });

  it('rtdb-modular-update-null-removes-key', async () => {
    const obs = load('rtdb-modular-update-null-removes-key.json');
    const { db } = setup();
    await set(ref(db, 'doc'), { a: 1, b: 2 });
    await update(ref(db, 'doc'), { a: null }); // null removes key a
    const snap = await get(ref(db, 'doc'));
    expect(snap.val()).toEqual(obs.final as Record<string, number>); // {b:2}
    expect(Object.keys(snap.val() as object)).toEqual(obs.finalKeys as string[]); // [b]
    expect(!('a' in (snap.val() as object))).toBe(obs.aRemoved as boolean);
    expect('b' in (snap.val() as object)).toBe(obs.bPreserved as boolean);
  });

  it('rtdb-modular-update-multipath-atomic', async () => {
    const obs = load('rtdb-modular-update-multipath-atomic.json');
    const { db } = setup();
    await update(ref(db, 'parent'), { 'a/x': 1, 'b/y': 2 }); // fan-out, both land
    const aX = (await get(ref(db, 'parent/a/x'))).val();
    const bY = (await get(ref(db, 'parent/b/y'))).val();
    expect(aX).toBe(obs.aX as number); // 1
    expect(bY).toBe(obs.bY as number); // 2
    expect(aX === 1 && bY === 2).toBe(obs.bothLanded as boolean);
  });

  it('rtdb-modular-update-multipath-rules-denial', async () => {
    const obs = load('rtdb-modular-update-multipath-rules-denial.json');
    const { db } = setup();
    // /a writable, /b denied → the WHOLE fan-out rejects (atomicity).
    rtdbSandbox.setRules(db, {
      rules: { '.read': 'true', a: { '.write': 'true' }, b: { '.write': 'false' } },
    });
    let caught: unknown;
    try {
      await update(ref(db, '/'), { 'a/x': 1, 'b/y': 2 });
    } catch (e) {
      caught = e;
    }
    expect(caught !== undefined).toBe(obs.threw as boolean); // true
    const err = caught as Error & { code: string };
    expect(err.code).toBe(obs.code as string); // 'PERMISSION_DENIED'
    expect(err.message).toBe(obs.message as string); // 'PERMISSION_DENIED: Permission denied'
    // Neither path landed — the allowed path was rolled back too.
    expect((await get(ref(db, 'a/x'))).val() !== null).toBe(
      obs.okPathWrittenDespiteDenial as boolean,
    ); // false
    expect((await get(ref(db, 'a/x'))).val() === null).toBe(obs.atomicRollback as boolean);
  });

  it('rtdb-modular-remove-idempotent', async () => {
    const obs = load('rtdb-modular-remove-idempotent.json');
    const { db } = setup();
    let threw = false;
    try {
      await remove(ref(db, 'never/here')); // remove an absent path
    } catch {
      threw = true;
    }
    expect(threw).toBe(obs.threw as boolean); // false
    expect((await get(ref(db, 'never/here'))).exists()).toBe(obs.afterExists as boolean); // false
    expect(threw === false).toBe(obs.idempotent as boolean);
  });

  // ── push ─────────────────────────────────────────────────────────────

  it('rtdb-modular-push-with-value', async () => {
    const obs = load('rtdb-modular-push-with-value.json');
    const { db } = setup();
    const r = push(ref(db, 'items'), { hello: 'world' });
    // Structural key facts (the recorded literal `pushedKey` is prod noise).
    expect(r.key!.length).toBe(obs.pushedKeyLength as number); // 20
    expect(r.key!.startsWith('-')).toBe(true);
    // The returned ref is usable for follow-up ops.
    expect((await get(r)).val()).toEqual(obs.readBackInitial as Record<string, string>); // {hello:world}
    await set(r, { hello: 'again' });
    expect((await get(r)).val()).toEqual(obs.readBackAfterSet as Record<string, string>); // {hello:again}
    await remove(r);
    expect((await get(r)).val()).toBe(obs.readBackAfterRemove as null); // null
    expect(true).toBe(obs.refIsUsableForFollowupOps as boolean);
  });

  // ── sentinels ────────────────────────────────────────────────────────

  it('rtdb-modular-increment-from-missing', async () => {
    const obs = load('rtdb-modular-increment-from-missing.json');
    const { db } = setup();
    await set(ref(db, 'counter'), increment(5)); // 0 + 5
    const afterFirst = (await get(ref(db, 'counter'))).val();
    await set(ref(db, 'counter'), increment(3)); // + 3
    const afterSecond = (await get(ref(db, 'counter'))).val();
    await set(ref(db, 'counter'), increment(-2)); // - 2
    const afterNegative = (await get(ref(db, 'counter'))).val();
    expect(afterFirst).toBe(obs.afterFirst as number); // 5
    expect(afterSecond).toBe(obs.afterSecond as number); // 8
    expect(afterNegative).toBe(obs.afterNegative as number); // 6
    expect(afterFirst === 5).toBe(obs.startsFromZero as boolean);
    expect(afterSecond === 8 && afterNegative === 6).toBe(obs.accumulates as boolean);
  });

  // ── onValue ──────────────────────────────────────────────────────────

  it('rtdb-modular-onvalue-initial-with-data', async () => {
    const obs = load('rtdb-modular-onvalue-initial-with-data.json');
    const { db } = setup();
    await set(ref(db, 'p'), { seeded: true });
    const fires: unknown[] = [];
    const unsub = onValue(ref(db, 'p'), (snap) => fires.push(snap.val()));
    expect(fires.length).toBe(obs.initialFires as number); // 1
    expect(fires[0]).toEqual((obs.firstFire as { val: unknown }).val); // {seeded:true}
    expect(fires.length === 1).toBe(obs.firedExactlyOnceOnSubscribe as boolean);
    unsub();
  });

  it('rtdb-modular-onvalue-initial-no-data', async () => {
    const obs = load('rtdb-modular-onvalue-initial-no-data.json');
    const { db } = setup();
    const fires: Array<{ val: unknown; exists: boolean }> = [];
    const unsub = onValue(ref(db, 'empty'), (snap) =>
      fires.push({ val: snap.val(), exists: snap.exists() }),
    );
    // RTDB (unlike Firestore) fires once on a nonexistent path with val=null.
    expect(fires.length).toBe(obs.initialFires as number); // 1
    expect(fires[0]!.val).toBe(obs.firstFireVal as null); // null
    expect(fires[0]!.exists).toBe(obs.firstFireExists as boolean); // false
    expect(fires.length === 1).toBe(obs.firedOnEmptyPath as boolean);
    unsub();
  });

  it('rtdb-modular-onvalue-unsubscribe', async () => {
    const obs = load('rtdb-modular-onvalue-unsubscribe.json');
    const { db } = setup();
    let fires = 0;
    const unsub = onValue(ref(db, 'v'), () => { fires++; }); // initial fire → 1
    await set(ref(db, 'v'), 1); // → 2
    expect(fires).toBe(obs.preUnsubFires as number); // 2
    unsub();
    await set(ref(db, 'v'), 2); // no fire
    await set(ref(db, 'v'), 3); // no fire
    expect(fires).toBe(obs.postUnsubFires as number); // 2
    expect(fires === 2).toBe(obs.unsubStopsFires as boolean);
  });

  it('rtdb-modular-onvalue-with-query', async () => {
    const obs = load('rtdb-modular-onvalue-with-query.json');
    const { db } = setup();
    await set(ref(db, 'list'), { a: { pos: 1 }, b: { pos: 2 }, c: { pos: 3 } });
    const fires: string[][] = [];
    const q = query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2));
    const unsub = onValue(q, (snap) => fires.push(snapKeys(snap)));
    // 1) initial fire — [a,b]
    await set(ref(db, 'list/c/extra'), 1); // OUTSIDE window — no fire
    await set(ref(db, 'list/a'), { pos: 1, label: 'A!' }); // INSIDE window changed — fire [a,b]
    await set(ref(db, 'list/z'), { pos: 0 }); // enters window, displaces b — fire [z,a]
    expect(fires.length).toBe(obs.fireCount as number); // 3
    const recordedKeys = (obs.fires as Array<{ keys: string[] }>).map((f) => f.keys);
    expect(fires).toEqual(recordedKeys); // [[a,b],[a,b],[z,a]]
    unsub();
  });

  // ── onChild* events ──────────────────────────────────────────────────

  it('rtdb-modular-onchildadded-initial-replay', async () => {
    const obs = load('rtdb-modular-onchildadded-initial-replay.json');
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 }, k3: { v: 3 } });
    const firedKeys: string[] = [];
    const unsub = onChildAdded(ref(db, 'parent'), (snap) => firedKeys.push(snap.key ?? ''));
    expect(firedKeys.length).toBe(obs.initialFires as number); // 3
    expect(firedKeys).toEqual(obs.firedKeys as string[]); // [k1,k2,k3]
    expect(firedKeys.length === 3).toBe(obs.replayedExistingChildren as boolean);
    unsub();
  });

  it('rtdb-modular-onchildadded-post-subscribe', async () => {
    const obs = load('rtdb-modular-onchildadded-post-subscribe.json');
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 } });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildAdded(ref(db, 'parent'), (snap) =>
      fires.push({ key: snap.key, val: snap.val() }),
    );
    expect(fires.length).toBe(obs.initialFires as number); // 2
    await set(ref(db, 'parent/k3'), { v: 3 });
    expect(fires.length - (obs.initialFires as number)).toBe(obs.postSubscribeFires as number); // 1
    expect(fires.map((f) => f.key)).toEqual(obs.firedKeys as string[]); // [k1,k2,k3]
    expect(fires.at(-1)).toEqual(obs.lastFire as { key: string; val: unknown }); // {key:k3,val:{v:3}}
    unsub();
  });

  it('rtdb-modular-onchildchanged-fires-on-update', async () => {
    const obs = load('rtdb-modular-onchildchanged-fires-on-update.json');
    const { db } = setup();
    await set(ref(db, 'parent/k1'), { v: 1 });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildChanged(ref(db, 'parent'), (snap) =>
      fires.push({ key: snap.key, val: snap.val() }),
    );
    expect(fires.length).toBe(obs.firedOnInitial as number); // 0 — no initial replay
    await set(ref(db, 'parent/k1'), { v: 2 });
    expect(fires.length).toBe(obs.firedOnUpdate as number); // 1
    expect(fires.at(-1)).toEqual(obs.lastFire as { key: string; val: unknown }); // {key:k1,val:{v:2}}
    expect(fires.length === 0 + (obs.firedOnUpdate as number)).toBe(obs.noInitialReplay as boolean);
    expect(fires.length === 1).toBe(obs.firesOnceOnUpdate as boolean);
    unsub();
  });

  it('rtdb-modular-onchildremoved-fires-on-delete', async () => {
    const obs = load('rtdb-modular-onchildremoved-fires-on-delete.json');
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 } });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildRemoved(ref(db, 'parent'), (snap) =>
      fires.push({ key: snap.key, val: snap.val() }),
    );
    expect(fires.length).toBe(obs.firedOnInitial as number); // 0 — no initial replay
    await remove(ref(db, 'parent/k1'));
    expect(fires.length).toBe(obs.firedOnDelete as number); // 1
    // The removed snapshot carries the PRIOR value.
    expect(fires.at(-1)).toEqual(obs.lastFire as { key: string; val: unknown }); // {key:k1,val:{v:1}}
    expect(fires.length === 1).toBe(obs.firesOnceOnDelete as boolean);
    expect((fires.at(-1)!.val as { v: number }).v === 1).toBe(
      obs.removedSnapCarriesPriorValue as boolean,
    );
    unsub();
  });

  it('rtdb-modular-onchildmoved-with-orderby (KNOWN DIVERGENCE: no ordered-query child_moved)', async () => {
    // Prod capture: under `query(ref, orderByChild('priority'))`, updating
    // a child's priority so its sort position changes fires child_moved
    // exactly once (firedOnMove: 1), with NO initial replay.
    //
    // The sandbox's `onChildMoved(ref, cb)` takes a plain DatabaseReference
    // (no ordered-query overload) and never fires on reorder — the
    // registry's `observationExceptions` documents this as the plain-ref
    // no-fire model. Pin BOTH sides so neither drifts unnoticed.
    const obs = load('rtdb-modular-onchildmoved-with-orderby.json');
    expect(obs.firedOnInitial).toBe(0); // no initial replay — conforms in both
    expect(obs.firedOnMove).toBe(1); // what prod did (the target)

    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
      k3: { priority: 3 },
    });
    let moved = 0;
    const unsub = onChildMoved(ref(db, 'parent'), () => { moved++; });
    expect(moved).toBe(0); // no initial replay (conforms)
    await set(ref(db, 'parent/k1/priority'), 10); // would reorder under an ordered query
    // Sandbox today: child_moved never fires — 0, NOT prod's 1.
    expect(moved).toBe(0);
    unsub();
  });

  it('rtdb-modular-childchanged-cofire-with-childmoved (KNOWN DIVERGENCE: no ordered-query child_moved on reorder)', async () => {
    // Prod capture (row #137): under `query(ref, orderByChild('score'))`
    // with a/b/c (scores 10/20/30), onChildChanged and onChildMoved
    // co-fire across three mutation kinds:
    //   1) value-change-that-reorders (b.score 20→40): child_changed AND
    //      child_moved BOTH fire (reorderChanged 1, reorderMoved 1).
    //   2) non-ordered sibling field (a.label): child_changed only —
    //      child_moved does NOT fire (nonOrderChanged 1, nonOrderMoved 0).
    //   3) ordered field, value change (c.score 30→35): child_changed AND
    //      child_moved BOTH fire (sameRankChanged 1, sameRankMoved 1).
    //
    // The sandbox's onChild* accept a Query and fire window-aware
    // child_changed, so child_changed CONFORMS on all three (and the last
    // changed snapshot matches). But ordered-query child_moved is
    // unimplemented — the sandbox NEVER fires child_moved on reorder. Pin
    // BOTH sides: prod's co-fire target and the sandbox's no-fire behavior.
    const obs = load('rtdb-modular-childchanged-cofire-with-childmoved.json');
    // Prod target (the values we are climbing toward):
    expect(obs.childChangedCoFiresWithChildMoved).toBe(true);
    expect(obs.reorderChanged).toBe(1);
    expect(obs.reorderMoved).toBe(1); // prod fires child_moved on the reorder
    expect(obs.nonOrderChanged).toBe(1);
    expect(obs.nonOrderMoved).toBe(0); // a non-ordered field never moves
    expect(obs.sameRankChanged).toBe(1);
    expect(obs.sameRankMoved).toBe(1); // prod fires child_moved on the ordered-field value change

    const { db } = setup();
    await update(ref(db, 'parent'), {
      a: { label: 'a0', score: 10 },
      b: { label: 'b0', score: 20 },
      c: { label: 'c0', score: 30 },
    });
    const q = query(ref(db, 'parent'), orderByChild('score'));
    let changed = 0;
    let moved = 0;
    const lastChanged: { key: string | null; val: unknown } = { key: null, val: null };
    const u1 = onChildChanged(q, (snap) => {
      changed++;
      lastChanged.key = snap.key;
      lastChanged.val = snap.val();
    });
    const u2 = onChildMoved(q, () => { moved++; });

    let bc = changed;
    let bm = moved;
    await set(ref(db, 'parent/b/score'), 40); // reorders b to the end under the ordered query
    const reorderChanged = changed - bc;
    const reorderMoved = moved - bm;
    bc = changed; bm = moved;
    await set(ref(db, 'parent/a/label'), 'A!'); // non-ordered field — pure value change
    const nonOrderChanged = changed - bc;
    const nonOrderMoved = moved - bm;
    bc = changed; bm = moved;
    await set(ref(db, 'parent/c/score'), 35); // ordered field value change
    const sameRankChanged = changed - bc;
    const sameRankMoved = moved - bm;
    u1(); u2();

    // child_changed CONFORMS on all three (window-aware), matching prod.
    expect(reorderChanged).toBe(obs.reorderChanged as number); // 1
    expect(nonOrderChanged).toBe(obs.nonOrderChanged as number); // 1
    expect(sameRankChanged).toBe(obs.sameRankChanged as number); // 1
    expect(lastChanged.key).toBe((obs.lastChanged as { key: string }).key); // 'c'
    expect(lastChanged.val).toEqual((obs.lastChanged as { val: unknown }).val); // {label:'c0',score:35}
    // The non-ordered field never moves — conforms on BOTH sides.
    expect(nonOrderMoved).toBe(obs.nonOrderMoved as number); // 0
    // KNOWN DIVERGENCE: ordered-query child_moved is unimplemented — the sandbox
    // fires 0 where prod fired 1, both on the reorder and the ordered-field change.
    expect(reorderMoved).toBe(0); // prod (target): obs.reorderMoved === 1
    expect(sameRankMoved).toBe(0); // prod (target): obs.sameRankMoved === 1
  });

  it('rtdb-modular-onchildmoved-previouschildname-sequencing (KNOWN DIVERGENCE: no ordered-query child_moved)', async () => {
    // Prod capture (row #137): under `query(ref, orderByChild('priority'))`
    // with k1/k2/k3 (priority 1/2/3), moving k1 to END → MIDDLE → FRONT
    // fires child_moved three times, and its 2nd callback arg
    // (previousChildName — the sibling the moved child now follows)
    // sequences [k3, k2, null] (null = moved to the front). No initial
    // replay (firedOnInitial 0).
    //
    // The sandbox's onChildMoved never fires on reorder under an ordered
    // query (unimplemented). Pin BOTH sides: prod's previousChildName
    // sequence target and the sandbox's current no-fire (0 moves).
    const obs = load('rtdb-modular-onchildmoved-previouschildname-sequencing.json');
    // Prod target:
    expect(obs.firedOnInitial).toBe(0); // no initial replay — conforms in both
    expect(obs.totalMoves).toBe(3);
    expect(obs.prevNameSequence).toEqual(['k3', 'k2', null]);
    expect(obs.movedKeySequence).toEqual(['k1', 'k1', 'k1']);

    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
      k3: { priority: 3 },
    });
    const q = query(ref(db, 'parent'), orderByChild('priority'));
    const moves: Array<{ key: string | null; prev: string | null }> = [];
    const unsub = onChildMoved(q, (snap, previousChildName) =>
      moves.push({ key: snap.key, prev: previousChildName }),
    );
    const firedOnInitial = moves.length;
    await set(ref(db, 'parent/k1/priority'), 10); // → END (would follow k3)
    await set(ref(db, 'parent/k1/priority'), 2.5); // → MIDDLE (would follow k2)
    await set(ref(db, 'parent/k1/priority'), 0); // → FRONT (previousChildName would be null)
    unsub();

    // No initial replay — conforms on BOTH sides.
    expect(firedOnInitial).toBe(obs.firedOnInitial as number); // 0
    // KNOWN DIVERGENCE: ordered-query child_moved is unimplemented — the sandbox
    // captures 0 moves where prod captured 3 (previousChildName [k3, k2, null]).
    expect(moves.length).toBe(0); // prod (target): obs.totalMoves === 3
  });

  it('rtdb-modular-off-stops-child-fires', async () => {
    const obs = load('rtdb-modular-off-stops-child-fires.json');
    const { db } = setup();
    const firedKeys: string[] = [];
    onChildAdded(ref(db, 'parent'), (snap) => firedKeys.push(snap.key ?? ''));
    await set(ref(db, 'parent/k1'), { v: 1 }); // fires once
    expect(firedKeys.length).toBe(obs.preOffFires as number); // 1
    off(ref(db, 'parent')); // remove ALL listeners at the ref
    await set(ref(db, 'parent/k2'), { v: 2 }); // no fire
    expect(firedKeys.length - (obs.preOffFires as number)).toBe(obs.postOffFires as number); // 0
    expect(firedKeys).toEqual(obs.firedKeys as string[]); // [k1]
    expect(firedKeys.length === 1).toBe(obs.offStopsFires as boolean);
  });

  // ── queries: ordering + windows ──────────────────────────────────────

  it('rtdb-modular-orderbychild-window', async () => {
    const obs = load('rtdb-modular-orderbychild-window.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), startAt(2), endAt(4)));
    expect(snapKeys(snap)).toEqual(obs.matchedKeys as string[]); // [b,c,d]
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual(obs.positions as number[]); // [2,3,4]
    expect((obs.matchedKeys as string[]).length === 3).toBe(obs.bothEndsInclusive as boolean);
  });

  it('rtdb-modular-orderbykey-window', async () => {
    const obs = load('rtdb-modular-orderbykey-window.json');
    const { db } = setup();
    await update(ref(db, 'letters'), { c: 3, a: 1, e: 5, b: 2, d: 4 });
    const snap = await get(query(ref(db, 'letters'), orderByKey(), startAt('b'), endAt('d')));
    const keys = snapKeys(snap);
    expect(keys).toEqual(obs.matchedKeys as string[]); // [b,c,d]
    expect(keys).toEqual([...keys].sort()); // emitted in key order
    expect(true).toBe(obs.windowInKeyOrder as boolean);
  });

  it('rtdb-modular-orderbyvalue-numeric (KNOWN DIVERGENCE: no `.indexOn` enforcement)', async () => {
    // Prod capture: `query(ref, orderByValue(), limitToFirst(3))` over
    // primitive numeric children THREW — the oracle project lacks the
    // required `.indexOn: ".value"`, so RTDB rejected the query
    // (threw: true, message: "Index not defined, add \".indexOn\"…").
    //
    // The sandbox does NOT enforce `.indexOn` (COMPAT-noted); the same
    // query resolves and returns the 3 smallest values ascending. Pin
    // BOTH sides. (This observation is one of the registry's four
    // `observationExceptions`.)
    const obs = load('rtdb-modular-orderbyvalue-numeric.json');
    expect(obs.threw).toBe(true); // what prod did — index enforcement (the target)
    expect(obs.ascendingFirstThree).toBe(false); // prod couldn't compute the window

    const { db } = setup();
    await update(ref(db, 'scores'), { alice: 30, bob: 10, carol: 50, dave: 20, eve: 40 });
    let threw = false;
    let values: number[] = [];
    let keys: string[] = [];
    try {
      const snap = await get(query(ref(db, 'scores'), orderByValue(), limitToFirst(3)));
      values = snapValues<number>(snap);
      keys = snapKeys(snap);
    } catch {
      threw = true;
    }
    // Sandbox today: no throw, returns the ascending window.
    expect(threw).toBe(false);
    expect(values).toEqual([10, 20, 30]);
    expect(keys).toEqual(['bob', 'dave', 'alice']);
  });

  it('rtdb-modular-query-orderbychild-limit', async () => {
    const obs = load('rtdb-modular-query-orderbychild-limit.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2)));
    const ordered = snapKeys(snap).map((key, i) => ({
      key,
      pos: snapValues<{ pos: number }>(snap)[i]!.pos,
    }));
    expect(ordered).toEqual(obs.orderedKeys as Array<{ key: string; pos: number }>); // [{a,1},{b,2}]
    expect(ordered.map((o) => o.pos)).toEqual(obs.positions as number[]); // [1,2]
    expect(ordered.length === 2).toBe(obs.twoResults as boolean);
    expect(true).toBe(obs.firstTwoInOrder as boolean);
  });

  it('rtdb-modular-query-startat-inclusive', async () => {
    const obs = load('rtdb-modular-query-startat-inclusive.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 }, b: { pos: 2 }, c: { pos: 3 }, d: { pos: 4 },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('pos'), startAt(2)));
    // startAt is INCLUSIVE — pos===2 is in the result.
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual(obs.matched as number[]); // [2,3,4]
    expect((obs.matched as number[]).includes(2)).toBe(obs.cursorInclusive as boolean);
  });

  it('rtdb-modular-startafter-endbefore-exclusive', async () => {
    const obs = load('rtdb-modular-startafter-endbefore-exclusive.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      a: { pos: 1 }, b: { pos: 2 }, c: { pos: 3 }, d: { pos: 4 }, e: { pos: 5 },
    });
    const snap = await get(
      query(ref(db, 'list'), orderByChild('pos'), startAfter(2), endBefore(5)),
    );
    // startAfter + endBefore drop the boundary values (2 and 5).
    expect(snapKeys(snap)).toEqual(obs.matchedKeys as string[]); // [c,d]
    expect(snapValues<{ pos: number }>(snap).map((v) => v.pos)).toEqual(obs.positions as number[]); // [3,4]
    expect(!(obs.positions as number[]).includes(2) && !(obs.positions as number[]).includes(5)).toBe(
      obs.bothExclusive as boolean,
    );
  });

  it('rtdb-modular-limittofirst-vs-limittolast', async () => {
    const obs = load('rtdb-modular-limittofirst-vs-limittolast.json');
    const { db } = setup();
    const seed = { c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 } };
    await update(ref(db, 'list'), seed);
    const first = await get(query(ref(db, 'list'), orderByChild('pos'), limitToFirst(2)));
    const last = await get(query(ref(db, 'list'), orderByChild('pos'), limitToLast(2)));
    expect(snapKeys(first)).toEqual(obs.firstKeys as string[]); // [a,b]
    expect(snapValues<{ pos: number }>(first).map((v) => v.pos)).toEqual(obs.firstPositions as number[]); // [1,2]
    expect(snapKeys(last)).toEqual(obs.lastKeys as string[]); // [d,e]
    expect(snapValues<{ pos: number }>(last).map((v) => v.pos)).toEqual(obs.lastPositions as number[]); // [4,5]
    expect(true).toBe(obs.firstTakesLowest as boolean);
    expect(true).toBe(obs.lastTakesHighest as boolean);
  });

  it('rtdb-modular-equalTo-filter', async () => {
    const obs = load('rtdb-modular-equalTo-filter.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      k1: { group: 'a' }, k2: { group: 'b' }, k3: { group: 'c' }, k4: { group: 'b' }, k5: { group: 'a' },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('group'), equalTo('b')));
    // RTDB does NOT enforce uniqueness — both 'b'-grouped children come back.
    expect(snapKeys(snap).sort()).toEqual(obs.matchedKeys as string[]); // [k2,k4]
    expect(snapValues<{ group: string }>(snap).map((v) => v.group)).toEqual(obs.groups as string[]); // [b,b]
    expect(true).toBe(obs.onlyBMatched as boolean);
  });

  it('rtdb-modular-query-equalto', async () => {
    const obs = load('rtdb-modular-query-equalto.json');
    const { db } = setup();
    await update(ref(db, 'list'), {
      k1: { group: 'red' }, k2: { group: 'blue' }, k3: { group: 'blue' }, k4: { group: 'green' },
    });
    const snap = await get(query(ref(db, 'list'), orderByChild('group'), equalTo('blue')));
    expect(snapKeys(snap).sort()).toEqual(obs.matchedKeys as string[]); // [k2,k3]
    expect(true).toBe(obs.onlyBlueMatched as boolean);
  });

  // ── runTransaction ───────────────────────────────────────────────────

  it('rtdb-modular-runtransaction-success', async () => {
    const obs = load('rtdb-modular-runtransaction-success.json');
    const { db } = setup();
    const seen: unknown[] = [];
    const result = await runTransaction<number>(ref(db, 'counter'), (current) => {
      seen.push(current);
      return (typeof current === 'number' ? current : 0) + 1;
    });
    expect(seen).toEqual(obs.seenCurrentValues as unknown[]); // [null]
    expect(result.committed).toBe(obs.committed as boolean); // true
    expect(result.snapshot.val()).toBe(obs.snapVal as number); // 1
    expect(seen[0] === null).toBe(obs.firstCurrentWasNull as boolean);
    expect(result.committed && result.snapshot.val() === 1).toBe(obs.committedNewValue as boolean);
  });

  it('rtdb-modular-runtransaction-abort-undefined', async () => {
    // Prod recorded snapVal: null (a speculative-run capture artifact —
    // the sandbox's single-run snapshot reflects the actual current
    // value, so snapVal isn't asserted here). The load-bearing facts:
    // committed=false and the server value is PRESERVED.
    const obs = load('rtdb-modular-runtransaction-abort-undefined.json');
    const { db } = setup();
    await set(ref(db, 'counter'), 100);
    const result = await runTransaction<number>(ref(db, 'counter'), () => undefined);
    expect(result.committed).toBe(obs.committed as boolean); // false
    const afterVal = (await get(ref(db, 'counter'))).val();
    expect(afterVal).toBe(obs.afterValOnServer as number); // 100 — preserved
    expect(result.committed === false && afterVal === 100).toBe(
      obs.abortedAndPreservedValue as boolean,
    );
  });

  it('rtdb-modular-runtransaction-current-value-arg (KNOWN DIVERGENCE: single vs speculative-double invocation)', async () => {
    // Prod capture: for a MISSING path the update fn's `current` arrives
    // as null (NOT undefined). For a SEEDED path prod recorded TWO
    // invocations — a speculative `null` run, then the real value — so
    // `seededArgs.length === 2`.
    //
    // The sandbox does not model speculative re-runs: it invokes the fn
    // EXACTLY ONCE with the actual current value. Pin BOTH sides.
    const obs = load('rtdb-modular-runtransaction-current-value-arg.json');

    // Missing path: current is null, object-typed, not undefined.
    const m = setup();
    const missingArgs: Array<{ raw: unknown; type: string; isNull: boolean; isUndefined: boolean }> = [];
    await runTransaction<number>(ref(m.db, 'missing'), (current) => {
      missingArgs.push({
        raw: current,
        type: typeof current,
        isNull: current === null,
        isUndefined: current === undefined,
      });
      return 1;
    });
    expect(missingArgs[0]!.isNull).toBe(obs.missingFirstWasNull as boolean); // true
    expect(missingArgs[0]!.isUndefined).toBe(obs.missingFirstWasUndefined as boolean); // false
    expect(missingArgs[0]!.type).toBe('object'); // typeof null === 'object'

    // Seeded path: single invocation with the actual object value.
    const s = setup();
    await set(ref(s.db, 'user'), { count: 7, name: 'alice' });
    const seededArgs: unknown[] = [];
    await runTransaction<{ count: number; name: string }>(ref(s.db, 'user'), (current) => {
      seededArgs.push(current);
      if (current && typeof current === 'object') return { ...current, count: current.count + 1 };
      return current ?? undefined;
    });
    // typeof the first seeded arg is 'object' in both prod and sandbox.
    expect(typeof seededArgs[0]).toBe(obs.seededFirstShape as string); // 'object'
    // Prod (the target): 2 speculative invocations.
    expect((obs.seededArgs as unknown[]).length).toBe(2);
    // Sandbox today: 1 invocation with the real value.
    expect(seededArgs.length).toBe(1);
    expect(seededArgs[0]).toEqual({ count: 7, name: 'alice' });
  });

  it('rtdb-modular-runtransaction-warm-client-speculation', async () => {
    // REPLAYS GREEN (rows #160 / M37): the sibling capture
    // `rtdb-modular-runtransaction-current-value-arg` pinned the
    // COLD-cache speculative double-invoke (null-first). This probe warms
    // the client cache first — an onValue listener has fired its initial
    // snapshot AND a direct get() has resolved — before running the
    // transaction on that same path. Prod then invokes the update fn
    // EXACTLY ONCE with the cached value (speculativeNullFirstEvenWhenWarm
    // false, singleInvocationWithCachedValue true): the cold-cache
    // double-call is an artifact, not the warm contract. The sandbox
    // already does exactly one invocation with the real current value, so
    // it CONFORMS to the warm-client contract — asserted here, not pinned
    // as a divergence. (Resolves docs/reviews/deep-divergence-review.md
    // item 4.)
    const obs = load('rtdb-modular-runtransaction-warm-client-speculation.json');
    // Prod's warm-client contract (what the sandbox must match):
    expect(obs.speculativeNullFirstEvenWhenWarm).toBe(false);
    expect(obs.singleInvocationWithCachedValue).toBe(true);
    expect(obs.invocationCount).toBe(1);
    expect(obs.firstArgWasNull).toBe(false);
    expect(obs.warmClientWasListening).toBe(true);

    const { db } = setup();
    await set(ref(db, 'p'), { count: 7, name: 'alice' });
    // WARM the client: attach a listener and consume its initial fire, plus a direct get().
    let listenerFires = 0;
    const unsub = onValue(ref(db, 'p'), () => { listenerFires++; });
    const warmClientWasListening = listenerFires >= 1; // initial fire already delivered
    await get(ref(db, 'p'));
    // Run the transaction on the warmed path, capturing every `current` arg.
    const warmArgs: Array<{
      type: string;
      isNull: boolean;
      isUndefined: boolean;
      hasSeededKeys: boolean;
    }> = [];
    await runTransaction<{ count: number; name: string }>(ref(db, 'p'), (current) => {
      warmArgs.push({
        type: typeof current,
        isNull: current === null,
        isUndefined: current === undefined,
        hasSeededKeys:
          !!current && typeof current === 'object' && 'count' in current && 'name' in current,
      });
      if (current && typeof current === 'object') return { ...current, count: current.count + 1 };
      return current ?? undefined;
    });
    unsub();

    // Sandbox CONFORMS to the warm-client contract: single invocation, cached (non-null) value.
    expect(warmClientWasListening).toBe(obs.warmClientWasListening as boolean); // true
    expect(warmArgs.length).toBe(obs.invocationCount as number); // 1
    expect(warmArgs.length === 1).toBe(obs.singleInvocationWithCachedValue as boolean);
    expect(warmArgs[0]!.isNull).toBe(obs.firstArgWasNull as boolean); // false
    expect(warmArgs[0]!.type).toBe(obs.firstArgType as string); // 'object'
    expect(warmArgs[0]!.isUndefined).toBe(
      (obs.warmArgs as Array<{ isUndefined: boolean }>)[0]!.isUndefined, // false
    );
    expect(warmArgs[0]!.hasSeededKeys).toBe(
      (obs.warmArgs as Array<{ hasSeededKeys: boolean }>)[0]!.hasSeededKeys, // true
    );
    // No cold-cache speculative null-first, exactly as the warm prod client.
    const sandboxSpeculativeNullFirst = warmArgs.some((a) => a.isNull);
    expect(sandboxSpeculativeNullFirst).toBe(obs.speculativeNullFirstEvenWhenWarm as boolean); // false
  });

  it('rtdb-modular-runtransaction-returns-committed-snapshot', async () => {
    const obs = load('rtdb-modular-runtransaction-returns-committed-snapshot.json');
    const { db } = setup();
    await set(ref(db, 'v'), { count: 41 });
    const result = await runTransaction<{ count: number }>(ref(db, 'v'), (current) => {
      if (current && typeof current === 'object') return { count: current.count + 1 };
      return { count: 1 };
    });
    expect(Object.keys(result).sort()).toEqual([...(obs.resultKeys as string[])].sort()); // [committed,snapshot]
    expect(result.committed).toBe(obs.committed as boolean); // true
    expect(typeof result.committed).toBe(obs.committedType as string); // 'boolean'
    expect('snapshot' in result).toBe(obs.hasSnapshotProp as boolean);
    expect(typeof result.snapshot.val === 'function').toBe(obs.snapshotValIsFn as boolean);
    expect(result.snapshot.val()).toEqual(obs.snapVal as { count: number }); // {count:42}
    expect(result.snapshot.exists()).toBe(obs.snapExists as boolean); // true
    expect(result.snapshot.key).toBe(obs.snapKey as string); // 'v'
    expect(result.committed && (result.snapshot.val() as { count: number }).count === 42).toBe(
      obs.committedReflectsNewValue as boolean,
    );
  });

  it('rtdb-modular-runtransaction-options-applylocally', async () => {
    const obs = load('rtdb-modular-runtransaction-options-applylocally.json');
    // Single-client harness: applyLocally true vs false produce the same
    // observable end state and fire sequence (prod's own capture matches).
    async function runBranch(applyLocally: boolean): Promise<{ committed: boolean; final: number; fires: number[] }> {
      const { db } = setup();
      await set(ref(db, 'v'), 1);
      const fires: number[] = [];
      const unsub = onValue(ref(db, 'v'), (snap) => fires.push(snap.val() as number));
      const result = await runTransaction<number>(
        ref(db, 'v'),
        (current) => (typeof current === 'number' ? current : 0) + 10,
        { applyLocally },
      );
      unsub();
      return { committed: result.committed, final: result.snapshot.val() as number, fires };
    }
    const t = await runBranch(true);
    const f = await runBranch(false);
    expect(t.committed).toBe(obs.trueCommitted as boolean); // true
    expect(f.committed).toBe(obs.falseCommitted as boolean); // true
    expect(t.final).toBe(obs.trueFinalVal as number); // 11
    expect(f.final).toBe(obs.falseFinalVal as number); // 11
    expect(t.fires.length).toBe(obs.trueFireCount as number); // 2
    expect(f.fires.length).toBe(obs.falseFireCount as number); // 2
    expect(t.fires).toEqual(obs.trueFireVals as number[]); // [1,11]
    expect(f.fires).toEqual(obs.falseFireVals as number[]); // [1,11]
    expect(t.committed && f.committed).toBe(obs.bothCommitted as boolean);
    expect(t.final === 11 && f.final === 11).toBe(obs.bothEndedAt11 as boolean);
  });

  it('rtdb-modular-runtransaction-on-rules-denied-path', async () => {
    // Distinct from set/get's PERMISSION_DENIED shape: runTransaction
    // rejections carry message 'permission_denied' (LOWERCASE), no .code,
    // and are a true rejection (committed: null), NOT a { committed:false }
    // resolve. The update fn is invoked once before the denial.
    const obs = load('rtdb-modular-runtransaction-on-rules-denied-path.json');
    const { db } = setup();
    rtdbSandbox.setRules(db, DENY_ALL);
    let caught: unknown;
    let fnCalls = 0;
    try {
      await runTransaction<number>(ref(db, 'forbidden'), (current) => {
        fnCalls++;
        return (typeof current === 'number' ? current : 0) + 1;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught !== undefined).toBe(obs.threw as boolean); // true
    expect(caught instanceof Error).toBe(obs.isErrorInstance as boolean); // true
    const err = caught as Error & { code?: string };
    expect(err.message).toBe(obs.message as string); // 'permission_denied'
    expect(err.name).toBe(obs.errorName as string); // 'Error'
    expect(err.constructor.name).toBe(obs.constructorName as string); // 'Error'
    expect(err.code).toBeUndefined(); // no .code — obs.code is null
    expect(obs.code).toBeNull();
    expect(fnCalls).toBe(obs.updateFnCallCount as number); // 1
    expect(obs.committed).toBeNull(); // true rejection, not a committed:false resolve
    expect(true).toBe(obs.rejectedNotAborted as boolean);
  });

  // ── completeness: every `rtdb-modular-*` observation is covered ────────

  it('every rtdb-modular observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter(
      (f) => f.startsWith('rtdb-modular-') && f.endsWith('.json'),
    );
    expect(all.length).toBe(44);
    const source = [
      readFileSync(import.meta.path, 'utf8'),
      readFileSync(join(import.meta.dir, '..', 'on-disconnect.test.ts'), 'utf8'),
    ].join('\n');
    const uncovered = all.filter(
      (f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE),
    );
    expect(uncovered).toEqual([]);
  });
});
