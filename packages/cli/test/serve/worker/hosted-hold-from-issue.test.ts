import { afterEach, expect, test } from 'bun:test';
import { getStorage, ref as storageRef, uploadBytes } from '../../../src/serve/worker/client/storage.js';
import { setIssueClockForTesting } from '../../../src/serve/worker/client/send-order.js';
import { attached, barrier, GatedBlob, Host, until } from './hosted-call-order-support.js';

// ADR-0019 decision 7 (2026-10-14) and the 2026-10-17 amendment: an operation
// is held for at most 10 seconds from the moment the app issued it. An
// operation that waits for its place in the call order (here, for a Blob's
// bytes) counts that wait toward the deadline.

const NOT_RESTORED = 'The hosted sandbox connection was not restored within 10 seconds. The request was not sent.';

let now = 0;
afterEach(() => setIssueClockForTesting(undefined));

test('a Blob upload that waited past the hold deadline before reaching the hold is not sent', async () => {
  setIssueClockForTesting(() => now);
  const host = new Host();
  const { db, states } = await attached(host);
  host.stop();
  await until(() => states.at(-1) === 'interrupted');
  const blob = new GatedBlob([new Uint8Array([1])]);
  const upload = uploadBytes(storageRef(getStorage(db), 'late.bin'), blob)
    .then(() => 'stored', (error: Error) => error.message);
  now += 10_001;
  blob.read.open(new Uint8Array([1]).buffer);
  expect(await upload).toBe(NOT_RESTORED);
  host.start();
  await until(() => states.filter(state => state === 'attached').length > 1);
  await barrier(db);
  expect(host.methods('storage.putBytes')).toEqual([]);
});

test('a Blob upload that reaches the hold within its deadline is sent after re-attach', async () => {
  setIssueClockForTesting(() => now);
  const host = new Host();
  const { db, states } = await attached(host);
  host.stop();
  await until(() => states.at(-1) === 'interrupted');
  const blob = new GatedBlob([new Uint8Array([1])]);
  const upload = uploadBytes(storageRef(getStorage(db), 'on-time.bin'), blob)
    .then(() => 'stored', (error: Error) => error.message);
  now += 5_000;
  blob.read.open(new Uint8Array([1]).buffer);
  host.start();
  expect(await upload).toBe('stored');
  expect(host.methods('storage.putBytes')).toEqual(['storage.putBytes']);
});
