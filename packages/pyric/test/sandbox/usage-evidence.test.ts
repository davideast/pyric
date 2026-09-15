import { expect, test } from 'bun:test';
import { firestoreReadUsage, databaseReadUsage } from '../../src/sandbox/internal/usage-evidence.js';
import { createSdkActivityJournal, finishSdkRead } from '../../src/sandbox/internal/sdk-activity.js';
import { createSdkRateMonitor } from '../../src/sandbox/internal/sdk-rates.js';
import { runSdkWrite } from '../../src/sandbox/internal/sdk-write-activity.js';

test('Firestore counts result documents, query minimums and changed listener documents', () => {
  const query = { docs: Array.from({ length: 100 }, () => ({})), docChanges: () => [{ type: 'modified' }] };
  expect(firestoreReadUsage(query)).toEqual({ documentReads: 100 });
  expect(firestoreReadUsage(query, true, true)).toEqual({ documentReads: 100 });
  expect(firestoreReadUsage(query, true, false)).toEqual({ documentReads: 1 });
  expect(firestoreReadUsage({ docs: [] })).toEqual({ documentReads: 1 });
  expect(firestoreReadUsage({ exists: () => false })).toEqual({ documentReads: 1 });
  expect(firestoreReadUsage({ exists: () => false }, true, false)).toEqual({ documentReads: 0 });
  expect(firestoreReadUsage({ docs: [], docChanges: () => [] }, true, false)).toEqual({ documentReads: 0 });
  expect(firestoreReadUsage({ ...query, metadata: { fromCache: true } })).toEqual({ documentReads: 0 });
  expect(firestoreReadUsage({ ...query, metadata: { hasPendingWrites: true } })).toEqual({ documentReads: 100 });
  expect(firestoreReadUsage({ docs: [], docChanges: () => [{ type: 'removed' }] }, true, false)).toEqual({ documentReads: 0, unmeasured: 1 });
  expect(firestoreReadUsage({ docs: [] }, true, false)).toEqual({ unmeasured: 1 });
  expect(firestoreReadUsage({ data: () => ({ count: 100 }) })).toEqual({ unmeasured: 1 });
});

test('RTDB measures UTF-8 JSON snapshot payloads independently of Node Buffer', () => {
  const values = [null, '', 'a', 'ab', 'é😀', { nested: [true, 12, '日本語'] }];
  const expected = values.map(value => Buffer.byteLength(JSON.stringify(value), 'utf8'));
  const buffer = globalThis.Buffer;
  try {
    Reflect.deleteProperty(globalThis, 'Buffer');
    values.forEach((value, index) => expect(databaseReadUsage({ val: () => value })).toEqual({ payloadBytes: expected[index] }));
  } finally { globalThis.Buffer = buffer; }
});

test('usage survives the journal without payload retention, excludes denials and decays', async () => {
  let now = 0;
  const journal = createSdkActivityJournal({ monotonicNow: () => now });
  const monitor = createSdkRateMonitor(journal, { monotonicNow: () => now });
  const events: unknown[] = [];
  journal.observe(event => events.push(event));
  const begin = (method: string, kind: 'subscription' | 'operation' = 'operation') => journal.begin({ app: journal,
    source: { service: 'firestore', target: 'test', key: 'test' }, method, kind });
  const listener = begin('onSnapshot', 'subscription');
  listener.delivered({ docs: [{}, {}, {}] });
  listener.delivered({ docs: [{}, {}, {}], docChanges: () => [{ type: 'modified' }] });
  finishSdkRead(begin('getDocFromCache'), { exists: true });
  await runSdkWrite(begin('setDoc'), () => undefined);
  await runSdkWrite(begin('deleteDoc'), () => undefined);
  await runSdkWrite(begin('writeBatch.commit'), () => undefined, () => ({ documentWrites: 3, documentDeletes: 2 }));
  await expect(runSdkWrite(begin('setDoc'), () => { throw new Error('denied'); })).rejects.toThrow('denied');
  const rtdb = journal.begin({ app: journal, source: { service: 'database', target: '/', key: '/' }, method: 'onValue', kind: 'subscription' });
  rtdb.delivered({ val: () => ({ secret: 'never retain me' }) });
  expect(JSON.stringify(events)).not.toContain('never retain me');
  const service = () => monitor.snapshot().services.find(service => service.service === 'firestore')!;
  expect(service().usage).toEqual({ documentReads: 0.8, documentWrites: 0.8, documentDeletes: 0.6, payloadBytes: 0, uploadedBytes: 0, downloadedBytes: 0, unmeasured: 0 });
  now = 5000;
  expect(service().usage).toEqual({ documentReads: 0, documentWrites: 0, documentDeletes: 0, payloadBytes: 0, uploadedBytes: 0, downloadedBytes: 0, unmeasured: 0 });
  monitor.dispose(); journal.dispose();
});
