/**
 * ListenerDispatch unit tests against a fake host (ADR-0009, PR B2).
 *
 * Engine-level behavior (rules gating, suppression against real state,
 * metadata-ack content) is pinned by the characterization suite; these
 * tests exercise the dispatch mechanics that are unit-honest against a
 * fake: registration/unsubscribe idempotence, FIFO queue drain including
 * enqueues-during-drain, and capture-at-schedule trigger attribution via
 * the injected TriggerScope.
 */
import { describe, expect, test } from 'bun:test';
import {
  ListenerDispatch,
  type ListenerDispatchHost,
} from '../../../src/firestore/sandbox/listener-dispatch.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';
import type { DocumentData } from '../../../src/firestore/sandbox/local-state.js';

function makeDispatch(docs: Record<string, DocumentData | null> = {}) {
  const bus = new FirestoreEventBus();
  const scope = new TriggerScope();
  const host: ListenerDispatchHost = {
    silentReadDoc: (path) => ({ allowed: true, data: docs[path] ?? null }),
    silentReadCollection: (collection) => ({
      allowed: true,
      docs: Object.entries(docs)
        .filter(([p, d]) => d !== null && p.startsWith(`${collection}/`))
        .map(([p, d]) => ({ path: p, data: d! })),
    }),
  };
  return { bus, scope, dispatch: new ListenerDispatch(bus, scope, host), docs };
}

describe('ListenerDispatch registration', () => {
  test('unsubscribe is idempotent and emits detach exactly once', () => {
    const { bus, dispatch } = makeDispatch();
    const lifecycle: string[] = [];
    bus.lifecycle.subscribe((e) => lifecycle.push(e.kind));

    const unsub = dispatch.addSnapshotListener(
      { kind: 'doc', path: 'games/g1' },
      () => {},
    );
    expect(dispatch.getSnapshotListenerCount()).toBe(1);
    unsub();
    unsub();
    unsub();
    expect(dispatch.getSnapshotListenerCount()).toBe(0);
    expect(lifecycle).toEqual(['listener_attach', 'listener_detach']);
  });

  test('a listener unsubscribed before the drain never receives its initial fire', () => {
    const { dispatch } = makeDispatch({ 'games/g1': { score: 1 } });
    let fires = 0;
    const unsub = dispatch.addSnapshotListener(
      { kind: 'doc', path: 'games/g1' },
      () => { fires++; },
    );
    unsub();
    dispatch.flushListeners();
    expect(fires).toBe(0);
  });

  test('initial fire is delivered off-stack, on flush', () => {
    const { dispatch } = makeDispatch({ 'games/g1': { score: 1 } });
    let fires = 0;
    dispatch.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => { fires++; });
    expect(fires).toBe(0); // never synchronous during register
    dispatch.flushListeners();
    expect(fires).toBe(1);
  });
});

describe('ListenerDispatch FIFO drain', () => {
  test('deliveries drain in schedule order across listeners', () => {
    const { dispatch, docs } = makeDispatch({ 'c/a': { v: 1 }, 'c/b': { v: 1 } });
    const order: string[] = [];
    dispatch.addSnapshotListener({ kind: 'doc', path: 'c/a' }, () => order.push('a'));
    dispatch.addSnapshotListener({ kind: 'doc', path: 'c/b' }, () => order.push('b'));
    dispatch.flushListeners();
    expect(order).toEqual(['a', 'b']);

    // Write-driven fires preserve the same per-schedule FIFO.
    docs['c/a'] = { v: 2 };
    docs['c/b'] = { v: 2 };
    dispatch.notifyListenersForPaths(new Set(['c/a', 'c/b']));
    dispatch.flushListeners();
    expect(order).toEqual(['a', 'b', 'a', 'b']);
  });

  test('deliveries enqueued DURING a drain are appended and drained in the same pass', () => {
    const { dispatch, docs } = makeDispatch({ 'c/a': { v: 1 }, 'c/b': { v: 1 } });
    const order: string[] = [];
    dispatch.addSnapshotListener({ kind: 'doc', path: 'c/b' }, () => order.push('b'));
    dispatch.addSnapshotListener({ kind: 'doc', path: 'c/a' }, () => {
      order.push('a');
      // A callback that itself "writes": schedules more deliveries
      // mid-drain. They must land in the SAME flush pass.
      if (order.filter((x) => x === 'a').length === 1) {
        docs['c/b'] = { v: 2 };
        dispatch.notifyListenersForPaths(new Set(['c/b']));
      }
    });
    dispatch.flushListeners(); // initial fires: b, a — then a's nested notify
    expect(order).toEqual(['b', 'a', 'b']);
  });
});

describe('ListenerDispatch trigger attribution (capture-at-schedule)', () => {
  test('delivery events attribute to the trigger active at SCHEDULE time, not drain time', () => {
    const { bus, scope, dispatch, docs } = makeDispatch({ 'games/g1': { v: 1 } });
    const triggeredBy: Array<{ method: string; path: string } | undefined> = [];
    bus.delivery.subscribe((e) => triggeredBy.push(e.triggeredBy));

    dispatch.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => {});
    dispatch.flushListeners(); // initial fire: no triggering user op
    expect(triggeredBy).toEqual([undefined]);

    docs['games/g1'] = { v: 2 };
    scope.run({ method: 'set', path: 'games/g1' }, () => {
      dispatch.notifyListenersForPaths(new Set(['games/g1']));
    });
    // The writing stack has unwound — current() is empty — yet the drain
    // still attributes to the captured trigger.
    expect(scope.current()).toBeUndefined();
    dispatch.flushListeners();
    expect(triggeredBy).toEqual([undefined, { method: 'set', path: 'games/g1' }]);
  });

  test('dispose drops registered listeners and queued deliveries', () => {
    const { dispatch } = makeDispatch({ 'games/g1': { v: 1 } });
    let fires = 0;
    dispatch.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => { fires++; });
    dispatch.dispose();
    dispatch.flushListeners();
    expect(fires).toBe(0);
    expect(dispatch.getSnapshotListenerCount()).toBe(0);
  });
});
