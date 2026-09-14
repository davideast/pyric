import { describe, expect, it } from 'bun:test';
import { createSdkActivityJournal } from 'pyric/sandbox/internal';
import { activityDisplayTarget, createActivityHistory } from '../../../src/serve/runtime/activity-history.js';

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
