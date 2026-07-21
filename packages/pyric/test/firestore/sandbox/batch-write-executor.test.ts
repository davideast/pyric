import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { WriteRuntime } from '../../../src/firestore/sandbox/write-runtime.js';
import { BatchWriteExecutor } from '../../../src/firestore/sandbox/batch-write-executor.js';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';
import { KEEP, registerConverter } from '../../../src/firestore/sandbox/value-resolver.js';

describe('BatchWriteExecutor', () => {
  test('commits all writes and notifies their touched paths once', () => {
    const state = new LocalState();
    const notifications: string[][] = [];
    const runtime = new WriteRuntime(
      { state, notifyListenersForPaths: (paths) => notifications.push([...paths]) },
      new RulesState(DEFAULT_OPEN_RULES),
      new SimulateFirestoreRulesHandler(),
      new EventLog(),
      new FirestoreEventBus(),
      new TriggerScope(),
    );

    const result = new BatchWriteExecutor(runtime).batch([
      { method: 'create', path: 'notes/a', data: { value: 1 } },
      { method: 'create', path: 'notes/b', data: { value: 2 } },
    ], null);

    expect(result.allowed).toBe(true);
    expect(state.get('notes/a')).toEqual({ value: 1 });
    expect(state.get('notes/b')).toEqual({ value: 2 });
    expect(notifications).toEqual([['notes/a', 'notes/b']]);
  });

  test('records resolution failure before request emission and preserves duplicate-path errors', () => {
    registerConverter({
      name: 'batch-executor-ordering-probe',
      convert(value) {
        if ((value as { orderingProbe?: unknown })?.orderingProbe === true) {
          throw new Error('probe failed');
        }
        return KEEP;
      },
    });
    const state = new LocalState();
    const events = new FirestoreEventBus();
    const eventLog = new EventLog();
    const observedHistorySizes: number[] = [];
    events.request.subscribe(() => observedHistorySizes.push(eventLog.size()));
    const runtime = new WriteRuntime(
      { state, notifyListenersForPaths: () => {} },
      new RulesState(DEFAULT_OPEN_RULES),
      new SimulateFirestoreRulesHandler(),
      eventLog,
      events,
      new TriggerScope(),
    );

    const result = new BatchWriteExecutor(runtime).batch([
      { method: 'create', path: 'notes/same', data: { value: 1 } },
      { method: 'update', path: 'notes/same', data: { value: { orderingProbe: true } } },
    ], null);

    expect(observedHistorySizes).toEqual([1]);
    expect(result.results.map((entry) => entry.error?.code)).toEqual([
      'invalid-argument',
      'invalid-argument',
    ]);
  });
});
