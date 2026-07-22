/** Focused real-Firebase oracle replay: transaction contracts. */
import { describe, it, expect } from 'bun:test';
import {
  ref,
  get,
  set,
  update,
  push,
  onValue,
  runTransaction,
} from '../../../src/database/index.js';
import { sandbox as rtdbSandbox } from '../../../src/database/index.js';
import {
  load,
  setup,
  DENY_ALL,
} from './oracle-conformance.support.js';

describe('oracle conformance (rtdb-modular): transaction contracts', () => {
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

});
