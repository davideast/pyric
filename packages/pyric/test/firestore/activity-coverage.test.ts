import { expect, it } from 'bun:test';
import { firestoreActivityCoverage } from '../../src/firestore/activity-coverage.js';
import { createSdkActivityJournal } from '../../src/sandbox/internal/sdk-activity.js';
import { createSdkRates } from '../../src/sandbox/internal/sdk-rates.js';
import { sdkMethodCoverage } from '../../src/sandbox/internal/sdk-coverage.js';

const source = { service: 'firestore' as const, target: 'messages', key: 'messages' };

it('covers onSnapshotResume as a Firestore listener', () => {
  expect(firestoreActivityCoverage.listener).toContain('onSnapshotResume');
  expect(sdkMethodCoverage('firestore')).toContainEqual({ method: 'onSnapshotResume', category: 'listener' });
});

it('counts onSnapshotResume deliveries and active listeners in Rates like onSnapshot', () => {
  const journal = createSdkActivityJournal({ now: () => 100000, monotonicNow: () => 0, correlationWindowMs: 0 });
  const rates = createSdkRates({ monotonicNow: () => 0 });
  journal.observe(rates.record);
  const listener = journal.begin({ app: {}, source, method: 'onSnapshotResume', kind: 'subscription' });
  listener.delivered();
  listener.delivered();
  const firestore = rates.snapshot().services.find(service => service.service === 'firestore')!;
  const row = firestore.methods.find(method => method.method === 'onSnapshotResume');
  expect(row).toMatchObject({ category: 'listener', callsPerSecond: 0.2, deliveriesPerSecond: 0.4, activeListeners: 1, observed: true });
  listener.close();
  journal.dispose();
});
