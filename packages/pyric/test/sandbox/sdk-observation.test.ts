import { describe, expect, it } from 'bun:test';
import { createSdkActivityJournal } from '../../src/sandbox/internal/sdk-activity.js';
import { observationService, type SdkObservation } from '../../src/sandbox/internal/sdk-observation.js';

const source = { service: 'database' as const, target: '/items', key: 'instance/items/query' };

describe('SDK observation contract', () => {
  it('normalizes service identity without conflating apps, sources or invocations', () => {
    const journal = createSdkActivityJournal();
    const observed: SdkObservation[] = [];
    journal.observe(event => observed.push(event));
    const app = {};
    journal.begin({ app, source, method: 'get', kind: 'operation' });
    journal.begin({ app, source, method: 'onValue', kind: 'subscription' });
    journal.begin({ app, source: { ...source, key: 'instance/items/other-query' }, method: 'get', kind: 'operation' });
    journal.begin({ app: {}, source, method: 'get', kind: 'operation' });
    expect(observed.map(event => event.service)).toEqual(['rtdb', 'rtdb', 'rtdb', 'rtdb']);
    expect(observed[0].sourceId).toBe(observed[1].sourceId);
    expect(observed[0].activityId).not.toBe(observed[1].activityId);
    expect(observed[0].sourceId).not.toBe(observed[2].sourceId);
    expect(observed[0].appId).not.toBe(observed[3].appId);
    expect(observed[1].method).toBe('onValue');
    expect(observationService('firestore')).toBe('firestore');
    expect(observationService('storage')).toBe('storage');
    expect(observationService('rtdb')).toBe('rtdb');
    journal.dispose();
  });

  it('separates calls, repeated deliveries and cleanup, excluding transport and host mirrors', () => {
    const journal = createSdkActivityJournal();
    const observed: SdkObservation[] = [];
    journal.observe(event => observed.push(event));
    const input = { app: {}, source, method: 'onValue', kind: 'subscription' as const };
    const listener = journal.begin(input);
    listener.transport('bridge-1');
    journal.silence(() => journal.begin(input).delivered());
    listener.delivered();
    listener.delivered();
    listener.close();
    listener.delivered();
    listener.close();
    journal.dispose();
    expect(observed.map(event => event.phase)).toEqual(['start', 'delivery', 'delivery', 'end', 'remove']);
    expect(observed.map(event => event.deliveryNumber)).toEqual([0, 1, 2, 2, 2]);
    expect(new Set(observed.map(event => event.id)).size).toBe(5);
    expect(observed.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(observed[3].status).toBe('closed');
  });

  it('records denied attempts without invented deliveries and emits each read result once', () => {
    const journal = createSdkActivityJournal();
    const observed: SdkObservation[] = [];
    journal.observe(event => observed.push(event));
    const input = { app: {}, source, method: 'get', kind: 'operation' as const };
    journal.begin(input).fail();
    const read = journal.begin(input);
    read.delivered();
    read.delivered();
    read.complete();
    expect(observed.map(event => [event.phase, event.status])).toEqual([
      ['start', 'pending'], ['end', 'failed'],
      ['start', 'pending'], ['delivery', 'pending'], ['end', 'completed'],
    ]);
    journal.dispose();
  });

  it('uses independent clocks and continues live observation after retained records expire', () => {
    let wall = 1000;
    let monotonic = 10;
    const journal = createSdkActivityJournal({ now: () => wall, monotonicNow: () => monotonic, retentionMs: 250 });
    const observed: SdkObservation[] = [];
    journal.observe(event => observed.push(event));
    const input = { app: {}, source, method: 'get', kind: 'operation' as const };
    const call = journal.begin(input);
    wall = 500;
    monotonic = 20;
    call.fail();
    expect(observed.map(event => [event.at, event.monotonicAt])).toEqual([[1000, 10], [500, 20]]);
    wall = 1000;
    expect(journal.records()).toHaveLength(0);
    journal.begin(input);
    expect(observed.filter(event => event.phase === 'start')).toHaveLength(2);
    expect(observed[0].sourceId).not.toBe(observed.at(-1)!.sourceId);
    journal.dispose();
  });

  it('omits private metadata, isolates observers and releases them on disposal', () => {
    const journal = createSdkActivityJournal();
    const observed: SdkObservation[] = [];
    journal.observe(() => { throw new Error('observer failure'); });
    const unsubscribe = journal.observe(event => observed.push(event));
    journal.begin({ app: {}, source: { ...source, key: 'secret', target: '/private' },
      method: 'get', kind: 'operation', owners: [{ kind: 'tag', name: 'private owner' }] });
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(JSON.stringify(observed)).not.toContain('private');
    expect(JSON.stringify(observed)).not.toContain('secret');
    unsubscribe();
    journal.dispose();
    journal.observe(event => observed.push(event));
    journal.begin({ app: {}, source, method: 'get', kind: 'operation' });
    expect(observed).toHaveLength(1);
  });

  it('delivers in order when another observer synchronously starts a call', () => {
    const journal = createSdkActivityJournal();
    const observed: SdkObservation[] = [];
    const input = { app: {}, source, method: 'get', kind: 'operation' as const };
    journal.observe(event => {
      if (event.sequence === 1) journal.begin(input).complete();
    });
    journal.observe(event => observed.push(event));
    journal.begin(input).fail();
    expect(observed.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(observed.map(event => event.phase)).toEqual(['start', 'start', 'end', 'end']);
    journal.dispose();
  });
});
