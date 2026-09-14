import { describe, expect, it } from 'bun:test';
import { createSdkActivityJournal } from 'pyric/sandbox/internal';
import { activityDisplayTarget, activityOccurrences, createActivityHistory } from '../../../src/serve/runtime/activity-history.js';

describe('activity history', () => {
  it('distinguishes repeated equal reads, deliveries and shared commits', () => {
    let now = 0;
    const journal = createSdkActivityJournal({ now: () => now });
    const history = createActivityHistory({ now: () => now });
    journal.subscribe(history.record);
    const app = {};
    for (let i = 0; i < 3; i++) {
      const call = journal.begin({ app, source: { service: 'firestore', target: 'items', key: 'items' }, method: 'getDocs', kind: 'operation' });
      call.delivered(); call.complete();
      const record = journal.records().find(record => record.id === call.id)!;
      history.rendered(record, 1); history.rendered(record, 1);
    }
    expect(history.counts()).toEqual({ calls: 3, deliveries: 3, commits: 1, partial: false });
    expect(history.snapshot().entries.filter(entry => entry.phase === 'render')).toHaveLength(3);
    now = 30_001;
    expect(history.counts().calls).toBe(0);
    expect(history.counts(undefined, Infinity).calls).toBe(3);
    journal.dispose();
  });
  it('bounds metadata, exposes truncation, and clearing leaves live registrations intact', () => {
    const journal = createSdkActivityJournal();
    const history = createActivityHistory({ limit: 3 });
    journal.subscribe(history.record);
    const call = journal.begin({ app: {}, source: { service: 'database', target: '/presence?token=secret', key: 'private' }, method: 'onValue', kind: 'subscription', owners: [{ kind: 'tag', name: 'private owner' }] });
    for (let i = 0; i < 5; i++) call.delivered();
    expect(history.snapshot().entries).toHaveLength(3);
    expect(history.snapshot().discarded).toBe(3);
    expect(JSON.stringify(history.snapshot())).not.toContain('secret');
    expect(JSON.stringify(history.snapshot())).not.toContain('private owner');
    history.clear();
    expect(journal.records()[0].status).toBe('active');
    call.delivered();
    expect(history.counts()).toEqual({ calls: 0, deliveries: 1, commits: 0, partial: false });
    journal.dispose();
  });
  it('removes URL credentials, fragments and query values', () => {
    expect(activityDisplayTarget('https://user:password@example.com/items?token=secret#secret')).toBe('https://example.com/items');
  });
});

it('keeps A/B/A shared-commit membership and returns the correct existing event', () => {
  const journal = createSdkActivityJournal();
  const history = createActivityHistory();
  journal.subscribe(history.record);
  const app = {};
  const a = journal.begin({ app, source: { service: 'database', target: '/a', key: 'a' }, kind: 'subscription', method: 'onValue' });
  const b = journal.begin({ app, source: { service: 'database', target: '/b', key: 'b' }, kind: 'subscription', method: 'onValue' });
  a.delivered(); b.delivered(); a.delivered();
  const [recordA, recordB] = journal.records();
  const renderA = history.rendered(recordA, 1);
  const renderB = history.rendered(recordB, 1);
  expect(history.rendered(recordA, 1)).toBe(renderA);
  const deliveries = history.snapshot().entries.filter(entry => entry.phase === 'delivery');
  expect(history.association(deliveries[0].sequence)).toBe(renderA);
  expect(history.association(deliveries[1].sequence)).toBe(renderB);
  expect(history.association(deliveries[2].sequence)).toBe(renderA);
  expect(history.counts()).toEqual({ calls: 2, deliveries: 3, commits: 1, partial: false });
  journal.dispose();
});


it('shows one read occurrence and one row per subscription update, merging render stages', () => {
  const journal = createSdkActivityJournal();
  const history = createActivityHistory(); journal.subscribe(history.record);
  const app = {};
  const read = journal.begin({ app, source: { service: 'firestore', target: 'items', key: 'items' }, method: 'getDocs', kind: 'operation' });
  read.delivered(); read.complete(); history.rendered(journal.records()[0], 1);
  let occurrences = activityOccurrences(history.snapshot().entries);
  expect(occurrences).toHaveLength(1);
  expect(occurrences[0]).toMatchObject({ label: 'Read collection', outcome: 'Rendered', registration: null });
  const subscription = journal.begin({ app, source: { service: 'database', target: '/items', key: 'items' }, method: 'onValue', kind: 'subscription' });
  subscription.delivered(); subscription.delivered(); history.rendered(journal.records()[1], 2);
  occurrences = activityOccurrences(history.snapshot().entries);
  expect(occurrences.filter(item => item.registration === 1)).toHaveLength(2);
  expect(occurrences.every(item => item.outcome === 'Rendered')).toBe(true);
  const failed = journal.begin({ app, source: { service: 'firestore', target: 'private', key: 'private' }, method: 'getDoc', kind: 'operation' });
  failed.fail();
  expect(activityOccurrences(history.snapshot().entries)[0].outcome).toBe('Failed');
  const renderOnly = history.snapshot().entries.filter(entry => entry.phase === 'render');
  expect(activityOccurrences(renderOnly).every(item => item.outcome === 'Rendered')).toBe(true);
  journal.dispose();
});

it('keeps subscription display numbers stable across eviction and clearing', () => {
  const journal = createSdkActivityJournal();
  const history = createActivityHistory({ limit: 2 }); journal.subscribe(history.record);
  const input = { app: {}, source: { service: 'database' as const, target: '/items', key: 'items' }, method: 'onValue', kind: 'subscription' as const };
  const a = journal.begin(input); const b = journal.begin(input);
  a.delivered(); b.delivered(); a.delivered();
  const numbers = () => new Map(activityOccurrences(history.snapshot().entries).map(item => [item.event.activityId, item.registration]));
  expect(numbers().get(a.id)).toBe(1);
  expect(numbers().get(b.id)).toBe(2);
  history.clear(); b.delivered(); a.delivered();
  expect(numbers().get(a.id)).toBe(1);
  expect(numbers().get(b.id)).toBe(2);
  journal.dispose(); history.dispose();
});
