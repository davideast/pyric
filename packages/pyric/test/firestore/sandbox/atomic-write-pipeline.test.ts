import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import {
  AtomicWritePipeline,
  type AtomicOrigin,
} from '../../../src/firestore/sandbox/atomic-write-pipeline.js';
import { AtomicWriteRuntime } from '../../../src/firestore/sandbox/atomic-write-runtime.js';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState, type DocStore } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';

function createHarness(rules = DEFAULT_OPEN_RULES) {
  let state: DocStore = new LocalState();
  const events = new FirestoreEventBus();
  const triggerScope = new TriggerScope();
  const notifications: Array<{ paths: string[]; trigger: unknown }> = [];
  const runtime = new AtomicWriteRuntime(
    {
      get state() { return state; },
      notifyListenersForPaths(paths) {
        notifications.push({ paths: [...paths], trigger: triggerScope.current() });
      },
    },
    new RulesState(rules),
    new SimulateFirestoreRulesHandler(),
    new EventLog(),
    events,
    triggerScope,
  );
  return {
    pipeline: new AtomicWritePipeline(runtime),
    events,
    notifications,
    replaceState(next: DocStore) { state = next; },
    get state() { return state; },
  };
}

function execute(
  harness: ReturnType<typeof createHarness>,
  origin: AtomicOrigin,
) {
  const path = `notes/${origin}`;
  const prepared = harness.pipeline.prepare([
    {
      method: 'create',
      ruleMethod: 'create',
      path,
      data: { value: 1 },
      preData: { value: 1 },
    },
  ], {
    origin,
    groupId: `${origin}-1`,
    auth: null,
    snapshot: { [path]: null },
  });
  if (!('resolvedOps' in prepared)) throw new Error(prepared.message);
  const decision = harness.pipeline.evaluateAndApply(prepared);
  harness.pipeline.emitAndNotify(decision);
  return decision;
}

describe('AtomicWritePipeline', () => {
  test.each(['batch', 'transaction'] as const)(
    'uses the same commit, event, and trigger policy for %s writes',
    (origin) => {
      const harness = createHarness();
      const requests: unknown[] = [];
      const writes: unknown[] = [];
      harness.events.request.subscribe((event) => requests.push(event));
      harness.events.write.subscribe((event) => writes.push(event));

      const decision = execute(harness, origin);

      expect(decision.allowed).toBe(true);
      expect(requests).toHaveLength(1);
      expect(writes).toHaveLength(1);
      expect(harness.notifications).toEqual([{
        paths: [`notes/${origin}`],
        trigger: { method: origin, path: `notes/${origin}` },
      }]);
    },
  );

  test('rolls every write back when shared rule evaluation denies one', () => {
    const harness = createHarness(DEFAULT_OPEN_RULES.replace('if true', 'if false'));
    const prepared = harness.pipeline.prepare([
      { method: 'create', ruleMethod: 'create', path: 'notes/a', data: { n: 1 } },
      { method: 'create', ruleMethod: 'create', path: 'notes/b', data: { n: 2 } },
    ], {
      origin: 'batch', groupId: 'batch-deny', auth: null,
      snapshot: { 'notes/a': null, 'notes/b': null },
    });
    if (!('resolvedOps' in prepared)) throw new Error(prepared.message);

    const decision = harness.pipeline.evaluateAndApply(prepared);

    expect(decision.allowed).toBe(false);
    expect(harness.state.get('notes/a')).toBeNull();
    expect(harness.state.get('notes/b')).toBeNull();
  });

  test('maps structural failures after rules pass without mutating state', () => {
    const harness = createHarness();
    harness.state.set('notes/existing', { value: 1 });
    const prepared = harness.pipeline.prepare([
      { method: 'create', ruleMethod: 'create', path: 'notes/existing', data: { value: 2 } },
    ], {
      origin: 'transaction', groupId: 'tx-structural', auth: null,
      snapshot: { 'notes/existing': { value: 1 } },
    });
    if (!('resolvedOps' in prepared)) throw new Error(prepared.message);

    const decision = harness.pipeline.evaluateAndApply(prepared);

    expect(decision.allowed).toBe(false);
    expect(decision.structuralError?.code).toBe('already-exists');
    expect(harness.state.get('notes/existing')).toEqual({ value: 1 });
  });

  test('resolves the live host state after replacement', () => {
    const harness = createHarness();
    const replacement = new LocalState();
    harness.replaceState(replacement);

    expect(execute(harness, 'batch').allowed).toBe(true);
    expect(replacement.get('notes/batch')).toEqual({ value: 1 });
  });
});
