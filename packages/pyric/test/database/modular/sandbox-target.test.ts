/**
 * `@pyric/rtdb` modular SDK — sandbox-target Tier 1 tests.
 *
 * One claim per test; each test cites the specific oracle observation
 * (or matrix row) it's locking. The link from test → observation is
 * the conformance contract.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  child,
  get,
  set,
  update,
  remove,
  push,
  pushKey,
  serverTimestamp,
  onValue,
  connectDatabaseEmulator,
  sandbox as rtdbSandbox,
  TARGET_SYMBOL,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('getDatabase + path constructors', () => {
  it('getDatabase(ctx) returns a tagged Database handle', () => {
    const { db } = setup();
    expect(db).toBeDefined();
    expect(TARGET_SYMBOL in (db as object)).toBe(true);
  });

  it('ref(db) returns a root ref', () => {
    const { db } = setup();
    const r = ref(db);
    expect(r.key).toBeNull();
    expect(r._path).toBe('/');
  });

  it('ref(db, "users/alice") returns a path ref with key "alice"', () => {
    const { db } = setup();
    const r = ref(db, 'users/alice');
    expect(r._path).toBe('/users/alice');
    expect(r.key).toBe('alice');
  });

  it('child(ref, "sub") composes paths', () => {
    const { db } = setup();
    const r = ref(db, 'users');
    const c = child(r, 'alice/name');
    expect(c._path).toBe('/users/alice/name');
    expect(c.key).toBe('name');
  });

  it('ref.parent returns the parent ref; root.parent is null', () => {
    const { db } = setup();
    const r = ref(db, 'users/alice');
    expect(r.parent?._path).toBe('/users');
    expect(r.parent?.parent?._path).toBe('/');
    expect(r.parent?.parent?.parent).toBeNull();
  });

  it('ref.root returns the root ref', () => {
    const { db } = setup();
    const r = ref(db, 'users/alice/profile');
    expect(r.root._path).toBe('/');
  });
});

describe('set + get round-trip (oracle: rtdb-set-then-get-roundtrip)', () => {
  // Mirrors rtdb-set-then-get-roundtrip.json — the prod observation
  // captured the rules-denied error shape because the oracle project's
  // RTDB rules deny anonymous writes. The sandbox runs with default-
  // allow (no rules deployed), so we can observe the underlying
  // semantic: write a value, read it back, get the same value out.
  it('round-trips a primitive value', async () => {
    const { db } = setup();
    await set(ref(db, 'greetings/hello'), { text: 'hi' });
    const snap = await get(ref(db, 'greetings/hello'));
    expect(snap.exists()).toBe(true);
    expect(snap.val()).toEqual({ text: 'hi' });
  });

  it('round-trips nested objects', async () => {
    const { db } = setup();
    await set(ref(db, 'users/alice'), {
      profile: { name: 'Alice', age: 30 },
      tags: ['admin', 'editor'],
    });
    const snap = await get(ref(db, 'users/alice'));
    expect(snap.val()).toEqual({
      profile: { name: 'Alice', age: 30 },
      tags: ['admin', 'editor'],
    });
  });

  it('reads return null for an absent path', async () => {
    const { db } = setup();
    const snap = await get(ref(db, 'does/not/exist'));
    expect(snap.exists()).toBe(false);
    expect(snap.val()).toBeNull();
  });
});

describe('set(null) === remove (oracle: rtdb-remove-vs-set-null)', () => {
  // Mirrors rtdb-remove-vs-set-null.json: production says `set(ref, null)`
  // and `remove(ref)` produce equivalent end states (both → absent path,
  // both → `null` on subsequent read). The oracle observation was
  // blocked on rules permission against the live RTDB; the sandbox runs
  // with default-allow and locks the equivalence directly.
  it('set(ref, null) deletes the path', async () => {
    const { db } = setup();
    await set(ref(db, 'a/b'), 'value');
    await set(ref(db, 'a/b'), null);
    const snap = await get(ref(db, 'a/b'));
    expect(snap.exists()).toBe(false);
    expect(snap.val()).toBeNull();
  });

  it('remove(ref) deletes the path', async () => {
    const { db } = setup();
    await set(ref(db, 'a/b'), 'value');
    await remove(ref(db, 'a/b'));
    const snap = await get(ref(db, 'a/b'));
    expect(snap.exists()).toBe(false);
    expect(snap.val()).toBeNull();
  });

  it('remove and set(null) produce identical end-state', async () => {
    const { db: db1 } = setup();
    const { db: db2 } = setup();
    await set(ref(db1, 'x'), { a: 1, b: 2 });
    await set(ref(db2, 'x'), { a: 1, b: 2 });
    await remove(ref(db1, 'x'));
    await set(ref(db2, 'x'), null);
    expect(rtdbSandbox.snapshotState(db1)).toEqual(rtdbSandbox.snapshotState(db2));
  });

  it('removing a non-existent path is a no-op', async () => {
    const { db } = setup();
    await remove(ref(db, 'not/here'));
    // No throw, no state change.
    expect(rtdbSandbox.snapshotState(db)).toEqual({});
  });
});

describe('update — shallow merge', () => {
  it('shallow-merges top-level keys', async () => {
    const { db } = setup();
    await set(ref(db, 'users/alice'), { name: 'Alice', age: 30 });
    await update(ref(db, 'users/alice'), { age: 31, role: 'admin' });
    const snap = await get(ref(db, 'users/alice'));
    expect(snap.val()).toEqual({ name: 'Alice', age: 31, role: 'admin' });
  });

  it('null values in a shallow update delete the key', async () => {
    const { db } = setup();
    await set(ref(db, 'users/alice'), { name: 'Alice', age: 30, tmp: 'x' });
    await update(ref(db, 'users/alice'), { tmp: null });
    const snap = await get(ref(db, 'users/alice'));
    expect(snap.val()).toEqual({ name: 'Alice', age: 30 });
  });
});

describe('update — multi-path atomic (matrix row #23)', () => {
  // Matrix #23 documents the atomic fan-out claim for
  // `update(rootRef, { '/users/a/x': 1, '/posts/p/y': 2 })`. The oracle
  // observation was blocked on rules; the sandbox locks the atomicity
  // contract directly: every listed path lands together, and any rules
  // denial fails the whole batch.
  it('writes every listed path atomically', async () => {
    const { db } = setup();
    await update(ref(db, '/'), {
      '/users/alice/name': 'Alice',
      '/users/bob/name': 'Bob',
      '/posts/p1/author': 'alice',
    });
    expect((await get(ref(db, '/users/alice/name'))).val()).toBe('Alice');
    expect((await get(ref(db, '/users/bob/name'))).val()).toBe('Bob');
    expect((await get(ref(db, '/posts/p1/author'))).val()).toBe('alice');
  });

  it('rejects overlapping paths', async () => {
    const { db } = setup();
    expect(() =>
      update(ref(db, '/'), {
        '/users/alice': { name: 'A' },
        '/users/alice/name': 'B',
      }),
    ).toThrow(/descendant/);
  });

  it('rejects the entire update if rules deny any one path', async () => {
    const { sandbox, db } = setup();
    rtdbSandbox.setRules(db, {
      rules: {
        users: {
          $uid: {
            '.write': 'auth.uid == $uid',
          },
        },
      },
    });
    const aliceDb = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(aliceDb, {
      rules: {
        users: {
          $uid: {
            '.write': 'auth.uid == $uid',
          },
        },
      },
    });
    let threw = false;
    try {
      // alice can write to her own path, but bob's is denied — entire
      // update rejects, neither path lands.
      await update(ref(aliceDb, '/'), {
        '/users/alice/name': 'Alice',
        '/users/bob/name': 'Bob',
      });
    } catch (e) {
      threw = true;
      expect((e as Error & { code: string }).code).toBe('PERMISSION_DENIED');
    }
    expect(threw).toBe(true);
    // Verify atomicity via the rule-bypass admin read — neither path
    // landed. (Going through `get` would also throw because the rules
    // deny reads for the other-user path.)
    expect(rtdbSandbox.snapshotState(aliceDb)).toEqual({});
  });
});

describe('push (oracle: rtdb-push-autoid-format)', () => {
  // Mirrors rtdb-push-autoid-format.json: production push IDs are 20
  // chars, start with `-`, monotonically lex-sortable across calls in
  // quick succession. Our generator follows the published `NextPushId`
  // algorithm bit-for-bit.
  it('mints 20-char keys starting with "-"', () => {
    const { db } = setup();
    const r = push(ref(db, 'items'));
    expect(r.key).toBeDefined();
    expect(r.key!.length).toBe(20);
    expect(r.key!.startsWith('-')).toBe(true);
  });

  it('sequential push keys are lex-sortable', () => {
    const { db } = setup();
    const k1 = push(ref(db, 'items')).key!;
    const k2 = push(ref(db, 'items')).key!;
    const k3 = push(ref(db, 'items')).key!;
    expect(k1 < k2).toBe(true);
    expect(k2 < k3).toBe(true);
  });

  it('push(ref, value) writes the value at the new child path', async () => {
    const { db } = setup();
    const r = push(ref(db, 'items'), { title: 'first' });
    const snap = await get(r);
    expect(snap.val()).toEqual({ title: 'first' });
  });

  it('pushKey() mints a fresh key without writing', () => {
    const k = pushKey();
    expect(k.length).toBe(20);
    expect(k.startsWith('-')).toBe(true);
  });
});

describe('serverTimestamp (oracle: rtdb-servertimestamp-resolves)', () => {
  // Mirrors rtdb-servertimestamp-resolves.json: the wire-level sentinel
  // is `{ ".sv": "timestamp" }`; on read the field resolves to a number
  // (epoch ms), NOT the marker.
  it('resolves to a number on read-back', async () => {
    const { db } = setup();
    const before = Date.now();
    await set(ref(db, 'meta'), { createdAt: serverTimestamp() });
    const after = Date.now();
    const snap = await get(ref(db, 'meta'));
    const v = snap.val() as { createdAt: number };
    expect(typeof v.createdAt).toBe('number');
    expect(v.createdAt).toBeGreaterThanOrEqual(before);
    expect(v.createdAt).toBeLessThanOrEqual(after);
  });

  it('serverTimestamp() returns the documented { ".sv": "timestamp" } shape', () => {
    const s = serverTimestamp();
    expect(s).toEqual({ '.sv': 'timestamp' });
  });

  it('resolves sentinels nested deep inside an update payload', async () => {
    const { db } = setup();
    await update(ref(db, '/'), {
      '/users/alice/createdAt': serverTimestamp(),
    });
    const snap = await get(ref(db, '/users/alice/createdAt'));
    expect(typeof snap.val()).toBe('number');
  });
});

describe('rules-denied error shape (oracle: rtdb-rules-denied-error-code)', () => {
  // Mirrors rtdb-rules-denied-error-code.json EXACTLY:
  //   - threw: true
  //   - code: 'PERMISSION_DENIED' (uppercase snake-case)
  //   - message: 'PERMISSION_DENIED: Permission denied'
  //   - errorName: 'Error'
  //   - constructorName: 'Error' (plain Error, NOT FirebaseError)
  //   - isErrorInstance: true
  function denyAll() {
    return {
      rules: {
        '.read': 'false',
        '.write': 'false',
      },
    };
  }

  it('rules-denied set throws a plain Error with PERMISSION_DENIED code', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, denyAll());
    let caught: unknown;
    try {
      await set(ref(db, 'forbidden'), 'x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught instanceof Error).toBe(true);
    const err = caught as Error & { code: string };
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toBe('PERMISSION_DENIED: Permission denied');
    expect(err.name).toBe('Error');
    expect(err.constructor.name).toBe('Error');
  });

  it('rules-denied get throws the same plain Error shape', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, denyAll());
    let caught: unknown;
    try {
      await get(ref(db, 'forbidden'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught instanceof Error).toBe(true);
    const err = caught as Error & { code: string };
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toBe('PERMISSION_DENIED: Permission denied');
    expect(err.constructor.name).toBe('Error');
  });

  it('rules-denied remove throws the same plain Error shape', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, denyAll());
    let caught: unknown;
    try {
      await remove(ref(db, 'forbidden'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as Error & { code: string };
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.constructor.name).toBe('Error');
  });
});

describe('onValue listener (Tier 2)', () => {
  // No oracle observation for the happy path yet (blocked on RTDB
  // rules at the oracle project). The contract this test locks: the
  // listener fires once on subscribe with the current value, then
  // fires again on every subsequent write that touches the path.
  it('fires on subscribe with the current value', () => {
    const { db } = setup();
    let fires = 0;
    let lastVal: unknown = undefined;
    const off = onValue(ref(db, 'count'), (snap) => {
      fires++;
      lastVal = snap.val();
    });
    expect(fires).toBe(1);
    expect(lastVal).toBeNull();
    off();
  });

  it('fires after every write that touches the watched path', async () => {
    const { db } = setup();
    let fires = 0;
    let lastVal: unknown = undefined;
    const off = onValue(ref(db, 'count'), (snap) => {
      fires++;
      lastVal = snap.val();
    });
    // Initial fire.
    expect(fires).toBe(1);
    await set(ref(db, 'count'), 1);
    expect(fires).toBe(2);
    expect(lastVal).toBe(1);
    await set(ref(db, 'count'), 2);
    expect(fires).toBe(3);
    expect(lastVal).toBe(2);
    off();
    await set(ref(db, 'count'), 3);
    expect(fires).toBe(3); // unsubscribed
  });

  it('fires on a descendant write', async () => {
    const { db } = setup();
    let fires = 0;
    const off = onValue(ref(db, 'users'), () => { fires++; });
    expect(fires).toBe(1);
    await set(ref(db, 'users/alice'), { name: 'A' });
    expect(fires).toBe(2);
    off();
  });

  it('absent path: initial fire delivers val=null, exists=false', () => {
    const { db } = setup();
    let snapVal: unknown = undefined;
    let snapExists: boolean | undefined = undefined;
    const off = onValue(ref(db, 'missing'), (snap) => {
      snapVal = snap.val();
      snapExists = snap.exists();
    });
    expect(snapVal).toBeNull();
    expect(snapExists).toBe(false);
    off();
  });
});

describe('snapshot shape', () => {
  it('snap.key returns the ref\'s last segment; root\'s key is null', async () => {
    const { db } = setup();
    await set(ref(db, 'a/b'), 'leaf');
    const snap = await get(ref(db, 'a/b'));
    expect(snap.key).toBe('b');
    const rootSnap = await get(ref(db, '/'));
    expect(rootSnap.key).toBeNull();
  });

  it('snap.child("sub") descends into the snapshot value', async () => {
    const { db } = setup();
    await set(ref(db, 'user'), { name: 'A', age: 30 });
    const snap = await get(ref(db, 'user'));
    expect(snap.child('name').val()).toBe('A');
    expect(snap.child('missing').exists()).toBe(false);
  });

  it('snap.hasChildren / size on an object value', async () => {
    const { db } = setup();
    await set(ref(db, 'x'), { a: 1, b: 2 });
    const snap = await get(ref(db, 'x'));
    expect(snap.hasChildren()).toBe(true);
    // DB-B10: the modular SDK uses the `size` getter, NOT a
    // `numChildren()` method (oracle rtdb-modular-get-snapshot-shape.json:
    // hasSize: true, hasNumChildren: false).
    expect(snap.size).toBe(2);
    expect('numChildren' in snap).toBe(false);
  });

  it('snap.toJSON returns the raw value', async () => {
    const { db } = setup();
    await set(ref(db, 'a'), { x: 1 });
    const snap = await get(ref(db, 'a'));
    expect(snap.toJSON()).toEqual({ x: 1 });
  });
});

describe('connectDatabaseEmulator', () => {
  it('is a no-op on sandbox handles', () => {
    const { db } = setup();
    // No throw — sandbox doesn't need an emulator pointer.
    connectDatabaseEmulator(db, 'localhost', 9000);
  });
});

describe('sandbox-only operations', () => {
  it('sandbox.setData seeds the tree (rule-bypass)', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, {
      rules: { '.read': 'false', '.write': 'false' },
    });
    // setData bypasses rules — even with deny-all rules, the seed lands.
    rtdbSandbox.setData(db, {
      '/users/alice': { name: 'Alice' },
    });
    expect(rtdbSandbox.snapshotState(db)).toEqual({
      users: { alice: { name: 'Alice' } },
    });
  });

  it('sandbox.snapshotState dumps the full tree', async () => {
    const { db } = setup();
    await set(ref(db, 'a/b'), 1);
    await set(ref(db, 'a/c'), 2);
    expect(rtdbSandbox.snapshotState(db)).toEqual({ a: { b: 1, c: 2 } });
  });

  it('sandbox.setRules(db, null) clears rules — returns to default-allow', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, {
      rules: { '.write': 'false' },
    });
    let threw = false;
    try {
      await set(ref(db, 'x'), 1);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    rtdbSandbox.setRules(db, null);
    await set(ref(db, 'x'), 1);
    expect((await get(ref(db, 'x'))).val()).toBe(1);
  });
});

describe('sandbox-live target (per-op identity)', () => {
  it('reads sandbox.currentUser at op time, not at getDatabase time', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    rtdbSandbox.setRules(db, {
      rules: {
        users: {
          $uid: {
            '.write': 'auth != null && auth.uid == $uid',
            '.read': 'auth != null && auth.uid == $uid',
          },
        },
      },
    });
    // Currently anonymous — write to /users/alice denied.
    let firstThrew = false;
    try {
      await set(ref(db, 'users/alice'), { name: 'A' });
    } catch {
      firstThrew = true;
    }
    expect(firstThrew).toBe(true);
    // Set currentUser to alice; subsequent write succeeds.
    sandbox.currentUser = { uid: 'alice' };
    await set(ref(db, 'users/alice'), { name: 'A' });
    expect((await get(ref(db, 'users/alice'))).val()).toEqual({ name: 'A' });
  });
});
