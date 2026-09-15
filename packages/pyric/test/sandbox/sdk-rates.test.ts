import { expect, it } from 'bun:test';
import { createSdkActivityJournal } from '../../src/sandbox/internal/sdk-activity.js';
import { createSdkRates, createSdkRateMonitor } from '../../src/sandbox/internal/sdk-rates.js';
import type { SdkObservation } from '../../src/sandbox/internal/sdk-observation.js';

const source = { service: 'database' as const, target: '/counter', key: '/counter' };
const app = {};
function harness() {
  let monotonic = 0;
  let wall = 100000;
  const journal = createSdkActivityJournal({ now: () => wall, monotonicNow: () => monotonic, retentionMs: 250, maxCompleted: 2, correlationWindowMs: 0 });
  const rates = createSdkRates({ monotonicNow: () => monotonic });
  journal.observe(rates.record);
  return { journal, rates, time: (value: number) => { monotonic = value; wall -= 100; } };
}
function method(rates: ReturnType<typeof createSdkRates>, method: string) {
  return rates.snapshot().services.find(service => service.service === 'rtdb')!.methods.find(row => row.method === method)!;
}

it('separates calls, deliveries and active listeners, decaying while idle despite a pinned or reversed wall clock', () => {
  const { journal, rates, time } = harness();
  const listener = journal.begin({ app, source, method: 'onValue', kind: 'subscription' });
  listener.delivered();
  listener.delivered();
  const write = journal.begin({ app, source, method: 'update', kind: 'operation' });
  write.fail();
  const read = journal.begin({ app, source, method: 'get', kind: 'operation' });
  read.delivered();
  read.complete();
  expect(method(rates, 'onValue')).toMatchObject({ callsPerSecond: 0.2, deliveriesPerSecond: 0.4, activeListeners: 1 });
  expect(method(rates, 'update')).toMatchObject({ callsPerSecond: 0.2, deliveriesPerSecond: 0 });
  expect(method(rates, 'get')).toMatchObject({ callsPerSecond: 0.2, deliveriesPerSecond: 0.2 });
  time(5000);
  expect(method(rates, 'onValue')).toMatchObject({ callsPerSecond: 0, deliveriesPerSecond: 0, activeListeners: 1 });
  listener.close();
  expect(method(rates, 'onValue').activeListeners).toBe(0);
  time(60000);
  expect(method(rates, 'get').buckets.every(bucket => bucket.calls === 0 && bucket.deliveries === 0)).toBe(true);
  journal.dispose();
});

it('deduplicates replay by sequence, excludes transport and cleanup, and survives retained history eviction', () => {
  const { journal, rates } = harness();
  const observed: SdkObservation[] = [];
  journal.observe(event => observed.push(event));
  for (let index = 0; index < 10; index++) {
    const operation = journal.begin({ app, source, method: 'get', kind: 'operation' });
    operation.transport(`rpc-${index}`);
    operation.delivered();
    operation.complete();
  }
  expect(journal.records().length).toBeLessThan(10);
  expect(method(rates, 'get').callsPerSecond).toBe(2);
  // Structured clones have new object identities but the same authoritative sequence.
  for (const event of structuredClone(observed)) rates.record(event);
  expect(method(rates, 'get').callsPerSecond).toBe(2);
  expect(method(rates, 'get').deliveriesPerSecond).toBe(2);
  journal.dispose();
  expect(method(rates, 'get').callsPerSecond).toBe(2);
});

it('bounds storage independently of event volume and ephemeral source identities', () => {
  const { journal, rates, time } = harness();
  const before = JSON.stringify(rates.snapshot()).length;
  for (let index = 0; index < 100000; index++) {
    journal.begin({ app, source: { ...source, key: String(index) }, method: 'set', kind: 'operation' }).complete();
  }
  expect(method(rates, 'set').callsPerSecond).toBe(20000);
  expect(method(rates, 'set').buckets).toHaveLength(60);
  expect(JSON.stringify(rates.snapshot()).length).toBeLessThan(before + 100);
  time(65000);
  journal.begin({ app, source, method: 'set', kind: 'operation' }).complete();
  expect(method(rates, 'set').callsPerSecond).toBe(0.2);
  expect(method(rates, 'set').buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(1);
  journal.dispose();
});

it('seeds only live listeners on late monitor attachment and releases them when the journal is disposed', () => {
  const journal = createSdkActivityJournal();
  journal.begin({ app, source, method: 'get', kind: 'operation' }).complete();
  const listener = journal.begin({ app, source, method: 'onValue', kind: 'subscription' });
  listener.delivered();
  const monitor = createSdkRateMonitor(journal);
  const row = () => monitor.snapshot().services.find(service => service.service === 'rtdb')!.methods.find(method => method.method === 'onValue')!;
  expect(row()).toMatchObject({ callsPerSecond: 0, deliveriesPerSecond: 0, activeListeners: 1 });
  listener.delivered();
  expect(row().deliveriesPerSecond).toBe(0.2);
  journal.dispose();
  expect(row().activeListeners).toBe(0);
  monitor.dispose();
});

it('exposes unobserved tracked methods and freezes snapshots', () => {
  const rates = createSdkRates();
  const snapshot = rates.snapshot();
  expect(snapshot.services.find(service => service.service === 'storage')).toMatchObject({ coverage: 'partial', observed: false });
  expect(snapshot.services.find(service => service.service === 'rtdb')).toMatchObject({ coverage: 'partial', observed: false, untrackedMethods: ['onDisconnect'] });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.services[0]!.methods[0]!.buckets)).toBe(true);
});

it('retains the last activity window after the live minute expires without inventing live traffic', () => {
  const { journal, rates, time } = harness();
  time(10000);
  journal.begin({ app, source, method: 'set', kind: 'operation' }).complete();
  time(11000);
  journal.begin({ app, source, method: 'get', kind: 'operation' }).complete();
  time(600000);
  const service = rates.snapshot().services.find(service => service.service === 'rtdb')!;
  expect(service.methods.every(method => method.callsPerSecond === 0)).toBe(true);
  expect(service.history!.methods.flatMap(method => method.buckets).reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(2);
  expect(service.history!.endSecond).toBe(13);
  expect(service.lastActivityAt).toBeDefined();
  journal.dispose();
});

it('retains immutable document usage buckets after idle and anchors delayed completions', () => {
  const { journal, rates, time } = harness();
  const firestore = { service: 'firestore' as const, target: 'messages', key: 'messages' };
  const read = journal.begin({ app, source: firestore, method: 'getDocs', kind: 'operation' });
  time(10000);
  read.delivered(undefined, { documentReads: 12 });
  read.complete();
  const write = journal.begin({ app, source: firestore, method: 'writeBatch.commit', kind: 'operation' });
  write.complete({ documentWrites: 3, documentDeletes: 1 });
  const captured = rates.snapshot().services.find(service => service.service === 'firestore')!;
  expect(captured.usageBuckets?.find(bucket => bucket.second === 10)).toMatchObject({ documentReads: 12, documentWrites: 3, documentDeletes: 1 });
  expect(Object.isFrozen(captured.usageBuckets)).toBe(true);
  time(600000);
  const idle = rates.snapshot().services.find(service => service.service === 'firestore')!;
  expect(idle.usage?.documentReads).toBe(0);
  expect(idle.history?.usageBuckets?.find(bucket => bucket.second === 10)?.documentReads).toBe(12);
  expect(idle.history?.endSecond).toBe(12);
  journal.dispose();
});
