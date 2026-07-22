/**
 * `@pyric/rtdb` modular SDK — child-event listener tests (Tier 2).
 *
 * One claim per test; each test cites the matching oracle observation
 * under `packages/conformance/observations/rtdb-modular/rtdb-modular-onchild*.json`. The
 * link from test → observation is the conformance contract: the
 * sandbox must lock the same end-state behavior the prod observation
 * captured.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  remove,
  update,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onChildMoved,
  onValue,
  off,
  query,
  orderByChild,
  limitToLast,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('onChildAdded — initial replay (oracle: rtdb-modular-onchildadded-initial-replay)', () => {
  // Observation: seeded {k1, k2, k3} BEFORE subscribe, observed 3 initial
  // fires with `firedKeys: ['k1', 'k2', 'k3']` in insertion order.
  it('replays existing direct children on subscribe — one fire per key', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 }, k3: { v: 3 } });
    const firedKeys: string[] = [];
    const firedVals: unknown[] = [];
    const unsub = onChildAdded(ref(db, 'parent'), (snap) => {
      firedKeys.push(snap.key ?? '');
      firedVals.push(snap.val());
    });
    expect(firedKeys).toEqual(['k1', 'k2', 'k3']);
    expect(firedVals).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
    unsub();
  });

  it('replays nothing when the parent path is absent or empty', () => {
    const { db } = setup();
    let fires = 0;
    const unsub = onChildAdded(ref(db, 'empty'), () => { fires++; });
    expect(fires).toBe(0);
    unsub();
  });
});

describe('onChildAdded — post-subscribe (oracle: rtdb-modular-onchildadded-post-subscribe)', () => {
  // Observation: seeded {k1, k2}, subscribed, then `set(parent/k3, {v:3})`
  // produced 1 post-subscribe fire with `lastFire: {key: 'k3', val: {v:3}}`.
  it('fires exactly once per NEW direct child after subscribe', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 } });
    const firedAfterSubscribe: Array<{ key: string | null; val: unknown }> = [];
    const initial: string[] = [];
    const unsub = onChildAdded(ref(db, 'parent'), (snap) => {
      if (initial.length < 2) {
        initial.push(snap.key ?? '');
      } else {
        firedAfterSubscribe.push({ key: snap.key, val: snap.val() });
      }
    });
    expect(initial.length).toBe(2);
    await set(ref(db, 'parent/k3'), { v: 3 });
    expect(firedAfterSubscribe).toEqual([{ key: 'k3', val: { v: 3 } }]);
    unsub();
  });

  it('does NOT fire when an existing child changes value', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 } });
    let addedFires = 0;
    const unsub = onChildAdded(ref(db, 'parent'), () => { addedFires++; });
    expect(addedFires).toBe(1); // initial replay
    await set(ref(db, 'parent/k1'), { v: 99 });
    expect(addedFires).toBe(1); // no extra fire — that's child_changed territory
    unsub();
  });
});

describe('onChildChanged (oracle: rtdb-modular-onchildchanged-fires-on-update)', () => {
  // Observation: NO initial replay; firedOnUpdate=1 with lastFire={key:'k1', val:{v:2}}.
  it('does NOT fire on subscribe (no initial replay)', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 } });
    let fires = 0;
    const unsub = onChildChanged(ref(db, 'parent'), () => { fires++; });
    expect(fires).toBe(0);
    unsub();
  });

  it('fires once when an existing child transitions to a new value; snapshot carries NEW val', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 } });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildChanged(ref(db, 'parent'), (snap) => {
      fires.push({ key: snap.key, val: snap.val() });
    });
    await set(ref(db, 'parent/k1'), { v: 2 });
    expect(fires).toEqual([{ key: 'k1', val: { v: 2 } }]);
    unsub();
  });

  it('does NOT fire when a child is added (added is the other event)', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 } });
    let fires = 0;
    const unsub = onChildChanged(ref(db, 'parent'), () => { fires++; });
    await set(ref(db, 'parent/k2'), { v: 2 });
    expect(fires).toBe(0);
    unsub();
  });

  it('does NOT fire when a child is removed (removed is the other event)', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 } });
    let fires = 0;
    const unsub = onChildChanged(ref(db, 'parent'), () => { fires++; });
    await remove(ref(db, 'parent/k1'));
    expect(fires).toBe(0);
    unsub();
  });
});

describe('onChildRemoved (oracle: rtdb-modular-onchildremoved-fires-on-delete)', () => {
  // Observation: NO initial replay; firedOnDelete=1 with lastFire={key:'k1', val:{v:1}}.
  // The removed snapshot carries the PRIOR value (`removedSnapCarriesPriorValue: true`).
  it('does NOT fire on subscribe (no initial replay)', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 } });
    let fires = 0;
    const unsub = onChildRemoved(ref(db, 'parent'), () => { fires++; });
    expect(fires).toBe(0);
    unsub();
  });

  it('fires once when a child is deleted via remove(); snapshot carries PRIOR val', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 }, k2: { v: 2 } });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildRemoved(ref(db, 'parent'), (snap) => {
      fires.push({ key: snap.key, val: snap.val() });
    });
    await remove(ref(db, 'parent/k1'));
    expect(fires).toEqual([{ key: 'k1', val: { v: 1 } }]);
    unsub();
  });

  it('fires once when a child is deleted via set(child, null); snapshot carries PRIOR val', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 } });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildRemoved(ref(db, 'parent'), (snap) => {
      fires.push({ key: snap.key, val: snap.val() });
    });
    await set(ref(db, 'parent/k1'), null);
    expect(fires).toEqual([{ key: 'k1', val: { v: 1 } }]);
    unsub();
  });
});

describe('onChildMoved (oracle: rtdb-modular-onchildmoved-with-orderby)', () => {
  // Observation: under ordered query, firedOnMove=1. Under a plain ref
  // (no ordering), the upstream contract says it never fires.
  it('does NOT fire on a plain ref (no ordering) — never fires per RTDB docs', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { priority: 1 }, k2: { priority: 2 } });
    let fires = 0;
    const unsub = onChildMoved(ref(db, 'parent'), () => { fires++; });
    // Updates that would re-order under an ordered query do nothing here.
    await set(ref(db, 'parent/k1/priority'), 99);
    expect(fires).toBe(0);
    unsub();
  });

  it('does NOT fire on subscribe (no initial replay even under ordered queries)', () => {
    const { db } = setup();
    let fires = 0;
    const unsub = onChildMoved(ref(db, 'parent'), () => { fires++; });
    expect(fires).toBe(0);
    unsub();
  });

  // Registering `onChildMoved` on an ordered Query and its reorder fire are
  // both oracle-backed; this was formerly the pinned row #137 divergence.
  it('accepts a Query without throwing (TypeError cliff removed)', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
      k3: { priority: 3 },
    });
    // Before the fix this line threw:
    //   TypeError: @pyric/rtdb: unrecognized reference — …
    expect(() => {
      const unsub = onChildMoved(
        query(ref(db, 'parent'), orderByChild('priority')),
        () => {},
      );
      unsub();
    }).not.toThrow();
  });

  it('rtdb-modular#M75c and #137 fire once when an ordered child moves', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
      k3: { priority: 3 },
    });
    let fires = 0;
    const unsub = onChildMoved(
      query(ref(db, 'parent'), orderByChild('priority')),
      () => { fires++; },
    );
    // Bump k1 to the top of the sort — prod emits child_moved here.
    await set(ref(db, 'parent/k1/priority'), 10);
    expect(fires).toBe(1);
    unsub();
  });
});

describe('onChild* on an ordered query — window-aware add/change/remove (deep-divergence review item 2)', () => {
  // The four child registrars now accept a Query. add/change/remove are
  // computed against the ordered, windowed result: a child ENTERING the
  // window fires child_added, one LEAVING fires child_removed, an
  // in-window value change fires child_changed. (child_moved stays held.)
  it('onChildAdded(query, cb) replays the current window in order on subscribe', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 3 },
      k2: { priority: 1 },
      k3: { priority: 2 },
    });
    const firedKeys: string[] = [];
    const unsub = onChildAdded(
      query(ref(db, 'parent'), orderByChild('priority')),
      (snap) => { firedKeys.push(snap.key ?? ''); },
    );
    // Window order is by priority ascending: k2(1), k3(2), k1(3).
    expect(firedKeys).toEqual(['k2', 'k3', 'k1']);
    unsub();
  });

  it('onChildAdded(query, cb) fires when a child ENTERS a limitToLast window; the displaced child fires child_removed', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
      k3: { priority: 3 },
    });
    const q = query(ref(db, 'parent'), orderByChild('priority'), limitToLast(2));
    // Initial window (top 2 by priority): k2(2), k3(3).
    const addedKeys: string[] = [];
    const removedKeys: string[] = [];
    const unsubAdd = onChildAdded(q, (snap) => { addedKeys.push(snap.key ?? ''); });
    const unsubRemove = onChildRemoved(q, (snap) => { removedKeys.push(snap.key ?? ''); });
    expect(addedKeys).toEqual(['k2', 'k3']); // initial replay
    // Bump k1 to priority 5 — it enters the top-2 window, displacing k2.
    await set(ref(db, 'parent/k1/priority'), 5);
    expect(addedKeys).toEqual(['k2', 'k3', 'k1']); // k1 entered the window
    expect(removedKeys).toEqual(['k2']); // k2 left the window
    unsubAdd();
    unsubRemove();
  });

  it('onChildChanged(query, cb) fires only for an IN-window value change', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1, label: 'a' },
      k2: { priority: 2, label: 'b' },
      k3: { priority: 3, label: 'c' },
    });
    const q = query(ref(db, 'parent'), orderByChild('priority'), limitToLast(2));
    // Window: k2, k3.
    const changed: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildChanged(q, (snap) => {
      changed.push({ key: snap.key, val: snap.val() });
    });
    // In-window change (k3 stays in window).
    await set(ref(db, 'parent/k3/label'), 'C');
    // Out-of-window change (k1 not in the top-2 window) — no fire.
    await set(ref(db, 'parent/k1/label'), 'A');
    expect(changed).toEqual([{ key: 'k3', val: { priority: 3, label: 'C' } }]);
    unsub();
  });

  it('onChildRemoved(query, cb) fires with the PRIOR value when an in-window child is deleted', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
    });
    const fires: Array<{ key: string | null; val: unknown }> = [];
    const unsub = onChildRemoved(
      query(ref(db, 'parent'), orderByChild('priority')),
      (snap) => { fires.push({ key: snap.key, val: snap.val() }); },
    );
    await remove(ref(db, 'parent/k1'));
    expect(fires).toEqual([{ key: 'k1', val: { priority: 1 } }]);
    unsub();
  });

  it('a write OUTSIDE the window does not fire an onChildAdded(query) listener', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), {
      k1: { priority: 1 },
      k2: { priority: 2 },
      k3: { priority: 3 },
    });
    const q = query(ref(db, 'parent'), orderByChild('priority'), limitToLast(2));
    let fires = 0;
    const unsub = onChildAdded(q, () => { fires++; });
    expect(fires).toBe(2); // initial replay of k2, k3
    // Lower k1 further — it was never in the window and stays out.
    await set(ref(db, 'parent/k1/priority'), -5);
    expect(fires).toBe(2); // no new fire
    unsub();
  });
});

describe('off() variants (oracle: rtdb-modular-off-stops-child-fires)', () => {
  // Observation: `off(ref)` removed the onChildAdded listener; a new child
  // write after `off()` produced 0 additional fires.
  it('off(ref) removes ALL listeners at the ref — subsequent write fires zero', async () => {
    const { db } = setup();
    await update(ref(db, 'parent'), { k1: { v: 1 } });
    const firedKeys: string[] = [];
    onChildAdded(ref(db, 'parent'), (snap) => { firedKeys.push(snap.key ?? ''); });
    expect(firedKeys).toEqual(['k1']); // initial replay
    off(ref(db, 'parent'));
    await set(ref(db, 'parent/k2'), { v: 2 });
    expect(firedKeys).toEqual(['k1']); // no post-off fire
  });

  it('off(ref) also removes value listeners at the same path', async () => {
    const { db } = setup();
    let valueFires = 0;
    onValue(ref(db, 'parent'), () => { valueFires++; });
    expect(valueFires).toBe(1); // initial
    off(ref(db, 'parent'));
    await set(ref(db, 'parent/k1'), { v: 1 });
    expect(valueFires).toBe(1); // no post-off fire
  });

  it('off(ref, "child_added") removes only that event variety', async () => {
    const { db } = setup();
    let addedFires = 0;
    let changedFires = 0;
    onChildAdded(ref(db, 'parent'), () => { addedFires++; });
    onChildChanged(ref(db, 'parent'), () => { changedFires++; });
    await set(ref(db, 'parent/k1'), { v: 1 });
    expect(addedFires).toBe(1);
    off(ref(db, 'parent'), 'child_added');
    await set(ref(db, 'parent/k2'), { v: 2 });
    expect(addedFires).toBe(1); // off
    // child_changed listener still alive — bump k1's value.
    await set(ref(db, 'parent/k1'), { v: 99 });
    expect(changedFires).toBe(1);
  });

  it('off(ref, "value") removes only value listeners', async () => {
    const { db } = setup();
    let valueFires = 0;
    let addedFires = 0;
    onValue(ref(db, 'parent'), () => { valueFires++; });
    onChildAdded(ref(db, 'parent'), () => { addedFires++; });
    expect(valueFires).toBe(1); // initial
    off(ref(db, 'parent'), 'value');
    await set(ref(db, 'parent/k1'), { v: 1 });
    expect(valueFires).toBe(1); // off
    expect(addedFires).toBe(1); // still listening
  });

  it('off(ref, eventType, cb) removes only the matching callback', async () => {
    const { db } = setup();
    let firesA = 0;
    let firesB = 0;
    const cbA = (): void => { firesA++; };
    const cbB = (): void => { firesB++; };
    onChildAdded(ref(db, 'parent'), cbA);
    onChildAdded(ref(db, 'parent'), cbB);
    await set(ref(db, 'parent/k1'), { v: 1 });
    expect(firesA).toBe(1);
    expect(firesB).toBe(1);
    off(ref(db, 'parent'), 'child_added', cbA);
    await set(ref(db, 'parent/k2'), { v: 2 });
    expect(firesA).toBe(1); // off
    expect(firesB).toBe(2); // still listening
  });

  it('returned-unsubscribe from onChildAdded is functionally equivalent to off()', async () => {
    const { db } = setup();
    let fires = 0;
    const unsub = onChildAdded(ref(db, 'parent'), () => { fires++; });
    await set(ref(db, 'parent/k1'), { v: 1 });
    expect(fires).toBe(1);
    unsub();
    await set(ref(db, 'parent/k2'), { v: 2 });
    expect(fires).toBe(1);
    // Idempotent.
    unsub();
  });
});

describe('child events — multi-path update fanout', () => {
  // A multi-path update touching several children of the watched parent
  // fires the appropriate child events for each touched key.
  it('multi-path update fires child_added once per new direct child', async () => {
    const { db } = setup();
    const firedKeys: string[] = [];
    const unsub = onChildAdded(ref(db, 'users'), (snap) => {
      firedKeys.push(snap.key ?? '');
    });
    await update(ref(db, '/'), {
      '/users/alice': { name: 'Alice' },
      '/users/bob': { name: 'Bob' },
    });
    expect(firedKeys.sort()).toEqual(['alice', 'bob']);
    unsub();
  });
});

describe('child events — rules check at subscribe time', () => {
  // The subscribe-time rules check parallels onValue: a denied read
  // throws the plain-Error PERMISSION_DENIED shape and the listener
  // is never registered.
  it('rules-denied onChildAdded throws plain-Error PERMISSION_DENIED', () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, {
      rules: { '.read': 'false', '.write': 'false' },
    });
    let caught: unknown;
    try {
      onChildAdded(ref(db, 'forbidden'), () => {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught instanceof Error).toBe(true);
    const err = caught as Error & { code: string };
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.constructor.name).toBe('Error');
  });
});
