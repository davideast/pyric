import { describe, expect, test } from 'bun:test';
import { EventLog, type AgentEvent } from '../../../../src/firestore/sandbox/event-log.js';
import { LocalEnvironment } from '../../../../src/firestore/sandbox/local-environment.js';
import { createFirestoreSimulatorTools } from '../../../../src/rules/simulator-tools-impl.js';

function write(value: number, padding = ''): Omit<AgentEvent, 'id' | 'timestamp'> {
  return {
    type: 'single', method: 'set', path: 'load/replaced', auth: null,
    allowed: true, data: { value, padding }, priorDocs: { 'load/replaced': null }, debugMessages: [],
  };
}

describe('I16 engine event retention', () => {
  test('four write cycles stay within the default count and byte budget', () => {
    const env = new LocalEnvironment();
    try {
      for (const cycle of [0, 1, 2, 3]) {
        for (let index = 0; index < 192; index++) {
          const padding = Buffer.alloc(256 * 1024, 65 + cycle).toString();
          expect(env.execute({ method: 'set', path: 'load/replaced', data: { padding, cycle, index } }).allowed).toBe(true);
        }
        const events = env.getEvents();
        expect(events.length).toBeLessThan(192);
        const retention = env.getEventRetention();
        expect(retention.retainedEvents).toBeLessThanOrEqual(10_000);
        expect(retention.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(retention.retainedBytes).toBeGreaterThan(0);
        expect(retention.omittedCount + events.length).toBe((cycle + 1) * 192);
        expect(events.at(-1)?.data).toMatchObject({ cycle, index: 191 });
      }
    } finally { env.dispose(); }
  });

  test('count eviction keeps the newest events in order and records omissions', () => {
    const log = new EventLog(undefined, { maxEvents: 3, maxBytes: 100_000 });
    for (let index = 1; index <= 5; index++) log.append(write(index));
    expect(log.getEvents().map(event => event.id)).toEqual([3, 4, 5]);
    expect(log.getRetention()).toMatchObject({ retainedEvents: 3, omittedCount: 2 });
    expect(log.popLastWrite()?.id).toBe(5);
    expect(log.popLastWrite()?.id).toBe(4);
    expect(log.popLastWrite()?.id).toBe(3);
    expect(log.popLastWrite()).toBeNull();
    expect(log.getRetention()).toMatchObject({ retainedEvents: 3, omittedCount: 2 });
    expect(log.popLastUndo()?.id).toBe(3);
    expect(log.popLastUndo()?.id).toBe(4);
    expect(log.popLastUndo()?.id).toBe(5);
    expect(log.popLastUndo()).toBeNull();
    expect(log.getRetention()).toEqual({ retainedEvents: 0, retainedBytes: 0, omittedCount: 2 });
  });

  test('events and undone events share one budget, including when redo is preserved', () => {
    const log = new EventLog(undefined, { maxEvents: 3, maxBytes: 100_000 });
    for (let index = 1; index <= 3; index++) log.append(write(index));
    log.popLastWrite();
    log.popLastWrite();
    log.append(write(4), true);
    log.append(write(5), true);
    expect(log.getEvents().map(event => event.id)).toEqual([4, 5]);
    expect(log.getRetention()).toMatchObject({ retainedEvents: 3, omittedCount: 2 });
    expect(log.popLastUndo()?.id).toBe(3);
    expect(log.popLastUndo()).toBeNull();
    log.clear();
    expect(log.getRetention()).toEqual({ retainedEvents: 0, retainedBytes: 0, omittedCount: 0 });
  });

  test('an oversized event leaves no undo path across the omitted write', () => {
    const log = new EventLog(undefined, { maxEvents: 10, maxBytes: 1_000 });
    log.append(write(1));
    log.append(write(2, 'x'.repeat(2_000)));
    expect(log.getEvents()).toEqual([]);
    expect(log.popLastWrite()).toBeNull();
    expect(log.getRetention()).toEqual({ retainedEvents: 0, retainedBytes: 0, omittedCount: 2 });
    log.append(write(3));
    expect(log.getEvents().map(event => event.data?.value)).toEqual([3]);
    expect(log.getRetention().retainedBytes).toBeLessThanOrEqual(1_000);
  });

  test('undo and redo restore every retained write in the real engine', () => {
    const env = new LocalEnvironment();
    try {
      for (let value = 0; value < 32; value++) {
        env.execute({ method: 'set', path: 'load/replaced', data: { value, padding: 'x'.repeat(256 * 1024) } });
      }
      const retained = env.getEvents();
      expect(retained.length).toBeLessThan(32);
      const omitted = env.getEventRetention().omittedCount;
      for (const event of [...retained].reverse()) expect(env.undo()?.id).toBe(event.id);
      expect(env.undo()).toBeNull();
      for (const event of retained) {
        expect(env.redo()?.event?.data).toEqual(event.data);
        const retention = env.getEventRetention();
        expect(retention.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(retention.omittedCount).toBe(omitted);
      }
      expect(env.redo()).toBeNull();
      expect(env.undo()?.data?.value).toBe(31);
    } finally { env.dispose(); }
  });

  test('the events tool reports trimming and does not promise an unlimited log', async () => {
    const env = new LocalEnvironment();
    try {
      env.execute({ method: 'set', path: 'load/replaced', data: { padding: 'x'.repeat(9 * 1024 * 1024) } });
      const tools = createFirestoreSimulatorTools({ resolveSandbox: () => env });
      const tool = tools.find(tool => tool.name === 'firestore_simulator_events');
      expect(tool).toBeDefined();
      expect(tool!.description).not.toContain('every event');
      const result = await tool!.execute({});
      expect(result.data).toMatchObject({ events: [], omittedCount: 1 });
      expect(result.summary).toContain('1 omitted');
    } finally { env.dispose(); }
  });
});
