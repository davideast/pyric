import { describe, expect, test } from 'bun:test';
import { createSdkActivityJournal, type SdkActivityEvent } from 'pyric/sandbox/internal';
import { journalLiveListener, type LiveListener } from '../../../src/serve/entries/live-listener-journal.js';

const firestore = {};
const rooms: LiveListener = { firestore, method: 'onSnapshot', target: 'rooms', isQuery: true, key: '["query","rooms",[]]' };

function journalWithEvents() {
  const journal = createSdkActivityJournal({ now: () => 1_000, monotonicNow: () => 1 });
  const events: SdkActivityEvent[] = [];
  journal.subscribe((event) => events.push(event));
  return { journal, events };
}

describe('a live listener in the page journal', () => {
  test('opens a Firestore subscription named by its target, query and method', () => {
    const { journal } = journalWithEvents();
    journalLiveListener(rooms, journal);
    expect(journal.records()).toMatchObject([
      { service: 'firestore', target: 'rooms', isQuery: true, method: 'onSnapshot', kind: 'subscription', status: 'active', deliveryCount: 0 },
    ]);
  });

  test("reports a delivery before the callback runs, and returns the callback's result", () => {
    const { journal, events } = journalWithEvents();
    const activity = journalLiveListener(rooms, journal);
    const seen: string[] = [];
    const returned = activity.deliver({ docs: [] }, 2, () => {
      seen.push(events.filter((event) => event.phase === 'delivery').length === 1 ? 'after delivery' : 'before delivery');
      return 'callback result';
    });
    expect(returned).toBe('callback result');
    expect(seen).toEqual(['after delivery']);
    expect(journal.records()[0]?.deliveryCount).toBe(1);
  });

  test('carries the documents production billed as the delivery usage', () => {
    const journal = createSdkActivityJournal({ now: () => 1_000, monotonicNow: () => 1 });
    const usages: unknown[] = [];
    journal.observe((observation) => usages.push((observation as { usage?: unknown }).usage));
    const activity = journalLiveListener(rooms, journal);
    activity.deliver({ docs: [1, 2, 3] }, 2, () => undefined);
    activity.deliver({ docs: [1, 2, 3] }, 0, () => undefined);
    expect(usages.filter((usage) => usage !== undefined)).toEqual([{ documentReads: 2 }, { documentReads: 0 }]);
  });

  test('without a billed count, the journal measures the snapshot itself', () => {
    const journal = createSdkActivityJournal({ now: () => 1_000, monotonicNow: () => 1 });
    const usages: unknown[] = [];
    journal.observe((observation) => usages.push((observation as { usage?: unknown }).usage));
    journalLiveListener(rooms, journal).deliver({ docs: [1, 2, 3], metadata: {} }, undefined, () => undefined);
    expect(usages.filter((usage) => usage !== undefined)).toEqual([{ documentReads: 3 }]);
  });

  test('lets an error thrown by the callback propagate', () => {
    const { journal } = journalWithEvents();
    const thrown = new Error('app bug');
    expect(() => journalLiveListener(rooms, journal).deliver({}, 1, () => { throw thrown; })).toThrow(thrown);
  });

  test('fails the activity on a listener error and closes it on unsubscribe', () => {
    const { journal } = journalWithEvents();
    journalLiveListener(rooms, journal).fail();
    journalLiveListener({ ...rooms, target: 'rooms/lobby', isQuery: false, key: '["document","rooms/lobby"]' }, journal).close();
    expect(journal.records().map((record) => [record.target, record.status])).toEqual([['rooms', 'failed'], ['rooms/lobby', 'closed']]);
  });
});
