/**
 * Unit tests for `try_rules_edit`'s pure helpers. Exercises:
 *   - `requestEventToTestCase` — captured RequestEvent → simulator TestCase
 *   - `classifyFixResults`     — fix bucketing (unblocked/stillDenied/unsupported)
 *   - `classifyRegressions`    — divergence bucketing (nowDenied/drift)
 *   - `partitionEvents`        — single-pass split into denied requests + writes
 *
 * The handler itself isn't tested directly — `getRunner()` is a
 * singleton with side effects, and the wrapper is a thin orchestration
 * over the pure helpers. Manual playground verification covers it.
 */
import { describe, test, expect } from 'bun:test';
import type {
  RequestEvent,
  WriteSandboxEvent,
  Divergence,
  SandboxEvent,
} from 'pyric/sandbox';
import type { TestResult } from 'pyric/rules/internal';
import {
  classifyFixResults,
  classifyRegressions,
  partitionEvents,
  requestEventToTestCase,
} from './try-rules-edit.shared';

// ─── Test fixtures ───────────────────────────────────────────────────

function reqEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    kind: 'request',
    id: 'r1',
    at: 1_700_000_000_000,
    evalMs: 1,
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'alice', token: {} },
    result: 'deny',
    reasons: ['Rule #0 (create) → deny', 'Simulated: DENY'],
    origin: 'user',
    ...overrides,
  };
}

function writeEvent(overrides: Partial<WriteSandboxEvent> = {}): WriteSandboxEvent {
  return {
    kind: 'write',
    id: 'w1',
    at: 1_700_000_000_000,
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'alice', token: {} },
    data: { title: 'hi' },
    priorState: null,
    nextState: { title: 'hi' },
    requestTime: { seconds: 1_700_000_000, nanoseconds: 0 },
    ...overrides,
  };
}

function tr(overrides: Partial<TestResult> = {}): TestResult {
  return {
    description: 'tc',
    expectation: 'ALLOW',
    state: 'PASSED',
    decision: 'ALLOW',
    trace: [],
    notes: [],
    ...overrides,
  };
}

// ─── requestEventToTestCase ──────────────────────────────────────────

describe('requestEventToTestCase', () => {
  test('passes method get/list/create/update/delete through unchanged', () => {
    for (const m of ['get', 'list', 'create', 'update', 'delete'] as const) {
      const tc = requestEventToTestCase(reqEvent({ method: m }));
      expect(tc?.method).toBe(m);
    }
  });

  test('maps sandbox method `set` to `create` when the doc did NOT exist', () => {
    // SandboxEvent's `method` enum has 'set'; TestCase.method does not.
    // Mapping rule: !existed → 'create', writeMode: { kind: 'set' }.
    const tc = requestEventToTestCase(reqEvent({
      method: 'set',
      resourceBefore: { data: null, exists: false },
    }));
    expect(tc?.method).toBe('create');
    expect(tc?.writeMode).toEqual({ kind: 'set', merge: false });
  });

  test('maps sandbox method `set` to `update` when the doc DID exist', () => {
    const tc = requestEventToTestCase(reqEvent({
      method: 'set',
      resourceBefore: { data: { title: 'old' }, exists: true },
    }));
    expect(tc?.method).toBe('update');
    expect(tc?.writeMode).toEqual({ kind: 'set', merge: false });
  });

  test('writeMode is undefined for non-set methods', () => {
    // No writeMode → simulator uses legacy semantics (data IS the
    // after-state). Matches what the captured rule eval saw.
    const tc = requestEventToTestCase(reqEvent({ method: 'create' }));
    expect(tc?.writeMode).toBeUndefined();
  });

  test('copies request.resourceData into TestCase.data when present', () => {
    const tc = requestEventToTestCase(reqEvent({
      method: 'create',
      request: { resourceData: { title: 'hi', owner: 'alice' } },
    }));
    expect(tc?.data).toEqual({ title: 'hi', owner: 'alice' });
  });

  test('copies resourceBefore.data into TestCase.resource when present', () => {
    const tc = requestEventToTestCase(reqEvent({
      method: 'update',
      resourceBefore: { data: { title: 'old' }, exists: true },
    }));
    expect(tc?.resource).toEqual({ title: 'old' });
  });

  test('null auth round-trips as null', () => {
    const tc = requestEventToTestCase(reqEvent({ auth: null }));
    expect(tc?.auth).toBeNull();
  });

  test('auth with token round-trips', () => {
    const tc = requestEventToTestCase(reqEvent({
      auth: { uid: 'alice', token: { admin: true } },
    }));
    expect(tc?.auth).toEqual({ uid: 'alice', token: { admin: true } });
  });

  test('description carries the event id + method + path for traceability', () => {
    // The simulator echoes description back on TestResult; it's the
    // load-bearing field that lets the agent map a simulation result
    // back to the original captured event without an out-of-band map.
    const tc = requestEventToTestCase(reqEvent({
      id: 'req-42',
      method: 'update',
      path: 'notes/n1',
    }));
    expect(tc?.description).toContain('req-42');
    expect(tc?.description).toContain('update');
    expect(tc?.description).toContain('notes/n1');
  });
});

// ─── classifyFixResults ──────────────────────────────────────────────

describe('classifyFixResults', () => {
  test('ALLOW decision lands in unblocked with the original event attached', () => {
    const events = [reqEvent({ id: 'r1', path: 'docs/d1' })];
    const results = [tr({ decision: 'ALLOW' })];
    const out = classifyFixResults(events, results);
    expect(out.unblocked).toHaveLength(1);
    expect(out.unblocked[0].eventId).toBe('r1');
    expect(out.unblocked[0].path).toBe('docs/d1');
    expect(out.unblocked[0].event).toBe(events[0]);
    expect(out.stillDenied).toBe(0);
    expect(out.nowUnsupported).toBe(0);
  });

  test('DENY decision increments stillDenied', () => {
    const out = classifyFixResults(
      [reqEvent()],
      [tr({ decision: 'DENY', state: 'FAILED' })],
    );
    expect(out.unblocked).toHaveLength(0);
    expect(out.stillDenied).toBe(1);
    expect(out.nowUnsupported).toBe(0);
  });

  test('UNSUPPORTED decision increments nowUnsupported (not stillDenied)', () => {
    // Important distinction: UNSUPPORTED means the simulator
    // abstained, not that the rule actually denies. Counting it as
    // stillDenied would mislead the agent into thinking the fix is
    // ineffective when really the simulator just can't decide.
    const out = classifyFixResults(
      [reqEvent()],
      [tr({ decision: 'UNSUPPORTED', state: 'UNSUPPORTED' })],
    );
    expect(out.unblocked).toHaveLength(0);
    expect(out.stillDenied).toBe(0);
    expect(out.nowUnsupported).toBe(1);
  });

  test('preserves originalReasons from the captured event', () => {
    const events = [reqEvent({ reasons: ['Rule #2 (create) → deny: ownerId missing'] })];
    const results = [tr({ decision: 'ALLOW' })];
    const out = classifyFixResults(events, results);
    expect(out.unblocked[0].originalReasons).toEqual([
      'Rule #2 (create) → deny: ownerId missing',
    ]);
  });

  test('mixed results bucket correctly in one pass', () => {
    const events = [
      reqEvent({ id: 'a' }),
      reqEvent({ id: 'b' }),
      reqEvent({ id: 'c' }),
      reqEvent({ id: 'd' }),
    ];
    const results = [
      tr({ decision: 'ALLOW' }),
      tr({ decision: 'DENY', state: 'FAILED' }),
      tr({ decision: 'UNSUPPORTED', state: 'UNSUPPORTED' }),
      tr({ decision: 'ALLOW' }),
    ];
    const out = classifyFixResults(events, results);
    expect(out.unblocked.map(u => u.eventId)).toEqual(['a', 'd']);
    expect(out.stillDenied).toBe(1);
    expect(out.nowUnsupported).toBe(1);
  });

  test('events and results that mismatch by index are skipped, not crash', () => {
    // Length mismatch is a programmer error upstream; the function
    // refuses to invent data — it walks min(len) and skips the rest.
    const events = [reqEvent({ id: 'a' }), reqEvent({ id: 'b' })];
    const results = [tr({ decision: 'ALLOW' })];
    const out = classifyFixResults(events, results);
    expect(out.unblocked).toHaveLength(1);
    expect(out.unblocked[0].eventId).toBe('a');
    expect(out.stillDenied).toBe(0);
  });
});

// ─── classifyRegressions ─────────────────────────────────────────────

describe('classifyRegressions', () => {
  test('real-divergence with missing-after path lands in nowDenied paired with the write', () => {
    // Doc existed in original state, missing in replayed state →
    // replay couldn't apply the write → new rules deny it.
    const write = writeEvent({ id: 'w1', path: 'docs/d1' });
    const divergences: Divergence[] = [
      { kind: 'real-divergence', path: 'docs/d1', before: { title: 'hi' }, after: undefined },
    ];
    const out = classifyRegressions(divergences, [write]);
    expect(out.nowDenied).toHaveLength(1);
    expect(out.nowDenied[0].eventId).toBe('w1');
    expect(out.nowDenied[0].path).toBe('docs/d1');
    expect(out.nowDenied[0].event).toBe(write);
    expect(out.drift).toHaveLength(0);
  });

  test('field-level real-divergence (path present, field changed) is informational drift', () => {
    // Field differs but path exists in both states → not a denial,
    // it's a content drift. Land in drift, not nowDenied.
    const write = writeEvent({ id: 'w1', path: 'docs/d1' });
    const divergences: Divergence[] = [
      { kind: 'real-divergence', path: 'docs/d1', field: 'title', before: 'old', after: 'new' },
    ];
    const out = classifyRegressions(divergences, [write]);
    expect(out.nowDenied).toHaveLength(0);
    expect(out.drift).toHaveLength(1);
  });

  test('autoid-alias / sentinel-drift / time-drift always go to drift', () => {
    // These three are informational by design — the replay engine
    // licenses them via captured metadata. They should never be
    // misclassified as regressions.
    const divergences: Divergence[] = [
      { kind: 'autoid-alias', originalPath: 'notes/abc', replayedPath: 'notes/xyz' },
      { kind: 'sentinel-drift', path: 'docs/d1', field: 'updatedAt', sentinelKind: 'serverTimestamp', before: 1, after: 2 },
      { kind: 'time-drift', path: 'docs/d1', field: 'createdAt', before: 1, after: 2 },
    ];
    const out = classifyRegressions(divergences, []);
    expect(out.nowDenied).toHaveLength(0);
    expect(out.drift).toHaveLength(3);
  });

  test('missing-after divergence WITHOUT a matching write falls into drift, not nowDenied', () => {
    // Path-missing divergence but no captured write produced the doc.
    // Could happen if state was seeded directly via admin bypass and
    // the seed appears in `state` but not in `events`. Surface as
    // drift so the agent sees the signal but isn't told it's a
    // regression we can attribute to a specific op.
    const divergences: Divergence[] = [
      { kind: 'real-divergence', path: 'seeded/d1', before: { title: 'hi' }, after: undefined },
    ];
    const out = classifyRegressions(divergences, []);
    expect(out.nowDenied).toHaveLength(0);
    expect(out.drift).toHaveLength(1);
  });

  test('multiple regressions on the same path attribute to the LATEST write', () => {
    // If a doc was written twice (create then update), the second
    // write is the more relevant "this op is now denied" handle for
    // the agent. Latest-wins matches the replay's actual application
    // order.
    const w1 = writeEvent({ id: 'w1', path: 'docs/d1', method: 'create' });
    const w2 = writeEvent({ id: 'w2', path: 'docs/d1', method: 'update' });
    const divergences: Divergence[] = [
      { kind: 'real-divergence', path: 'docs/d1', before: { title: 'hi' }, after: undefined },
    ];
    const out = classifyRegressions(divergences, [w1, w2]);
    expect(out.nowDenied).toHaveLength(1);
    expect(out.nowDenied[0].eventId).toBe('w2');
  });
});

// ─── partitionEvents ─────────────────────────────────────────────────

describe('partitionEvents', () => {
  test('splits a mixed event stream into denied requests + writes', () => {
    const events: SandboxEvent[] = [
      reqEvent({ id: 'a', result: 'allow' }),
      reqEvent({ id: 'b', result: 'deny' }),
      writeEvent({ id: 'w1' }),
      reqEvent({ id: 'c', result: 'unsupported' }),
      reqEvent({ id: 'd', result: 'deny' }),
      writeEvent({ id: 'w2' }),
    ];
    const out = partitionEvents(events);
    expect(out.deniedRequests.map(e => e.id)).toEqual(['b', 'd']);
    expect(out.writes.map(w => w.id)).toEqual(['w1', 'w2']);
  });

  test('ignores other event kinds (snapshot_delivery, listener_lifecycle, etc.)', () => {
    // Non-request, non-write events shouldn't end up in either
    // bucket. They're not replayable inputs.
    const events: SandboxEvent[] = [
      reqEvent({ id: 'b', result: 'deny' }),
      {
        kind: 'session_boundary',
        id: 'sb1',
        at: 1_700_000_000_000,
        phase: 'reset',
        priorOpCount: 5,
      },
      writeEvent({ id: 'w1' }),
    ];
    const out = partitionEvents(events);
    expect(out.deniedRequests).toHaveLength(1);
    expect(out.writes).toHaveLength(1);
  });

  test('allow / unsupported requests are NOT in deniedRequests', () => {
    const events: SandboxEvent[] = [
      reqEvent({ id: 'a', result: 'allow' }),
      reqEvent({ id: 'b', result: 'unsupported' }),
    ];
    const out = partitionEvents(events);
    expect(out.deniedRequests).toHaveLength(0);
  });

  test('empty stream produces empty buckets', () => {
    const out = partitionEvents([]);
    expect(out.deniedRequests).toEqual([]);
    expect(out.writes).toEqual([]);
  });
});
