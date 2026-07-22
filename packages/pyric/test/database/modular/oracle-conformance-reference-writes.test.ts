/** Focused real-Firebase oracle replay: reference and write contracts. */
import { describe, it, expect } from 'bun:test';
import {
  ref,
  child,
  refFromURL,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  off,
  increment,
  query,
  orderByValue,
  startAt,
  endAt,
} from '../../../src/database/index.js';
import { sandbox as rtdbSandbox } from '../../../src/database/index.js';
import {
  load,
  setup,
  referenceStringShape,
  invocationShape,
  synchronousInvocationShape,
  snapKeys,
} from './oracle-conformance.support.js';

describe('oracle conformance (rtdb-modular): reference and write contracts', () => {
  describe('reference and write contracts', () => {
    it('rtdb-modular#100 exposes reference navigation and string shape', () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const validation = obs.referenceValidation as Record<string, unknown>;
      const { db } = setup();
      const target = ref(db, 'parent/child');
      expect(target.key).toBe((obs.nested as Record<string, unknown>).key);
      expect(typeof target.toString()).toBe('string');
      expect(target.parent).not.toBeNull();
      expect(target.root).not.toBeNull();
      expect(['.', '#', '$', '[', ']'].map((character) =>
        synchronousInvocationShape(() => ref(db, `bad${character}path`)),
      )).toEqual(validation.invalidRefPaths);
    });

    it('rtdb-modular#101 creates the root reference', () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const { db } = setup();
      const root = ref(db);
      expect(root.key).toBe((obs.root as Record<string, unknown>).key);
      expect(root.parent).toBe((obs.root as Record<string, unknown>).parent);
    });

    it('rtdb-modular#102 joins embedded child paths and validates them', () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const validation = obs.referenceValidation as Record<string, unknown>;
      const { db } = setup();
      const direct = ref(db, 'parent/a/b');
      expect(child(ref(db, 'parent'), 'a/b').toString()).toBe(direct.toString());
      expect(synchronousInvocationShape(() => child(ref(db), 'bad#path'))).toEqual(
        validation.invalidChildPath,
      );
      expect(synchronousInvocationShape(() => child(ref(db), ''))).toEqual(
        validation.emptyChildPath,
      );
    });

    it('rtdb-modular#103 navigates parent references', () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const { db } = setup();
      expect(ref(db).parent).toBeNull();
      expect(ref(db, 'parent/child').parent?.key).toBe(
        (obs.nested as Record<string, unknown>).parentKey,
      );
    });

    it('rtdb-modular#104 exposes the final segment as key', () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const { db } = setup();
      expect(ref(db).key).toBeNull();
      expect(ref(db, 'parent/child').key).toBe(
        (obs.nested as Record<string, unknown>).key,
      );
    });

    it('rtdb-modular#105 rejects forged references synchronously', async () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const expected = obs.forgedReference as Record<string, unknown>;
      const actual = await invocationShape(() => get({} as never));
      expect(actual).toEqual({ timing: expected.timing, name: expected.name });
    });

    it('rtdb-modular#M93 pins conforming equality and divergent URL serialization', () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const expected = obs.queryIdentity as Record<string, unknown>;
      const {
        referenceToJSON: productionReferenceToJSON,
        queryToJSON: productionQueryToJSON,
        ...expectedEquality
      } = expected;
      const first = setup();
      const second = setup();
      const target = ref(first.db, 'parent/child');
      const same = child(ref(first.db, 'parent'), 'child');
      const constrained = query(target, orderByValue(), startAt(1), endAt(2));
      const equivalent = query(target, endAt(2), orderByValue(), startAt(1));
      expect({
        sameReference: target.isEqual(same),
        defaultQueryEqualsReference: target.isEqual(query(target)),
        referenceEqualsDefaultQuery: query(target).isEqual(target),
        equivalentConstraintOrder: constrained.isEqual(equivalent),
        differentSpec: constrained.isEqual(query(target, orderByValue(), startAt(2))),
        differentPath: target.isEqual(ref(first.db, 'other')),
        differentApp: target.isEqual(ref(second.db, 'parent/child')),
        nullValue: target.isEqual(null),
        nonQuery: target.isEqual({} as never),
      }).toEqual(expectedEquality);

      const sandboxReferenceToJSON = referenceStringShape(target.toJSON(), 'parent/child');
      const sandboxQueryToJSON = referenceStringShape(constrained.toJSON(), 'parent/child');
      expect(productionReferenceToJSON).toEqual({
        protocol: 'https:',
        hostname: 'digame-mas-default-rtdb.firebaseio.com',
        pathMatches: true,
      });
      expect(productionQueryToJSON).toEqual(productionReferenceToJSON);
      expect(sandboxReferenceToJSON).toEqual({
        protocol: 'sandbox:',
        hostname: 'rtdb',
        pathMatches: true,
      });
      expect(sandboxQueryToJSON).toEqual(sandboxReferenceToJSON);
      expect(sandboxReferenceToJSON).not.toEqual(productionReferenceToJSON);
      expect(target.toJSON()).toBe(target.toString());
      expect(constrained.toJSON()).toBe(constrained.toString());
    });

    it('rtdb-modular#111 set resolves undefined', async () => {
      const obs = load('rtdb-modular-write-return-validation.json');
      const { db } = setup();
      const result = await set(ref(db, 'write-return'), { value: 1 });
      expect(obs.setResolution).toBeNull();
      expect(result).toBeUndefined();
    });

    it('rtdb-modular#120 rejects overlapping updates synchronously and atomically', async () => {
      const obs = load('rtdb-modular-write-return-validation.json');
      const { db } = setup();
      const target = ref(db, 'overlapping-update');
      await set(target, { seed: true });
      const actual = await invocationShape(() => update(target, { a: 1, 'a/b': 2 }));
      const expected = obs.overlapping as Record<string, unknown>;
      expect(actual.timing).toBe(expected.timing);
      expect(actual.name).toBe(expected.name);
      expect((await get(target)).val()).toEqual(obs.afterRejected);
    });

    it('rtdb-modular#174 pins URL validation and the host divergence', async () => {
      const obs = load('rtdb-modular-reference-shape-url.json');
      const validation = obs.referenceValidation as Record<string, unknown>;
      const { db } = setup();
      await set(ref(db, 'from-url/value'), { ok: true });
      expect((obs.mismatchedHost as Record<string, unknown>).timing).toBe('synchronous-throw');
      const sandboxRef = refFromURL(db, 'https://different.invalid/from-url/value');
      expect((await get(sandboxRef)).val()).toEqual({ ok: true });
      expect(synchronousInvocationShape(() =>
        refFromURL(db, 'https://different.invalid/path#bad'),
      )).toEqual(validation.fragmentUrl);
      expect(refFromURL(db, 'ftp://different.invalid/from-url/value')._path).toBe('/from-url/value');
      expect(refFromURL(db, 'https://different.invalid/from-url/value?ignored=true')._path)
        .toBe('/from-url/value');
    });
  });

  it('rtdb-modular#183 removes duplicate callback registrations one at a time', async () => {
    const obs = load('rtdb-modular-off-duplicate-registration.json');
    const { db } = setup();
    const target = ref(db, 'duplicate-listener');
    await set(target, 0);
    const values: unknown[] = [];
    const callback = (snapshot: DataSnapshot) => values.push(snapshot.val());
    onValue(target, callback);
    onValue(target, callback);
    await set(target, 1);
    off(target, 'value', callback);
    await set(target, 2);
    off(target, 'value', callback);
    await set(target, 3);
    expect(values).toEqual((obs.afterSecondOff as unknown[]));
  });

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

});
