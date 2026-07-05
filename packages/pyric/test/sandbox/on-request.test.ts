/**
 * Tests for the unified `Sandbox.onEvent` channel (issue #307).
 *
 * Drives `LocalEnvironment.execute` / `batch` / `addSnapshotListener`
 * directly via `getInternalEnv()` so the test doesn't depend on the
 * data-plane adapter packages — keeps `@pyric/sandbox` self-contained.
 * The admin/firestore packages will exercise the same surface
 * end-to-end in their own integration tests.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import type {
  RequestEvent,
  Sandbox,
  SandboxEvent,
} from '../../src/sandbox/index.js';

/** Test helper — filter onEvent to request-kind only. Most tests
 *  predate the unified channel and assert RequestEvent fields. Returns
 *  the inner callback's value so async-rejection isolation is preserved
 *  end-to-end (otherwise an `async` test handler's throw would escape). */
function onRequest(
  sandbox: Sandbox,
  cb: (e: RequestEvent) => void | Promise<void>,
): () => void {
  return sandbox.onEvent((e: SandboxEvent) => {
    if (e.kind === 'request') return cb(e);
  });
}

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

function makeSandbox() {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: RULES });
  return { sandbox, env };
}

describe('Sandbox.onRequest', () => {
  it('fires once per single-op execute', () => {
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'hi' } });

    expect(events.length).toBe(1);
    expect(events[0].method).toBe('set');
    expect(events[0].path).toBe('notes/n1');
    expect(events[0].result).toBe('allow');
    expect(events[0].origin).toBe('user');
    expect(events[0].auth?.uid).toBe('alice');
    expect(events[0].evalMs).toBeGreaterThanOrEqual(0);
    expect(events[0].id).toMatch(/^req-/);
  });

  it('marks denied ops with result=deny and includes resourceBefore', () => {
    const { sandbox, env } = makeSandbox();
    // Seed a doc under alice.
    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'hi' } });

    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));
    // Bob is not authorised — rule requires auth.uid == 'alice'.
    env.execute({ method: 'get', path: 'notes/n1', auth: { uid: 'bob' } });

    expect(events.length).toBe(1);
    expect(events[0].result).toBe('deny');
    expect(events[0].resourceBefore).toEqual({ data: { body: 'hi' }, exists: true });
  });

  it('parses matchedRule from the simulator debug messages', () => {
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));
    env.execute({ method: 'get', path: 'notes/n1', auth: { uid: 'alice' } });

    expect(events[0].matchedRule).toBeDefined();
    expect(events[0].matchedRule?.ruleIndex).toBe(0);
    expect(events[0].matchedRule?.operations).toContain('read');
  });

  it('pins the simulator debug-message format that matchedRule parsing depends on', () => {
    // Cross-package contract: @pyric/firestore-rules's simulator
    // emits "Rule #N (op1,op2) → ALLOW/deny/unsupported: ..." and
    // @pyric/sandbox's parseMatchedRule regex consumes it. If the
    // simulator changes the format silently (different arrow,
    // different capitalisation, parentheses gone) matchedRule becomes
    // undefined for every event — no test would notice unless we pin
    // the raw `reasons` strings here. Update both sides together if
    // this fails.
    const { sandbox, env } = makeSandbox();

    // 1. allow path
    const allowEvents: RequestEvent[] = [];
    const unsubAllow = onRequest(sandbox, (e) => allowEvents.push(e));
    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'a' } });
    unsubAllow();
    const allowReason = allowEvents[0].reasons.find((r) => /^Rule #\d+ \([^)]+\) → ALLOW$/.test(r));
    expect(allowReason).toBeDefined();

    // 2. deny path — bob is not authorised
    const denyEvents: RequestEvent[] = [];
    onRequest(sandbox, (e) => denyEvents.push(e));
    env.execute({ method: 'get', path: 'notes/n1', auth: { uid: 'bob' } });
    const denyReason = denyEvents[0].reasons.find((r) => /^Rule #\d+ \([^)]+\) → deny$/.test(r));
    expect(denyReason).toBeDefined();
  });

  it('emits one event per sub-op in a batch with shared groupId', () => {
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    env.batch(
      [
        { method: 'create', path: 'notes/n1', data: { body: 'a' } },
        { method: 'create', path: 'notes/n2', data: { body: 'b' } },
        { method: 'create', path: 'notes/n3', data: { body: 'c' } },
      ],
      { uid: 'alice' },
    );

    expect(events.length).toBe(3);
    for (const e of events) {
      expect(e.origin).toBe('batch');
      expect(e.groupId).toBeDefined();
    }
    const groupIds = new Set(events.map((e) => e.groupId));
    expect(groupIds.size).toBe(1);
  });

  it('emits one event per write in a transaction with shared groupId', () => {
    // Pre-existing bug: `transaction()` writes appended to EventLog but
    // never fired emitRequest. Fixed alongside the unified-channel work
    // — see design rationale §"Bugs to
    // fix BEFORE wiring onEvent".
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    env.transaction(
      (tx) => {
        tx.set('notes/n1', { body: 'a' });
        tx.set('notes/n2', { body: 'b' });
      },
      { auth: { uid: 'alice' } },
    );

    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.origin).toBe('transaction');
      expect(e.groupId).toBeDefined();
      expect(e.groupId).toMatch(/^tx-/);
      expect(e.result).toBe('allow');
    }
    const groupIds = new Set(events.map((e) => e.groupId));
    expect(groupIds.size).toBe(1);
  });

  it('emits transaction writes as deny when rules reject them', () => {
    // Bob fails the `request.auth.uid == "alice"` rule; the tx rolls
    // back atomically but each rejected write should still surface a
    // RequestEvent with result=deny so consumers see what failed.
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    env.transaction(
      (tx) => {
        tx.set('notes/n1', { body: 'a' });
      },
      { auth: { uid: 'bob' } },
    );

    expect(events.length).toBe(1);
    expect(events[0].origin).toBe('transaction');
    expect(events[0].result).toBe('deny');
    expect(events[0].groupId).toBeDefined();
  });

  it('emits listener events with origin=listener', () => {
    const { sandbox, env } = makeSandbox();
    const auth = { uid: 'alice' };
    env.addSnapshotListener(
      { kind: 'doc', path: 'notes/n1' },
      () => {},
      {},
      auth,
    );

    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));
    env.execute({ method: 'set', path: 'notes/n1', auth, data: { body: 'hi' } });

    const listenerEvents = events.filter((e) => e.origin === 'listener');
    expect(listenerEvents.length).toBeGreaterThanOrEqual(1);
    expect(listenerEvents[0].triggeredBy).toEqual({ method: 'set', path: 'notes/n1' });
  });

  it('suppresses inner per-doc emits during a query listener fire', () => {
    const { sandbox, env } = makeSandbox();
    const auth = { uid: 'alice' };
    // Pre-seed several docs so the inner list-filter has work to do.
    for (let i = 0; i < 5; i++) {
      env.execute({ method: 'set', path: `notes/n${i}`, auth, data: { body: `${i}` } });
    }
    env.addSnapshotListener(
      { kind: 'query', collection: 'notes' },
      () => {},
      {},
      auth,
    );

    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));
    env.execute({ method: 'set', path: 'notes/new', auth, data: { body: 'fresh' } });

    // Expect: 1 user write + 1 query listener re-eval (NOT 1 + N).
    const listenerEvents = events.filter((e) => e.origin === 'listener');
    expect(listenerEvents.length).toBe(1);
    expect(listenerEvents[0].method).toBe('list');
    expect(listenerEvents[0].path).toBe('notes');
  });

  it('unsubscribe stops further events', () => {
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    const unsub = onRequest(sandbox, (e) => events.push(e));
    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'a' } });
    expect(events.length).toBe(1);
    unsub();
    env.execute({ method: 'set', path: 'notes/n2', auth: { uid: 'alice' }, data: { body: 'b' } });
    expect(events.length).toBe(1);
  });

  it('swallows listener throws so a faulty subscriber cannot block others', () => {
    const { sandbox, env } = makeSandbox();
    const seenBySecond: RequestEvent[] = [];
    onRequest(sandbox, () => { throw new Error('bad subscriber'); });
    onRequest(sandbox, (e) => seenBySecond.push(e));

    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'a' } });

    expect(seenBySecond.length).toBe(1);
  });

  it('swallows async subscriber rejections instead of letting them escape', async () => {
    // Regression: an async subscriber that throws returns a rejected
    // Promise. Without thenable detection + .catch attachment, that
    // rejection becomes an unhandledRejection on Node ≥15 default
    // config — terminating the process. One bad subscriber would kill
    // every other observer.
    const { sandbox, env } = makeSandbox();
    let rejectedCaught = false;
    // Listen for unhandled rejections during the test — if our fix
    // works there will be none from our callback.
    const onUnhandled = (reason: unknown) => {
      if (reason instanceof Error && reason.message === 'async-bad') {
        rejectedCaught = true;
      }
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const seenBySecond: RequestEvent[] = [];
      // Note: cast through unknown — onRequest's public type returns void
      // for the callback, but TS lets async functions pass since the
      // return type widens to Promise<void>.
      onRequest(sandbox, (async () => {
        throw new Error('async-bad');
      }) as unknown as (e: RequestEvent) => void);
      onRequest(sandbox, (e) => seenBySecond.push(e));

      env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'a' } });

      // Give the microtask queue a turn so any unhandled rejection
      // would fire before we assert.
      await new Promise((r) => setTimeout(r, 0));

      expect(seenBySecond.length).toBe(1);
      expect(rejectedCaught).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not allocate event when no subscribers are attached', () => {
    const { env } = makeSandbox();
    // This test mostly documents the optimisation — there's no
    // observable way to count "events not built" from outside the env.
    // The check we can make: execute returns normally without any
    // subscriber registered. (The early-bail in emitRequest skips the
    // buildRequestEvent allocation.)
    expect(() => {
      env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'a' } });
    }).not.toThrow();
  });

  it('preserves the outer trigger when a listener callback recurses into execute', () => {
    // Regression: prior to save/restore, a listener callback that issued
    // a write would clobber currentTrigger when its execute() finally
    // cleared it to undefined. Remaining listeners in the outer fan-out
    // would then emit with no triggeredBy.
    const { sandbox, env } = makeSandbox();
    const auth = { uid: 'alice' };

    // Two doc listeners on the same path. The first one's callback
    // writes to a different doc — that nested write spawns its own
    // listener fan-out and sets/restores its own trigger. The second
    // listener still needs to see the OUTER trigger.
    let nestedDone = false;
    env.addSnapshotListener(
      { kind: 'doc', path: 'notes/a' },
      () => {
        if (nestedDone) return;
        nestedDone = true;
        env.execute({ method: 'set', path: 'notes/inner', auth, data: { v: 1 } });
      },
      {},
      auth,
    );
    env.addSnapshotListener(
      { kind: 'doc', path: 'notes/a' },
      () => {},
      {},
      auth,
    );

    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    env.execute({ method: 'set', path: 'notes/a', auth, data: { v: 'outer' } });

    // The two listener-origin events on `notes/a` (one per listener)
    // should both attribute to the OUTER set, not lose the trigger
    // when the first listener's nested write completes.
    const aListenerEvents = events.filter(
      (e) => e.origin === 'listener' && e.path === 'notes/a',
    );
    expect(aListenerEvents.length).toBe(2);
    for (const e of aListenerEvents) {
      expect(e.triggeredBy).toEqual({ method: 'set', path: 'notes/a' });
    }
  });

  it('emits with origin=user before the listener fan-out', () => {
    const { sandbox, env } = makeSandbox();
    const auth = { uid: 'alice' };
    env.addSnapshotListener(
      { kind: 'doc', path: 'notes/n1' },
      () => {},
      {},
      auth,
    );

    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));
    env.execute({ method: 'set', path: 'notes/n1', auth, data: { body: 'hi' } });

    // The user event must come first; listener event(s) must follow.
    expect(events[0].origin).toBe('user');
    expect(events.slice(1).every((e) => e.origin === 'listener')).toBe(true);
  });

  it('subscriptions survive sandbox.reset() and continue firing on the new env', () => {
    // Pre-existing bug surfaced by the v2 probe (E7): sandbox.reset()
    // swaps the env, so any onRequest callback attached to the old env
    // was silently dropped. Fixed by moving the subscriber registries
    // up to SandboxImpl — see design rationale
    // decision.md §"Bugs to fix BEFORE wiring onEvent".
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'before' } });
    expect(events.length).toBe(1);
    expect(events[0].path).toBe('notes/n1');

    sandbox.reset();
    // Rules were wiped by reset; redeploy + write again. The same
    // subscription should still fire.
    const env2 = getInternalEnv(sandbox);
    env2.seed({ rules: RULES });
    env2.execute({ method: 'set', path: 'notes/n2', auth: { uid: 'alice' }, data: { body: 'after' } });
    expect(events.length).toBe(2);
    expect(events[1].path).toBe('notes/n2');
  });

  it('denial subscriptions (request kind, result=deny) survive sandbox.reset()', () => {
    const { sandbox, env } = makeSandbox();
    const denials: RequestEvent[] = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'request' && e.result === 'deny') denials.push(e);
    });

    // Bob fails the alice-only rule.
    env.execute({ method: 'set', path: 'notes/x', auth: { uid: 'bob' }, data: { body: 'x' } });
    expect(denials.length).toBe(1);

    sandbox.reset();
    const env2 = getInternalEnv(sandbox);
    env2.seed({ rules: RULES });
    env2.execute({ method: 'set', path: 'notes/y', auth: { uid: 'bob' }, data: { body: 'y' } });
    expect(denials.length).toBe(2);
  });

  it('unsubscribe still detaches across resets', () => {
    const { sandbox, env } = makeSandbox();
    const events: RequestEvent[] = [];
    const unsub = onRequest(sandbox, (e) => events.push(e));

    env.execute({ method: 'set', path: 'notes/a', auth: { uid: 'alice' }, data: { v: 1 } });
    expect(events.length).toBe(1);

    sandbox.reset();
    const env2 = getInternalEnv(sandbox);
    env2.seed({ rules: RULES });

    unsub();  // detach after reset
    env2.execute({ method: 'set', path: 'notes/b', auth: { uid: 'alice' }, data: { v: 2 } });
    expect(events.length).toBe(1);  // no new events
  });

  it('emits a write event for every committed user write', () => {
    // Step 4 — committed writes emit a parallel `kind: 'write'` event
    // carrying priorState/nextState alongside the request event.
    const { sandbox, env } = makeSandbox();
    const writes: Array<{ method: string; path: string; priorState: unknown; nextState: unknown }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'write') {
        writes.push({ method: e.method, path: e.path, priorState: e.priorState, nextState: e.nextState });
      }
    });

    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'hello' } });
    env.execute({ method: 'update', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'updated' } });
    env.execute({ method: 'delete', path: 'notes/n1', auth: { uid: 'alice' } });

    expect(writes).toHaveLength(3);
    expect(writes[0]).toEqual({ method: 'set', path: 'notes/n1', priorState: null, nextState: { body: 'hello' } });
    expect(writes[1]).toEqual({ method: 'update', path: 'notes/n1', priorState: { body: 'hello' }, nextState: { body: 'updated' } });
    expect(writes[2]).toEqual({ method: 'delete', path: 'notes/n1', priorState: { body: 'updated' }, nextState: null });
  });

  it('does NOT emit write events for denied writes or reads', () => {
    const { sandbox, env } = makeSandbox();
    const writes: Array<unknown> = [];
    sandbox.onEvent((e) => { if (e.kind === 'write') writes.push(e); });

    // Read — should never produce a write event.
    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'x' } });
    env.execute({ method: 'get', path: 'notes/n1', auth: { uid: 'alice' } });
    expect(writes).toHaveLength(1);  // only the set

    // Denied write (bob fails the alice rule) — also no write event.
    try {
      env.execute({ method: 'set', path: 'notes/n2', auth: { uid: 'bob' }, data: { body: 'nope' } });
    } catch { /* swallow */ }
    expect(writes).toHaveLength(1);
  });

  it('write events carry groupKind for batch and transaction', () => {
    const { sandbox, env } = makeSandbox();
    const writes: Array<{ groupId?: string; groupKind?: string }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'write') writes.push({ groupId: e.groupId, groupKind: e.groupKind });
    });

    env.batch(
      [{ method: 'create', path: 'notes/b1', data: { v: 1 } }],
      { uid: 'alice' },
    );
    env.transaction((tx) => {
      tx.set('notes/t1', { v: 1 });
    }, { auth: { uid: 'alice' } });

    expect(writes).toHaveLength(2);
    expect(writes[0].groupKind).toBe('batch');
    expect(writes[0].groupId).toMatch(/^batch-/);
    expect(writes[1].groupKind).toBe('transaction');
    expect(writes[1].groupId).toMatch(/^tx-/);
  });

  it('sandbox.history() returns every event the sandbox saw; reset() closes + clears', () => {
    // Replay engine surface — consumers can call history() at any
    // moment to obtain the full event stream for replay or persistence.
    const { sandbox, env } = makeSandbox();

    env.execute({ method: 'set', path: 'notes/h1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.execute({ method: 'set', path: 'notes/h2', auth: { uid: 'alice' }, data: { v: 2 } });

    const before = sandbox.history();
    const writes = before.filter((e) => e.kind === 'write');
    const requests = before.filter((e) => e.kind === 'request');
    expect(writes.length).toBe(2);
    expect(requests.length).toBe(2);

    // Defensive copy: mutating the returned array doesn't affect later calls.
    before.length = 0;
    expect(sandbox.history().length).toBeGreaterThan(0);

    sandbox.reset();
    // After reset, history starts fresh; the closing boundary is gone
    // (only consumers that snapshotted BEFORE reset retain it).
    expect(sandbox.history()).toEqual([]);

    // Snapshot taken before reset still has the boundary as last entry.
    const env2 = getInternalEnv(sandbox);
    env2.seed({ rules: RULES });
    env2.execute({ method: 'set', path: 'notes/h3', auth: { uid: 'alice' }, data: { v: 3 } });
    const after = sandbox.history();
    // request + write for the post-reset op (no boundary because the
    // previous boundary was in the pre-reset history).
    expect(after.length).toBe(2);
  });

  it('createWithAutoId populates WriteSandboxEvent.autoId; explicit creates leave it undefined', () => {
    // Replay engine — the engine reads autoId to know the path's last
    // segment was minted (not user-chosen) and aliases to a fresh mint
    // on replay rather than preserving the original ID.
    const { sandbox, env } = makeSandbox();
    const writes: Array<{ path: string; autoId?: string }> = [];
    sandbox.onEvent((e) => { if (e.kind === 'write') writes.push({ path: e.path, autoId: e.autoId }); });

    const { path: mintedPath } = env.createWithAutoId('notes', { v: 1 }, { uid: 'alice' });
    env.execute({ method: 'create', path: 'notes/explicit', auth: { uid: 'alice' }, data: { v: 2 } });

    expect(writes).toHaveLength(2);
    const minted = writes.find((w) => w.path === mintedPath);
    const explicit = writes.find((w) => w.path === 'notes/explicit');
    expect(minted?.autoId).toBeDefined();
    expect(minted?.autoId).toBe(mintedPath.split('/').pop());
    expect(explicit?.autoId).toBeUndefined();
  });

  it('every write event carries a requestTime in Timestamp shape', () => {
    // Replay engine — captured serverTime is what the rule eval pinned.
    // The replay engine re-issues this exact value when re-resolving
    // serverTimestamp() sentinels so resolved fields are bit-identical
    // on replay.
    const { sandbox, env } = makeSandbox();
    const writes: Array<{ requestTime: { seconds: number; nanoseconds: number } }> = [];
    sandbox.onEvent((e) => { if (e.kind === 'write') writes.push(e); });

    const before = Date.now();
    env.execute({ method: 'set', path: 'notes/x', auth: { uid: 'alice' }, data: { v: 1 } });
    env.batch([{ method: 'create', path: 'notes/y', data: { v: 2 } }], { uid: 'alice' });
    env.transaction((tx) => { tx.set('notes/z', { v: 3 }); }, { auth: { uid: 'alice' } });
    const after = Date.now();

    expect(writes).toHaveLength(3);
    for (const w of writes) {
      expect(w.requestTime).toBeDefined();
      expect(typeof w.requestTime.seconds).toBe('number');
      expect(typeof w.requestTime.nanoseconds).toBe('number');
      const ms = w.requestTime.seconds * 1000 + Math.floor(w.requestTime.nanoseconds / 1_000_000);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(after);
    }
  });

  it('write events carry sentinels for all five FieldValue kinds', () => {
    // Replay engine — captures FieldValue.* sentinels from pre-resolution
    // data so the engine can re-issue them at replay time without reading
    // resolved values that would have drifted.
    const { sandbox, env } = makeSandbox();
    const events: Array<{ path: string; sentinels?: Array<{ field: string; kind: string }> }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'write') events.push({ path: e.path, sentinels: e.sentinels });
    });

    // Seed so update-style sentinels have a prior.
    env.execute({
      method: 'set',
      path: 'notes/seed',
      auth: { uid: 'alice' },
      data: { counter: 0, tags: ['a'], removable: ['x'], gone: 'still here' },
    });
    // All five sentinels at top level.
    env.execute({
      method: 'update',
      path: 'notes/seed',
      auth: { uid: 'alice' },
      data: {
        ts: { __type: 'serverTimestamp' },
        counter: { __type: 'increment', value: 1 },
        tags: { __type: 'arrayUnion', values: ['b'] },
        removable: { __type: 'arrayRemove', values: ['x'] },
        gone: { __type: 'deleteField' },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.sentinels).toBeUndefined();  // plain seed has none
    const kinds = (events[1]!.sentinels ?? []).map((s) => s.kind).sort();
    expect(kinds).toEqual(['arrayRemove', 'arrayUnion', 'delete', 'increment', 'serverTimestamp']);
  });

  it('sentinel field paths cover dotted and bracket-indexed positions', () => {
    const { sandbox, env } = makeSandbox();
    const writes: Array<{ sentinels?: Array<{ field: string; kind: string }> }> = [];
    sandbox.onEvent((e) => { if (e.kind === 'write') writes.push(e); });

    env.execute({
      method: 'set',
      path: 'notes/nested',
      auth: { uid: 'alice' },
      data: { profile: { lastSeen: { __type: 'serverTimestamp' } } },
    });
    env.execute({
      method: 'set',
      path: 'notes/inarray',
      auth: { uid: 'alice' },
      data: { history: [{ __type: 'serverTimestamp' }, 'fixed'] },
    });

    expect(writes[0]!.sentinels).toEqual([{ field: 'profile.lastSeen', kind: 'serverTimestamp' }]);
    expect(writes[1]!.sentinels).toEqual([{ field: 'history[0]', kind: 'serverTimestamp' }]);
  });

  it('sentinels propagate through batch and transaction sub-ops', () => {
    const { sandbox, env } = makeSandbox();
    const writes: Array<{ path: string; sentinels?: Array<{ field: string; kind: string }> }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'write') writes.push({ path: e.path, sentinels: e.sentinels });
    });

    env.batch(
      [
        { method: 'create', path: 'notes/b1', data: { ts: { __type: 'serverTimestamp' } } },
        { method: 'create', path: 'notes/b2', data: { plain: 1 } },
      ],
      { uid: 'alice' },
    );
    env.transaction((tx) => {
      tx.set('notes/t1', { ts: { __type: 'serverTimestamp' } });
    }, { auth: { uid: 'alice' } });

    expect(writes).toHaveLength(3);
    const b1 = writes.find((w) => w.path === 'notes/b1');
    const b2 = writes.find((w) => w.path === 'notes/b2');
    const t1 = writes.find((w) => w.path === 'notes/t1');
    expect(b1?.sentinels).toEqual([{ field: 'ts', kind: 'serverTimestamp' }]);
    expect(b2?.sentinels).toBeUndefined();
    expect(t1?.sentinels).toEqual([{ field: 'ts', kind: 'serverTimestamp' }]);
  });

  it('listener_errored carries the same listenerId as the attach event', () => {
    // Pre-tighten: listener_errored used to emit listenerId='unknown'
    // because FirestoreSimError didn't carry the id. Plumbed through
    // emitSnapshotError so consumers can correlate the errored event
    // with the prior attach.
    const { sandbox, env } = makeSandbox();
    // Deploy rules that allow only alice; bob will trigger errored.
    env.seed({ rules: RULES });

    const events: Array<{ kind: string; listenerId: string }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'listener_attach' || e.kind === 'listener_errored') {
        events.push({ kind: e.kind, listenerId: e.listenerId });
      }
    });

    // Attach a listener under bob — initial read fails the rule, marks
    // the listener errored.
    env.addSnapshotListener(
      { kind: 'doc', path: 'notes/n1' },
      () => {},
      {},
      { uid: 'bob' },
      () => {},  // bob's listener has its own error handler
    );

    expect(events.length).toBeGreaterThanOrEqual(2);
    const attach = events.find((e) => e.kind === 'listener_attach');
    const errored = events.find((e) => e.kind === 'listener_errored');
    expect(attach).toBeDefined();
    expect(errored).toBeDefined();
    expect(attach!.listenerId).toBe(errored!.listenerId);
    expect(errored!.listenerId).not.toBe('unknown');
  });

  it('emits listener_attach + listener_detach lifecycle events', () => {
    const { sandbox, env } = makeSandbox();
    const lifecycle: Array<{ kind: string; listenerId: string }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'listener_attach' || e.kind === 'listener_detach' || e.kind === 'listener_errored') {
        lifecycle.push({ kind: e.kind, listenerId: e.listenerId });
      }
    });

    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'notes/n1' },
      () => {},
      {},
      { uid: 'alice' },
    );
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].kind).toBe('listener_attach');

    unsub();
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[1].kind).toBe('listener_detach');
    expect(lifecycle[1].listenerId).toBe(lifecycle[0].listenerId);
  });

  it('emits snapshot_delivery on initial fire + actual deliveries', () => {
    const { sandbox, env } = makeSandbox();
    // Seed first so initial fire delivers data.
    env.execute({ method: 'set', path: 'notes/seed', auth: { uid: 'alice' }, data: { v: 0 } });

    const deliveries: Array<{ size: number; addedCount: number; modifiedCount: number }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'snapshot_delivery') {
        deliveries.push({ size: e.size, addedCount: e.addedCount, modifiedCount: e.modifiedCount });
      }
    });

    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'notes/seed' },
      () => {},
      {},
      { uid: 'alice' },
    );
    // Initial fire — one delivery with the existing doc.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual({ size: 1, addedCount: 1, modifiedCount: 0 });

    // Write triggers a re-eval with modified change.
    env.execute({ method: 'update', path: 'notes/seed', auth: { uid: 'alice' }, data: { v: 1 } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual({ size: 1, addedCount: 0, modifiedCount: 1 });

    unsub();
  });

  it('emits snapshot_suppressed for no-op re-evals instead of snapshot_delivery', () => {
    const { sandbox, env } = makeSandbox();
    env.execute({ method: 'set', path: 'notes/s1', auth: { uid: 'alice' }, data: { v: 1 } });

    const deliveries: unknown[] = [];
    const suppressed: unknown[] = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'snapshot_delivery') deliveries.push(e);
      else if (e.kind === 'snapshot_suppressed') suppressed.push(e);
    });

    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'notes/s1' },
      () => {},
      {},
      { uid: 'alice' },
    );
    expect(deliveries).toHaveLength(1);  // initial fire
    expect(suppressed).toHaveLength(0);

    // Write the same data — listener wakes up but should suppress.
    env.execute({ method: 'set', path: 'notes/s1', auth: { uid: 'alice' }, data: { v: 1 } });
    expect(deliveries).toHaveLength(1);  // no new delivery
    expect(suppressed).toHaveLength(1);

    unsub();
  });

  it('emits session_boundary before reset and before dispose', () => {
    const { sandbox, env } = makeSandbox();
    const boundaries: Array<{ phase: string; priorOpCount: number }> = [];
    sandbox.onEvent((e) => {
      if (e.kind === 'session_boundary') {
        boundaries.push({ phase: e.phase, priorOpCount: e.priorOpCount });
      }
    });

    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'a' } });
    expect(boundaries).toHaveLength(0);  // no boundary yet

    sandbox.reset();
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].phase).toBe('reset');
    expect(boundaries[0].priorOpCount).toBeGreaterThan(0);

    // After reset, subscription still active — write through new env triggers events.
    const env2 = getInternalEnv(sandbox);
    env2.seed({ rules: RULES });
    env2.execute({ method: 'set', path: 'notes/n2', auth: { uid: 'alice' }, data: { body: 'b' } });

    sandbox.dispose();
    expect(boundaries).toHaveLength(2);
    expect(boundaries[1].phase).toBe('dispose');
  });

  it('dispose() drops user subscriptions', () => {
    // Once disposed, subscriptions are gone and the sandbox is dead.
    // This guards against a leak where a disposed sandbox keeps
    // holding callback references.
    const { sandbox } = makeSandbox();
    const events: RequestEvent[] = [];
    onRequest(sandbox, (e) => events.push(e));

    sandbox.dispose();
    // The internal registry should be cleared (verified by reflection
    // — there's no public observable for "are there subs?", so reach in).
    const subs = (sandbox as unknown as { eventSubs: Set<unknown> }).eventSubs;
    expect(subs.size).toBe(0);
  });
});
