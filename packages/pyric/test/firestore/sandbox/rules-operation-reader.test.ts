import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { RulesOperationReader } from '../../../src/firestore/sandbox/rules-operation-reader.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';

function createReader(rules = DEFAULT_OPEN_RULES) {
  const state = new LocalState({ 'notes/n1': { value: 1 } });
  const eventLog = new EventLog();
  const events = new FirestoreEventBus();
  return {
    reader: new RulesOperationReader(
      events,
      new RulesState(rules),
      new SimulateFirestoreRulesHandler(),
      { state },
      eventLog,
    ),
    eventLog,
    events,
  };
}

describe('RulesOperationReader', () => {
  test('returns rule-visible data and records the read', () => {
    const { reader, eventLog } = createReader();

    const result = reader.execute({ method: 'get', path: 'notes/n1', auth: null });

    expect(result.allowed).toBe(true);
    expect(result.data).toEqual({ value: 1 });
    expect(eventLog.size()).toBe(1);
  });

  test('emits a denial when rules reject the read', () => {
    const { reader, events } = createReader(DEFAULT_OPEN_RULES.replace('if true', 'if false'));
    const denials: unknown[] = [];
    events.denial.subscribe((error) => denials.push(error));

    const result = reader.execute({ method: 'get', path: 'notes/n1', auth: null });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(denials).toHaveLength(1);
  });
});
