import { describe, expect, test } from 'bun:test';
import { EventHistory } from '../../src/sandbox/internal/event-history.js';
import { assertCompleteHistory } from '../../src/sandbox/internal/history-integrity.js';
import { OBSERVATION_HISTORY_LIMITS } from '../../src/sandbox/internal/observation-history.js';
import { SandboxError } from '../../src/sandbox/types/errors.js';
import type {
  ListenerLifecycleEvent,
  RequestEvent,
  SandboxCommitEvent,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxObservationGapEvent,
  SandboxOperationEvent,
  SandboxRuntimeErrorEvent,
  ServiceMutationEvent,
} from '../../src/sandbox/types/events.js';

function firestoreDeny(id: string, at: number): RequestEvent {
  return {
    kind: 'request',
    id,
    at,
    evalMs: 1,
    method: 'update',
    path: `items/${id}`,
    auth: { uid: 'owner-1' },
    result: 'deny',
    reasons: ['allow write: false'],
    origin: 'user',
  };
}

function firestoreAllow(id: string, at: number, pad = ''): RequestEvent {
  return {
    kind: 'request',
    id,
    at,
    evalMs: 0,
    method: 'update',
    path: `items/${id}${pad}`,
    auth: { uid: 'owner-1' },
    result: 'allow',
    reasons: ['allow write: true'],
    origin: 'user',
  };
}

function firestoreListenerErrored(id: string, at: number): ListenerLifecycleEvent {
  return {
    kind: 'listener_errored',
    id,
    at,
    listenerId: `listener-${id}`,
    target: { kind: 'doc', path: `items/${id}` },
    auth: { uid: 'owner-1' },
    error: { code: 'permission-denied', message: 'Permission denied' },
  };
}

function rtdbOperation(
  id: string,
  at: number,
  result: 'allow' | 'deny',
  pad = '',
): SandboxOperationEvent {
  return {
    kind: 'operation',
    id,
    at,
    service: 'rtdb',
    method: 'set',
    path: `/items/${id}${pad}`,
    auth: { uid: 'owner-1' },
    origin: 'user',
    result,
  };
}

function rtdbCommit(id: string, at: number): SandboxCommitEvent {
  return {
    kind: 'commit',
    id,
    at,
    service: 'rtdb',
    method: 'set',
    path: `/items/${id}`,
    auth: { uid: 'owner-1' },
  };
}

function rtdbMutation(id: string, at: number): ServiceMutationEvent {
  return {
    kind: 'service_mutation',
    id,
    at,
    service: 'rtdb',
    op: 'set',
    path: `/items/${id}`,
    auth: { uid: 'owner-1' },
    detail: { value: at },
  };
}

function rtdbListenerErrored(id: string, at: number): SandboxListenerEvent {
  return {
    kind: 'listener',
    id,
    at,
    service: 'rtdb',
    phase: 'errored',
    listenerId: `db-listener-${id}`,
    target: { kind: 'value', path: `/items/${id}` },
    auth: { uid: 'owner-1' },
    error: { code: 'PERMISSION_DENIED', message: 'Permission denied' },
  };
}

function storageOperation(
  id: string,
  at: number,
  result: 'allow' | 'deny',
  pad = '',
): SandboxOperationEvent {
  return {
    kind: 'operation',
    id,
    at,
    service: 'storage',
    method: 'uploadBytes',
    path: `items/${id}${pad}`,
    auth: { uid: 'owner-1' },
    origin: 'user',
    result,
  };
}

function runtimeError(
  id: string,
  at: number,
  service: 'firestore' | 'rtdb' | 'storage',
): SandboxRuntimeErrorEvent {
  return {
    kind: 'runtime_error',
    id,
    at,
    service,
    method: 'write',
    path: `items/${id}`,
    auth: { uid: 'owner-1' },
    error: { code: 'internal', message: 'unexpected runtime error' },
  };
}

function findGap(events: readonly SandboxEvent[]): SandboxObservationGapEvent | undefined {
  for (const event of events) {
    if (event.kind === 'observation_gap') return event;
  }
  return undefined;
}

function nonGapEvents(events: readonly SandboxEvent[]): SandboxEvent[] {
  return events.filter((event) => event.kind !== 'observation_gap');
}

function assertChronological(events: readonly SandboxEvent[]): void {
  const ordered = nonGapEvents(events);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    expect(current.at).toBeGreaterThanOrEqual(previous.at);
  }
}

interface SoakScenario {
  readonly name: string;
  readonly earlyEvent: (id: string, at: number) => SandboxEvent;
  readonly allowedBurst: (writeIndex: number, startAt: number) => SandboxEvent[];
}

const SOAK_SCENARIOS: readonly SoakScenario[] = [
  {
    name: 'firestore request denial',
    earlyEvent: firestoreDeny,
    allowedBurst: (writeIndex, startAt) => [
      firestoreAllow(`fs-a-${writeIndex}`, startAt),
      firestoreAllow(`fs-b-${writeIndex}`, startAt + 1),
      firestoreAllow(`fs-c-${writeIndex}`, startAt + 2),
    ],
  },
  {
    name: 'firestore listener error',
    earlyEvent: firestoreListenerErrored,
    allowedBurst: (writeIndex, startAt) => [
      firestoreAllow(`fsl-a-${writeIndex}`, startAt),
      firestoreAllow(`fsl-b-${writeIndex}`, startAt + 1),
      firestoreAllow(`fsl-c-${writeIndex}`, startAt + 2),
    ],
  },
  {
    name: 'rtdb operation denial',
    earlyEvent: (id, at) => rtdbOperation(id, at, 'deny'),
    allowedBurst: (writeIndex, startAt) => [
      rtdbOperation(`rtdb-op-${writeIndex}`, startAt, 'allow'),
      rtdbCommit(`rtdb-cm-${writeIndex}`, startAt + 1),
      rtdbMutation(`rtdb-mt-${writeIndex}`, startAt + 2),
    ],
  },
  {
    name: 'rtdb listener error',
    earlyEvent: rtdbListenerErrored,
    allowedBurst: (writeIndex, startAt) => [
      rtdbOperation(`rtdbl-op-${writeIndex}`, startAt, 'allow'),
      rtdbCommit(`rtdbl-cm-${writeIndex}`, startAt + 1),
      rtdbMutation(`rtdbl-mt-${writeIndex}`, startAt + 2),
    ],
  },
  {
    name: 'storage operation denial',
    earlyEvent: (id, at) => storageOperation(id, at, 'deny'),
    allowedBurst: (writeIndex, startAt) => [
      storageOperation(`st-a-${writeIndex}`, startAt, 'allow'),
      storageOperation(`st-b-${writeIndex}`, startAt + 1, 'allow'),
      storageOperation(`st-c-${writeIndex}`, startAt + 2, 'allow'),
    ],
  },
  {
    name: 'storage runtime error',
    earlyEvent: (id, at) => runtimeError(id, at, 'storage'),
    allowedBurst: (writeIndex, startAt) => [
      storageOperation(`err-a-${writeIndex}`, startAt, 'allow'),
      storageOperation(`err-b-${writeIndex}`, startAt + 1, 'allow'),
      storageOperation(`err-c-${writeIndex}`, startAt + 2, 'allow'),
    ],
  },
];

describe('EventHistory bounded denial and error retention lane', () => {
  for (const scenario of SOAK_SCENARIOS) {
    test(`${scenario.name} survives 3,500+ allowed writes with chronological order and zero omitted denials`, () => {
      const history = new EventHistory(OBSERVATION_HISTORY_LIMITS);
      const firstId = 'early-denial-1';
      const middleId = 'middle-denial-2';
      let clock = 1;
      let appended = 0;

      history.append(scenario.earlyEvent(firstId, clock));
      clock += 1;
      appended += 1;

      const totalWrites = 3_600;
      const midWrite = 1_800;
      for (let writeIndex = 0; writeIndex < totalWrites; writeIndex++) {
        if (writeIndex === midWrite) {
          history.append(scenario.earlyEvent(middleId, clock));
          clock += 1;
          appended += 1;
        }
        const burst = scenario.allowedBurst(writeIndex, clock);
        for (const event of burst) {
          history.append(event);
          appended += 1;
        }
        clock += burst.length;
      }

      const retained = history.snapshot();
      const nonGap = nonGapEvents(retained);
      const ids = new Set(nonGap.map((event) => event.id));

      expect(ids.has(firstId)).toBe(true);
      expect(ids.has(middleId)).toBe(true);
      expect(nonGap.length).toBeLessThanOrEqual(OBSERVATION_HISTORY_LIMITS.maxEvents);
      assertChronological(retained);

      const gap = findGap(retained);
      expect(gap).toBeDefined();
      expect(gap?.reason).toBe('history-limit');
      expect(gap?.omittedCount).toBe(appended - nonGap.length);
      expect(gap?.omittedDenials).toBe(0);
    });
  }

  test('large allowed writes hitting byte limits cannot evict earlier denials across services', () => {
    const history = new EventHistory({
      maxEvents: 500,
      maxBytes: 12_000,
      maxDenialEvents: 20,
      maxDenialBytes: 4_000,
    });
    history.append(firestoreDeny('fs-deny', 1));
    history.append(rtdbOperation('rtdb-deny', 2, 'deny'));
    history.append(storageOperation('st-deny', 3, 'deny'));

    const pad = `/${'x'.repeat(700)}`;
    for (let index = 0; index < 80; index++) {
      history.append(firestoreAllow(`big-fs-${index}`, 10 + index * 3, pad));
      history.append(rtdbOperation(`big-rtdb-${index}`, 11 + index * 3, 'allow', pad));
      history.append(storageOperation(`big-st-${index}`, 12 + index * 3, 'allow', pad));
    }

    const retained = history.snapshot();
    const encoded = new TextEncoder().encode(JSON.stringify(retained)).byteLength;
    expect(encoded).toBeLessThanOrEqual(12_000);

    const ids = new Set(nonGapEvents(retained).map((event) => event.id));
    expect(ids.has('fs-deny')).toBe(true);
    expect(ids.has('rtdb-deny')).toBe(true);
    expect(ids.has('st-deny')).toBe(true);
    assertChronological(retained);

    const gap = findGap(retained);
    expect(gap).toBeDefined();
    expect(gap?.omittedDenials).toBe(0);
    expect((gap?.omittedCount ?? 0)).toBeGreaterThan(0);
  });

  test('overflowing the denial lane by count retains the newest 1,000 denials and increments omittedDenials', () => {
    const history = new EventHistory(OBSERVATION_HISTORY_LIMITS);
    const totalDenials = 1_050;
    const totalAllowed = 9_500;
    let clock = 1;

    for (let index = 0; index < totalDenials; index++) {
      const mod = index % 3;
      if (mod === 0) {
        history.append(firestoreDeny(`deny-${index}`, clock));
      } else if (mod === 1) {
        history.append(rtdbOperation(`deny-${index}`, clock, 'deny'));
      } else {
        history.append(storageOperation(`deny-${index}`, clock, 'deny'));
      }
      clock += 1;
    }

    for (let index = 0; index < totalAllowed; index++) {
      history.append(rtdbOperation(`allow-${index}`, clock, 'allow'));
      clock += 1;
    }

    const retained = history.snapshot();
    const nonGap = nonGapEvents(retained);
    const retainedDenials = nonGap.filter((event) => event.id.startsWith('deny-'));
    const retainedAllowed = nonGap.filter((event) => event.id.startsWith('allow-'));

    expect(retainedDenials).toHaveLength(1_000);
    expect(retainedDenials[0]?.id).toBe('deny-50');
    expect(retainedDenials[999]?.id).toBe('deny-1049');
    expect(retainedAllowed).toHaveLength(9_000);
    assertChronological(retained);

    const gap = findGap(retained);
    expect(gap).toBeDefined();
    expect(gap?.omittedDenials).toBe(50);
    expect(gap?.omittedCount).toBe(totalDenials + totalAllowed - nonGap.length);
  });

  test('overflowing the denial lane byte limit enforces bounds identically in Node and browser runtimes', () => {
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');

    function runByteOverflow(): string {
      const history = new EventHistory({
        maxEvents: 200,
        maxBytes: 6_000,
        maxDenialEvents: 100,
        maxDenialBytes: 2_000,
      });
      const pad = `/${'é'.repeat(80)}`;
      const denialIds: string[] = [];
      for (let index = 0; index < 15; index++) {
        const id = `deny-${index}`;
        denialIds.push(id);
        history.append(rtdbOperation(id, index + 1, 'deny', pad));
      }
      for (let index = 0; index < 10; index++) {
        history.append(rtdbOperation(`allow-${index}`, 100 + index, 'allow'));
      }

      const retained = history.snapshot();
      const totalEncoded = new TextEncoder().encode(JSON.stringify(retained)).byteLength;
      expect(totalEncoded).toBeLessThanOrEqual(6_000);

      const keptIds = new Set(nonGapEvents(retained).map((event) => event.id));
      const missingDenials = denialIds.filter((id) => !keptIds.has(id));
      expect(missingDenials.length).toBeGreaterThan(0);
      expect(keptIds.has('deny-14')).toBe(true);
      expect(keptIds.has('allow-9')).toBe(true);
      assertChronological(retained);

      const gap = findGap(retained);
      expect(gap?.omittedDenials).toBe(missingDenials.length);
      return JSON.stringify(retained);
    }

    const nodeJson = runByteOverflow();
    try {
      Reflect.deleteProperty(globalThis, 'Buffer');
      expect(runByteOverflow()).toBe(nodeJson);
    } finally {
      if (bufferDescriptor !== undefined) {
        Object.defineProperty(globalThis, 'Buffer', bufferDescriptor);
      }
    }
  });

  test('folding upstream history-limit gaps preserves incremental omittedDenials deltas', () => {
    const downstream = new EventHistory({ maxEvents: 100, maxBytes: 100_000 });
    downstream.append({
      kind: 'observation_gap',
      id: 'history-gap',
      at: 10,
      reason: 'history-limit',
      firstEventId: 'e-1',
      lastEventId: 'e-10',
      omittedCount: 10,
      omittedDenials: 2,
    });
    downstream.append({
      kind: 'observation_gap',
      id: 'history-gap',
      at: 10,
      reason: 'history-limit',
      firstEventId: 'e-1',
      lastEventId: 'e-25',
      omittedCount: 25,
      omittedDenials: 5,
    });
    downstream.append(firestoreAllow('ok-1', 26));

    const gap = findGap(downstream.snapshot());
    expect(gap).toMatchObject({
      kind: 'observation_gap',
      reason: 'history-limit',
      omittedCount: 25,
      omittedDenials: 5,
    });

    downstream.clear();
    downstream.append({
      kind: 'observation_gap',
      id: 'history-gap',
      at: 30,
      reason: 'history-limit',
      firstEventId: 'e-30',
      lastEventId: 'e-32',
      omittedCount: 3,
      omittedDenials: 1,
    });
    expect(findGap(downstream.snapshot())).toMatchObject({
      omittedCount: 3,
      omittedDenials: 1,
    });
  });
});

describe('assertCompleteHistory honest gap reporting', () => {
  test('passes when there are no observation gaps', () => {
    expect(() => assertCompleteHistory([firestoreAllow('ok-1', 1)])).not.toThrow();
  });

  test('reports omitted operations, omitted denials, and points to pyric serve denials', () => {
    const history = new EventHistory({
      maxEvents: 10,
      maxBytes: 100_000,
      maxDenialEvents: 2,
      maxDenialBytes: 50_000,
    });
    for (let index = 0; index < 5; index++) {
      history.append(rtdbOperation(`deny-${index}`, index + 1, 'deny'));
    }
    for (let index = 0; index < 20; index++) {
      history.append(rtdbOperation(`allow-${index}`, 10 + index, 'allow'));
    }

    const events = history.snapshot();
    let thrown: unknown;
    try {
      assertCompleteHistory(events);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxError);
    const sandboxError = thrown as SandboxError;
    expect(sandboxError.code).toBe('failed-precondition');
    expect(sandboxError.message).toContain('Cannot replay or verify incomplete observation history');
    expect(sandboxError.message).toContain('15 omitted operations');
    expect(sandboxError.message).toContain('3 omitted denials');
    expect(sandboxError.message).toContain('pyric serve denials');
  });

  test('reports zero omitted denials honestly when only allowed traffic was evicted', () => {
    const events: SandboxEvent[] = [
      {
        kind: 'observation_gap',
        id: 'history-gap',
        at: 1,
        reason: 'history-limit',
        firstEventId: 'e-1',
        lastEventId: 'e-501',
        omittedCount: 501,
        omittedDenials: 0,
      },
    ];
    expect(() => assertCompleteHistory(events)).toThrow(
      'Cannot replay or verify incomplete observation history (501 omitted operations, 0 omitted denials). Inspect retained denials with `pyric serve denials` or capture a fresh session without observation gaps.',
    );
  });

  test('uses singular phrasing for single omissions and handles gaps without denial counts', () => {
    const singular: SandboxEvent[] = [
      {
        kind: 'observation_gap',
        id: 'history-gap',
        at: 1,
        reason: 'history-limit',
        firstEventId: 'e-1',
        lastEventId: 'e-1',
        omittedCount: 1,
        omittedDenials: 1,
      },
    ];
    expect(() => assertCompleteHistory(singular)).toThrow('1 omitted operation, 1 omitted denial');
    expect(() => assertCompleteHistory(singular)).toThrow('pyric serve denials');

    const frameGap: SandboxEvent[] = [
      {
        kind: 'observation_gap',
        id: 'frame-gap',
        at: 1,
        reason: 'frame-limit',
        firstEventId: 'e-1',
        lastEventId: 'e-4',
        omittedCount: 4,
      },
    ];
    expect(() => assertCompleteHistory(frameGap)).toThrow('4 omitted operations');
    expect(() => assertCompleteHistory(frameGap)).toThrow('pyric serve denials');
  });
});
