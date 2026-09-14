import { expect, it } from 'bun:test';
import type { ActivityHistoryEntry } from '../../../src/serve/runtime/activity-history.js';
import { activityOccurrences } from '../../../src/serve/runtime/activity-occurrences.js';
import { presentActivityOccurrence } from '../../../src/serve/runtime/activity-occurrence-presentation.js';

function entry(sequence: number, changes: Partial<ActivityHistoryEntry> = {}): ActivityHistoryEntry {
  return {
    sequence, at: sequence, activityId: 'read', appId: 'app', sourceId: 'items',
    service: 'firestore', target: 'items', method: 'getDocs', kind: 'operation',
    phase: 'delivery', status: 'completed', ...changes,
  };
}

it.each([
  { name: 'pending read', entries: [entry(1, { phase: 'start', status: 'pending' })], kind: 'operation', render: 'unavailable', outcome: 'Pending' },
  { name: 'delivered read', entries: [entry(1)], kind: 'operation', render: 'not-observed', outcome: 'No render observed' },
  { name: 'render survives delivery eviction', entries: [entry(3, { phase: 'render', deliverySequences: [2] })], kind: 'operation', render: 'observed', outcome: 'Rendered' },
  { name: 'terminal failure survives start eviction', entries: [entry(3, { phase: 'end', status: 'failed' })], kind: 'operation', render: 'unavailable', outcome: 'Failed' },
  { name: 'subscription awaits first delivery', entries: [entry(1, { kind: 'subscription', phase: 'start', status: 'active' })], kind: 'subscription-state', render: 'unavailable', outcome: 'Listening' },
  { name: 'subscription stops before delivery', entries: [entry(2, { kind: 'subscription', phase: 'end', status: 'closed' })], kind: 'subscription-state', render: 'unavailable', outcome: 'Stopped' },
  { name: 'subscription render survives eviction', entries: [entry(3, { kind: 'subscription', phase: 'render', status: 'active', deliverySequences: [2] })], kind: 'subscription-delivery', render: 'observed', outcome: 'Rendered' },
])('$name', ({ entries, kind, render, outcome }) => {
  const results = activityOccurrences(entries);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ kind, render });
  expect(presentActivityOccurrence(results[0]).outcome).toBe(outcome);
});

it('keeps successful subscription deliveries separate from a later failure', () => {
  const subscription = { kind: 'subscription', status: 'active', method: 'onSnapshot', subscriptionNumber: 4 } as const;
  const entries = [
    entry(1, subscription),
    entry(2, { ...subscription, phase: 'render', deliverySequences: [1] }),
    entry(3, { ...subscription, phase: 'end', status: 'failed' }),
  ];
  const results = activityOccurrences(entries);
  expect(results.map(result => [result.kind, result.render, result.registration])).toEqual([
    ['subscription-failure', 'unavailable', 4], ['subscription-delivery', 'observed', 4],
  ]);
  expect(results.map(presentActivityOccurrence)).toEqual([
    { label: 'Request failed', outcome: 'Failed' }, { label: 'Update received', outcome: 'Rendered' },
  ]);
});

it('uses sequence ordering and explicit membership rather than array order', () => {
  const entries = [entry(1), entry(2, { phase: 'end' }), entry(3, { phase: 'render', deliverySequences: [1] })];
  expect(activityOccurrences([...entries].reverse())).toEqual(activityOccurrences(entries));
  expect(activityOccurrences(entries)[0]).toMatchObject({ event: { sequence: 1 }, render: 'observed' });
});

it('leaves missing registration identity unknown and accepts empty retained history', () => {
  expect(activityOccurrences([])).toEqual([]);
  expect(activityOccurrences([entry(1, { kind: 'subscription', status: 'active' })])[0].registration).toBeNull();
});
