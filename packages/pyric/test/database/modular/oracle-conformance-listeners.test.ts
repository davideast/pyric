/** Focused real-Firebase oracle replay: value and child listeners. */
import { describe, it, expect } from 'bun:test';
import {
  ref,
  child,
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
  query,
  orderByChild,
  limitToFirst,
} from '../../../src/database/index.js';
import {
  load,
  setup,
  snapKeys,
} from './oracle-conformance.support.js';

describe('oracle conformance (rtdb-modular): value and child listeners', () => {
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

  it('rtdb-modular-onchildmoved-with-orderby', async () => {
    // Prod capture: under `query(ref, orderByChild('priority'))`, updating
    // a child's priority so its sort position changes fires child_moved
    // exactly once (firedOnMove: 1), with NO initial replay.
    //
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
    const unsub = onChildMoved(
      query(ref(db, 'parent'), orderByChild('priority')),
      () => { moved++; },
    );
    expect(moved).toBe(0); // no initial replay (conforms)
    await set(ref(db, 'parent/k1/priority'), 10); // would reorder under an ordered query
    expect(moved).toBe(obs.firedOnMove as number);
    unsub();
  });

  it('rtdb-modular-childchanged-cofire-with-childmoved', async () => {
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
    // The sandbox replays the captured ordered-query co-fire contract for
    // both child_changed and child_moved, including the same-rank ordered
    // field update and the non-ordered-field no-move case.
    const obs = load('rtdb-modular-childchanged-cofire-with-childmoved.json');
    // Pinned production target:
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
    expect(reorderMoved).toBe(obs.reorderMoved as number);
    expect(sameRankMoved).toBe(obs.sameRankMoved as number);
  });

  it('rtdb-modular-onchildmoved-previouschildname-sequencing', async () => {
    // Prod capture (row #137): under `query(ref, orderByChild('priority'))`
    // with k1/k2/k3 (priority 1/2/3), moving k1 to END → MIDDLE → FRONT
    // fires child_moved three times, and its 2nd callback arg
    // (previousChildName — the sibling the moved child now follows)
    // sequences [k3, k2, null] (null = moved to the front). No initial
    // replay (firedOnInitial 0).
    //
    // Replay the captured movement sequence against the ordered sandbox
    // query, including each previousChildName transition.
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
    expect(moves.length).toBe(obs.totalMoves as number);
    expect(moves.map((move) => move.key)).toEqual(obs.movedKeySequence);
    expect(moves.map((move) => move.prev)).toEqual(obs.prevNameSequence);
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

});
