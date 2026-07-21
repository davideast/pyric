import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { AtomicWriteRuntime } from '../../../src/firestore/sandbox/atomic-write-runtime.js';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';

describe('AtomicWriteRuntime', () => {
  test('shares live state snapshots and trigger-scoped notification policy', () => {
    const state = new LocalState({ 'notes/a': { value: 1 } });
    const notifications: string[][] = [];
    const runtime = new AtomicWriteRuntime(
      { state, notifyListenersForPaths: (paths) => notifications.push([...paths]) },
      new RulesState(DEFAULT_OPEN_RULES),
      new SimulateFirestoreRulesHandler(),
      new EventLog(),
      new FirestoreEventBus(),
      new TriggerScope(),
    );

    expect(runtime.capturePriors(['notes/a', 'notes/missing'])).toEqual({
      'notes/a': { value: 1 },
      'notes/missing': null,
    });

    runtime.notify('batch', 'notes/a', new Set(['notes/a']));
    expect(notifications).toEqual([['notes/a']]);
  });
});
