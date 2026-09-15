import { describe, expect, it } from 'bun:test';
import { createSdkActivityJournal } from '../../src/sandbox/internal/sdk-activity.js';

const source = { service: 'firestore' as const, target: 'messages', key: 'messages', isQuery: true };

describe('SDK activity lifecycle', () => {
  it('separates calls and apps while grouping equivalent source descriptors', () => {
    const journal = createSdkActivityJournal();
    const app = {};
    const first = journal.begin({ app, source, method: 'getDocs', kind: 'operation' });
    const second = journal.begin({ app, source, method: 'onSnapshot', kind: 'subscription', transportId: 'sub-1' });
    journal.begin({ app: {}, source, method: 'getDocs', kind: 'operation' });
    journal.begin({ app, source: { ...source, key: 'messages:limit=1' }, method: 'getDocs', kind: 'operation' });
    const records = journal.records();
    expect(first.id).not.toBe(second.id);
    expect(records[0].sourceId).toBe(records[1].sourceId);
    expect(records[0].appId).not.toBe(records[2].appId);
    expect(records[0].sourceId).not.toBe(records[3].sourceId);
    expect(records[1].transportId).not.toBe(records[1].id);
    journal.dispose();
  });

  it('records actual deliveries once and leaves completed reads available for correlation', () => {
    let clock = 0;
    const journal = createSdkActivityJournal({ now: () => clock, retentionMs: 1000 });
    const activity = journal.begin({ app: {}, source, method: 'getDocs', kind: 'operation' });
    activity.delivered();
    activity.delivered();
    activity.complete();
    activity.fail();
    expect(journal.records()[0]).toMatchObject({ status: 'completed', deliveryCount: 1 });
    clock = 250;
    expect(journal.records()).toHaveLength(1);
    clock = 1000;
    expect(journal.records()).toHaveLength(0);
    journal.dispose();
  });

  it('counts duplicate registrations independently and stops deliveries after closure', () => {
    const journal = createSdkActivityJournal();
    const app = {};
    const one = journal.begin({ app, source, method: 'onSnapshot', kind: 'subscription' });
    const two = journal.begin({ app, source, method: 'onSnapshot', kind: 'subscription' });
    one.delivered();
    one.delivered();
    two.delivered();
    one.close();
    one.delivered();
    expect(journal.records().map(record => record.deliveryCount)).toEqual([2, 1]);
    journal.dispose();
  });

  it('isolates diagnostic errors and bounds terminal metadata without evicting active listeners', () => {
    let clock = 0;
    const journal = createSdkActivityJournal({ maxCompleted: 2, now: () => clock });
    const phases: string[] = [];
    journal.subscribe(() => { throw new Error('diagnostic failure'); });
    journal.subscribe(event => phases.push(event.phase));
    journal.begin({ app: {}, source, method: 'onSnapshot', kind: 'subscription' });
    for (let i = 0; i < 3; i++) {
      const activity = journal.begin({ app: {}, source, method: 'getDocs', kind: 'operation' });
      activity.fail();
    }
    // A burst must not lose an eligible delivery before React can commit.
    expect(journal.records()).toHaveLength(4);
    clock = 250;
    expect(journal.records()).toHaveLength(3);
    expect(journal.records().filter(record => record.status === 'failed')).toHaveLength(2);
    expect(phases.filter(phase => phase === 'delivery')).toHaveLength(0);
    expect(phases).toContain('remove');
    journal.dispose();
    expect(journal.records()).toHaveLength(0);
  });
});


it('expires each record once when removal subscribers synchronously read the journal', () => {
  let clock = 0;
  const journal = createSdkActivityJournal({ now: () => clock, retentionMs: 250 });
  const removed: string[] = [];
  journal.subscribe(event => {
    if (event.phase === 'remove') {
      removed.push(event.record.id);
      journal.records();
    }
  });
  for (let i = 0; i < 4; i++) {
    journal.begin({ app: {}, source, method: 'getDocs', kind: 'operation' }).complete();
  }
  clock = 250;
  expect(journal.records()).toHaveLength(0);
  expect(removed).toHaveLength(4);
  expect(new Set(removed).size).toBe(4);
  journal.dispose();
});

it('expires terminal metadata by timer without a consumer polling records', async () => {
  const journal = createSdkActivityJournal({ retentionMs: 5, correlationWindowMs: 5 });
  const removed = new Promise<string>(resolve => journal.subscribe(event => {
    if (event.phase === 'remove') resolve(event.record.id);
  }));
  const activity = journal.begin({ app: {}, source, method: 'getDocs', kind: 'operation' });
  activity.delivered();
  activity.complete();
  expect(await removed).toBe(activity.id);
  expect(journal.records()).toHaveLength(0);
  journal.dispose();
});

it('response previews are bounded and never enter observation events', () => {
  const journal = createSdkActivityJournal();
  const observations: unknown[] = [];
  journal.observe(event => observations.push(event));
  const request = journal.begin({ app: {}, kind: 'operation', method: 'generateContent', source: { service: 'ai', target: 'model', key: 'model' } });
  request.ai({ requestedModel: 'model', engine: 'scripted', usageSource: 'scripted' });
  request.response({ text: 'x'.repeat(70000) });
  const preview = journal.records()[0]!.response!;
  expect(preview.text.length).toBe(65536);
  expect(preview.truncated).toBe(true);
  expect(observations.every(event => !Object.hasOwn(event as object, 'response'))).toBe(true);
  const circular: { self?: unknown } = {}; circular.self = circular;
  expect(() => request.response(circular)).not.toThrow();
  journal.dispose();
});
