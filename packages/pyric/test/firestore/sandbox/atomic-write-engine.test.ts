import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { AtomicWriteEngine } from '../../../src/firestore/sandbox/atomic-write-engine.js';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';
import { WriteRuntime } from '../../../src/firestore/sandbox/write-runtime.js';

describe('AtomicWriteEngine', () => {
  test('keeps batch and transaction entry points behind one coordinator', () => {
    const state = new LocalState();
    const engine = new AtomicWriteEngine(new WriteRuntime(
      { state, notifyListenersForPaths: () => {} },
      new RulesState(DEFAULT_OPEN_RULES),
      new SimulateFirestoreRulesHandler(),
      new EventLog(),
      new FirestoreEventBus(),
      new TriggerScope(),
    ));

    expect(engine.batch([
      { method: 'create', path: 'notes/batch', data: { value: 1 } },
    ], null).allowed).toBe(true);
    const txResult = engine.transaction((tx) => {
      tx.create('notes/transaction', { value: 2 });
      return 'done';
    }, { auth: null });

    expect(txResult.allowed).toBe(true);
    expect(state.get('notes/batch')).toEqual({ value: 1 });
    expect(state.get('notes/transaction')).toEqual({ value: 2 });
  });
});
