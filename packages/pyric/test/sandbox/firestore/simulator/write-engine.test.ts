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

function createEngine(rulesSource = DEFAULT_OPEN_RULES) {
  let state: DocStore = new LocalState();
  const notified: string[][] = [];
  const engine = new WriteEngine(
    {
      get state() { return state; },
      notifyListenersForPaths(paths) { notified.push([...paths]); },
    },
    new RulesState(rulesSource),
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

  test('createWithAutoId mints a path and uses the ordinary write fan-out', () => {
    const harness = createEngine();

    const { path, result } = harness.engine.createWithAutoId(
      'notes',
      { title: 'new' },
      null,
    );

    expect(path).toMatch(/^notes\/[A-Za-z0-9]{20}$/);
    expect(result.allowed).toBe(true);
    expect(harness.state.get(path)).toEqual({ title: 'new' });
    expect(harness.notified).toEqual([[path]]);
  });

  test('batch commits atomically and fans out once for the touched set', () => {
    const harness = createEngine();

    const result = harness.engine.batch([
      { method: 'create', path: 'notes/a', data: { value: 1 } },
      { method: 'create', path: 'notes/b', data: { value: 2 } },
    ], null);

    expect(result.allowed).toBe(true);
    expect(harness.state.get('notes/a')).toEqual({ value: 1 });
    expect(harness.state.get('notes/b')).toEqual({ value: 2 });
    expect(harness.notified).toEqual([['notes/a', 'notes/b']]);
  });

  test('batch denial rolls back every operation without fan-out', () => {
    const harness = createEngine(DEFAULT_OPEN_RULES.replace('if true', 'if false'));

    const result = harness.engine.batch([
      { method: 'create', path: 'notes/a', data: { value: 1 } },
      { method: 'create', path: 'notes/b', data: { value: 2 } },
    ], null);

    expect(result.allowed).toBe(false);
    expect(harness.state.get('notes/a')).toBeNull();
    expect(harness.state.get('notes/b')).toBeNull();
    expect(harness.notified).toEqual([]);
  });

  test('transaction commits a synchronous callback result and write', () => {
    const harness = createEngine();

    const result = harness.engine.transaction((transaction) => {
      transaction.create('notes/sync', { value: 1 });
      return 'sync-result';
    }, { auth: null });

    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe('sync-result');
    expect(harness.state.get('notes/sync')).toEqual({ value: 1 });
    expect(harness.notified).toEqual([['notes/sync']]);
  });

  test('transaction awaits an asynchronous callback before commit', async () => {
    const harness = createEngine();

    const result = await harness.engine.transaction(async (transaction) => {
      await Promise.resolve();
      transaction.create('notes/async', { value: 2 });
      return 'async-result';
    }, { auth: null });

    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe('async-result');
    expect(harness.state.get('notes/async')).toEqual({ value: 2 });
  });

  test('transaction callback errors propagate unchanged and abort queued writes', () => {
    const harness = createEngine();
    const expected = new Error('stop');
    let caught: unknown;

    try {
      harness.engine.transaction((transaction) => {
        transaction.create('notes/aborted', { value: 3 });
        throw expected;
      }, { auth: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(expected);
    expect(harness.state.get('notes/aborted')).toBeNull();
    expect(harness.notified).toEqual([]);
  });
});
