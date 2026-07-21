import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { EventLog } from '../../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../../src/firestore/sandbox/event-bus.js';
import {
  LocalState,
  type DocStore,
} from '../../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../../src/firestore/sandbox/rules-state.js';
import { TriggerScope } from '../../../../src/firestore/sandbox/trigger-scope.js';
import { WriteEngine } from '../../../../src/firestore/sandbox/write-engine.js';
import { buildRulesTestCase } from '../../../../src/firestore/sandbox/rules-test-case.js';

function createEngine() {
  let state: DocStore = new LocalState();
  const notified: string[][] = [];
  const engine = new WriteEngine(
    {
      get state() { return state; },
      notifyListenersForPaths(paths) { notified.push([...paths]); },
    },
    new RulesState(DEFAULT_OPEN_RULES),
    new SimulateFirestoreRulesHandler(),
    new EventLog(),
    new FirestoreEventBus(),
    new TriggerScope(),
  );
  return {
    engine,
    notified,
    replaceState(next: DocStore) { state = next; },
    get state() { return state; },
  };
}

describe('WriteEngine host seam', () => {
  test('uses the current keyspace after LocalEnvironment-style state replacement', () => {
    const harness = createEngine();
    const replacement = new LocalState();
    harness.replaceState(replacement);

    const error = harness.engine.applyWrite('create', 'notes/new', { title: 'new' });

    expect(error).toBeNull();
    expect(replacement.get('notes/new')).toEqual({ title: 'new' });
  });

  test('owns successful write fan-out while exposing the facade result shape', () => {
    const harness = createEngine();

    const result = harness.engine.execute({
      method: 'create',
      path: 'notes/new',
      auth: null,
      data: { title: 'new' },
    });

    expect(result.allowed).toBe(true);
    expect(harness.state.get('notes/new')).toEqual({ title: 'new' });
    expect(harness.notified).toEqual([['notes/new']]);
  });

  test('projects set as create or update from the live pre-write state', () => {
    const harness = createEngine();
    expect(buildRulesTestCase(harness.state, {
      method: 'set', path: 'notes/n1', auth: null, data: { value: 1 },
    }).method).toBe('create');

    harness.state.set('notes/n1', { value: 0 });
    expect(buildRulesTestCase(harness.state, {
      method: 'set', path: 'notes/n1', auth: null, data: { value: 1 },
    }).method).toBe('update');
  });
});
