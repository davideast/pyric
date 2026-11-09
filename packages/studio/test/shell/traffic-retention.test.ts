import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  EMPTY_TRAFFIC_FEED_SNAPSHOT,
  foldTrafficFeedSnapshot,
  retainTrafficEvents,
} from '../../src/shell/traffic-retention.js';

function clientOp(id: string, at: number, verdict: 'allow' | 'deny' | 'unevaluated' = 'allow'): SandboxEvent {
  let local: { readonly result: 'allow' | 'deny' } | { readonly result: 'unevaluated'; readonly needs: readonly ['stored-document'] } = {
    result: 'allow',
  };
  if (verdict === 'unevaluated') {
    local = { result: 'unevaluated', needs: ['stored-document'] };
  } else if (verdict === 'deny') {
    local = { result: 'deny' };
  }
  return {
    kind: 'operation',
    id,
    at,
    service: 'firestore',
    method: 'getDoc',
    path: `items/${id}`,
    auth: { uid: 'u-1' },
    origin: 'user',
    result: verdict === 'deny' ? 'deny' : 'allow',
    rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
    production: { outcome: { status: 'ok' }, local },
  } as unknown as SandboxEvent;
}

function adminOp(id: string, at: number): SandboxEvent {
  return {
    kind: 'operation',
    id,
    at,
    service: 'firestore',
    method: 'DocumentReference.get',
    path: `items/${id}`,
    auth: null,
    origin: 'admin',
    result: 'allow',
    rulesDisposition: { kind: 'bypassed', reason: 'admin' },
    production: { outcome: { status: 'ok' } },
  } as unknown as SandboxEvent;
}

function rtdbDeliveryOp(
  id: string,
  at: number,
  listenerId: string,
  verdict: 'allow' | 'deny' = 'allow',
  drift = false,
): SandboxEvent {
  return {
    kind: 'operation',
    id,
    at,
    service: 'rtdb',
    method: 'onValue',
    path: '/items/list',
    auth: { uid: 'u-1' },
    origin: 'user',
    result: 'allow',
    detail: { listenerId },
    rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
    production: {
      outcome: { status: 'ok' },
      local: drift ? { result: verdict, drift: true } : { result: verdict },
    },
  } as unknown as SandboxEvent;
}

function nonTrafficWrite(id: string, at: number): SandboxEvent {
  return {
    kind: 'write',
    id,
    at,
    method: 'create',
    path: `users/${id}`,
    auth: null,
    priorState: null,
    nextState: {},
    requestTime: { seconds: 0, nanoseconds: 0 },
  } as SandboxEvent;
}

function deduplicatedRuleCount(events: readonly SandboxEvent[]): number {
  const seenListeners = new Set<string>();
  let total = 0;
  for (const event of events) {
    if (event.kind !== 'operation') continue;
    const local = event.production?.local;
    if (local === undefined) continue;
    if (local.result === 'unevaluated') continue;
    const detail = event.detail as { listenerId?: string } | undefined;
    const listenerId = detail?.listenerId;
    if (listenerId !== undefined) {
      const key = `${listenerId}:${local.result}:${Boolean(local.drift)}`;
      if (seenListeners.has(key)) continue;
      seenListeners.add(key);
    }
    total += 1;
  }
  return total;
}

describe('traffic-retention', () => {
  it('never evicts client requests when background Admin SDK calls or non-traffic events exceed the cap', () => {
    const cap = 5;
    const clientEvents = [
      clientOp('c-1', 10, 'allow'),
      clientOp('c-2', 20, 'deny'),
      clientOp('c-3', 30, 'unevaluated'),
    ];
    const noise: SandboxEvent[] = [];
    for (let index = 0; index < 12; index += 1) {
      noise.push(nonTrafficWrite(`w-${index}`, 100 + index));
      noise.push(adminOp(`a-${index}`, 200 + index));
    }

    const retained = retainTrafficEvents([...clientEvents, ...noise], cap);
    const ids = retained.events.map((event) => event.id);

    expect(ids.slice(0, 3)).toEqual(['c-1', 'c-2', 'c-3']);
    expect(ids.slice(3)).toEqual(['a-7', 'a-8', 'a-9', 'a-10', 'a-11']);
    expect(retained.capped).toBe(true);
    expect(retained.clientCapped).toBe(false);
  });

  it('keeps initial and transitioned listener verdicts separate from steady-state delivery churn', () => {
    const cap = 4;
    const events: SandboxEvent[] = [
      clientOp('c-1', 10, 'allow'),
      rtdbDeliveryOp('d-allow-1', 20, 'page:tab-1:l-1', 'allow', false),
      rtdbDeliveryOp('d-allow-2', 30, 'page:tab-1:l-1', 'allow', false),
      rtdbDeliveryOp('d-allow-3', 40, 'page:tab-1:l-1', 'allow', false),
      rtdbDeliveryOp('d-deny-drift-1', 50, 'page:tab-1:l-1', 'deny', true),
      rtdbDeliveryOp('d-deny-drift-2', 60, 'page:tab-1:l-1', 'deny', true),
      rtdbDeliveryOp('d-deny-drift-3', 70, 'page:tab-1:l-1', 'deny', true),
      rtdbDeliveryOp('d-deny-drift-4', 80, 'page:tab-1:l-1', 'deny', true),
      rtdbDeliveryOp('d-deny-drift-5', 90, 'page:tab-1:l-1', 'deny', true),
    ];

    const retained = retainTrafficEvents(events, cap);
    const ids = retained.events.map((event) => event.id);

    expect(ids).toEqual([
      'c-1',
      'd-allow-1',
      'd-deny-drift-1',
      'd-deny-drift-2',
      'd-deny-drift-3',
      'd-deny-drift-4',
      'd-deny-drift-5',
    ]);
    expect(retained.capped).toBe(true);
    expect(retained.clientCapped).toBe(false);
  });

  it('never reclassifies listener deliveries or ticks Rules counts backwards across folds when client lane is full and client is idle', () => {
    const cap = 5;
    let state = EMPTY_TRAFFIC_FEED_SNAPSHOT;
    let clock = 10;

    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('L-a', clock++, 'l-a'), cap);
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('L-b', clock++, 'l-b'), cap);
    for (let index = 0; index < 6; index += 1) {
      state = foldTrafficFeedSnapshot(state, clientOp(`c-${index}`, clock++), cap);
    }
    expect(state.clientCapped).toBe(true);
    const baselineClientIds = state.lanes.client.map((entry) => entry.event.id);
    expect(baselineClientIds).toEqual(['c-1', 'c-2', 'c-3', 'c-4', 'c-5']);
    const baselineRulesCount = deduplicatedRuleCount(state.events);
    expect(baselineRulesCount).toBe(7);

    // Stream 20 interleaved and unilateral listener deliveries while the client is idle.
    for (let tick = 0; tick < 10; tick += 1) {
      state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp(`a-${tick}`, clock++, 'l-a'), cap);
      expect(state.lanes.client.map((entry) => entry.event.id)).toEqual(baselineClientIds);
      expect(deduplicatedRuleCount(state.events)).toBe(baselineRulesCount);

      state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp(`b-${tick}`, clock++, 'l-b'), cap);
      expect(state.lanes.client.map((entry) => entry.event.id)).toEqual(baselineClientIds);
      expect(deduplicatedRuleCount(state.events)).toBe(baselineRulesCount);
    }

    // Even when >cap distinct listeners attach and age out the earliest listenerVerdicts entry,
    // seenListenerVerdicts keeps `l-a` so subsequent `l-a` deliveries stay in `deliveries`.
    for (let extra = 0; extra < 5; extra += 1) {
      state = foldTrafficFeedSnapshot(
        state,
        rtdbDeliveryOp(`L-extra-${extra}`, clock++, `l-extra-${extra}`),
        cap,
      );
    }
    const verdictLaneIds = state.lanes.listenerVerdicts.map((entry) => entry.event.id);
    expect(verdictLaneIds).toEqual([
      'L-extra-0',
      'L-extra-1',
      'L-extra-2',
      'L-extra-3',
      'L-extra-4',
    ]);
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('a-late', clock++, 'l-a'), cap);
    expect(state.lanes.listenerVerdicts.map((entry) => entry.event.id)).toEqual(verdictLaneIds);
    expect(state.lanes.client.map((entry) => entry.event.id)).toEqual(baselineClientIds);
  });

  it('latches capped across incremental folds until a session reset boundary clears the snapshot and seen verdicts', () => {
    const cap = 2;
    let state = EMPTY_TRAFFIC_FEED_SNAPSHOT;
    state = foldTrafficFeedSnapshot(state, clientOp('c-1', 10), cap);
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('L-1', 12, 'l-1'), cap);
    const afterNonTraffic = foldTrafficFeedSnapshot(state, nonTrafficWrite('w-1', 15), cap);
    expect(afterNonTraffic).toBe(state);

    state = foldTrafficFeedSnapshot(state, adminOp('a-1', 20), cap);
    state = foldTrafficFeedSnapshot(state, adminOp('a-2', 30), cap);
    expect(state.capped).toBe(false);

    state = foldTrafficFeedSnapshot(state, adminOp('a-3', 40), cap);
    expect(state.capped).toBe(true);
    expect(state.clientCapped).toBe(false);
    expect(state.uncoveredBeforeAt).toBe(30);
    expect(state.rulesUncoveredBeforeAt).toBeNull();
    state = foldTrafficFeedSnapshot(state, clientOp('c-2', 50), cap);
    expect(state.capped).toBe(true);
    expect(state.events.map((event) => event.id)).toEqual(['c-1', 'L-1', 'a-2', 'a-3', 'c-2']);

    const resetBoundary: SandboxEvent = {
      kind: 'session_boundary',
      id: 'reset-1',
      at: 60,
      phase: 'reset',
    };
    state = foldTrafficFeedSnapshot(state, resetBoundary, cap);
    expect(state.events).toEqual([]);
    expect(state.capped).toBe(false);
    expect(state.clientCapped).toBe(false);
    expect(state.uncoveredBeforeAt).toBeNull();
    expect(state.rulesUncoveredBeforeAt).toBeNull();
    expect(state.seenListenerVerdicts.size).toBe(0);

    // After reset, `l-1` enters `listenerVerdicts` fresh as a new session subscription.
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('L-1-post-reset', 70, 'l-1'), cap);
    expect(state.lanes.listenerVerdicts.map((entry) => entry.event.id)).toEqual([
      'L-1-post-reset',
    ]);
  });

  it('tracks rulesUncoveredBeforeAt when chatty listener deliveries evict an earlier listener delivery', () => {
    const cap = 2;
    let state = EMPTY_TRAFFIC_FEED_SNAPSHOT;
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('B-attach', 10, 'l-b'), cap);
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('B-push', 25, 'l-b'), cap);
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('A-attach', 30, 'l-a'), cap);
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('A-push-1', 40, 'l-a'), cap);
    expect(state.rulesUncoveredBeforeAt).toBeNull();

    // `A-push-2` evicts `B-push` (25) from `deliveries`; oldest retained delivery is now `40`.
    state = foldTrafficFeedSnapshot(state, rtdbDeliveryOp('A-push-2', 50, 'l-a'), cap);
    expect(state.clientCapped).toBe(false);
    expect(state.rulesUncoveredBeforeAt).toBe(40);
  });

  it('marks capped, clientCapped, and uncovered horizons when upstream EventHistory emits a history-limit observation_gap', () => {
    const gapEvent: SandboxEvent = {
      kind: 'observation_gap',
      id: 'history-gap',
      at: 5,
      reason: 'history-limit',
      firstEventId: 'ev-1',
      lastEventId: 'ev-100',
      omittedCount: 100,
    };
    const retained = retainTrafficEvents([gapEvent, clientOp('c-1', 10)], 500);
    expect(retained.capped).toBe(true);
    expect(retained.clientCapped).toBe(true);
    expect(retained.uncoveredBeforeAt).toBe(6);
    expect(retained.rulesUncoveredBeforeAt).toBe(6);
    expect(retained.events.map((event) => event.id)).toEqual(['c-1']);
  });
});
