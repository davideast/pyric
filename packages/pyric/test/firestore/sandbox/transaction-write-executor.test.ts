import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { WriteRuntime } from '../../../src/firestore/sandbox/write-runtime.js';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { TransactionWriteExecutor } from '../../../src/firestore/sandbox/transaction-write-executor.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';

describe('TransactionWriteExecutor', () => {
  test('commits a callback result and its queued writes', () => {
    const state = new LocalState();
    const runtime = new WriteRuntime(
      { state, notifyListenersForPaths: () => {} },
      new RulesState(DEFAULT_OPEN_RULES),
      new SimulateFirestoreRulesHandler(),
      new EventLog(),
      new FirestoreEventBus(),
      new TriggerScope(),
    );

    const result = new TransactionWriteExecutor(runtime).transaction((tx) => {
      tx.create('notes/a', { value: 1 });
      return 'done';
    }, { auth: null });

    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe('done');
    expect(state.get('notes/a')).toEqual({ value: 1 });
  });
});
