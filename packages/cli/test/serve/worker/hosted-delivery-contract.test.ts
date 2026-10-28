import { expect, test } from 'bun:test';
import { _snapSubs } from '../../../src/serve/worker/client/core.js';
import { doc } from '../../../src/serve/worker/client/firestore-refs.js';
import { setDoc } from '../../../src/serve/worker/client/firestore-writes.js';
import { onSnapshot } from '../../../src/serve/worker/client/firestore-reads.js';
import { messagingGetMessaging, messagingSubscribe } from '../../../src/serve/worker/client/messaging.js';
import { rtdbGetDatabase, rtdbRef } from '../../../src/serve/worker/client/rtdb-references.js';
import { rtdbOnValue } from '../../../src/serve/worker/client/rtdb-listeners.js';
import { rtdbSet } from '../../../src/serve/worker/client/rtdb-writes.js';
import { rtdbOnDisconnect } from '../../../src/serve/worker/client/rtdb-connection-lifecycle.js';
import { rtdbRunTransaction } from '../../../src/serve/worker/client/rtdb-transactions.js';
import { aiStreamGenerateContent } from '../../../src/serve/worker/client/ai.js';
import { addedKeys, attached, barrier, cleanups, dropped, gate, Host, until } from './hosted-delivery-contract-support.js';

// ADR-0019, 2026-10-17 amendment ("one delivery contract for every client"),
// rules D5, D6, D7 and D10, and decision 7 for an AI stream at a drop. The
// client runs against a real WebSocket host on a loopback port. Absence is
// read after an operation answered on the same ordered socket, never after a
// delay.

const CONNECTION_LOST = 'The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.';
const INVALID_JSON = 'The hosted sandbox sent invalid JSON. Requests already sent may have completed; check state before retrying.';

function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    value => ({ value }),
    (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }),
  );
}

// ── D7: registered before the call returns ────────────────────────────────

test('D7: onMessage is in the routing table before it returns, while the registration id is pending', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const registration = gate<string>();
  const messaging = messagingGetMessaging(db, () => registration.promise);
  const payloads: unknown[] = [];
  let stop = (): void => {};
  const added = addedKeys(_snapSubs, () => { stop = messagingSubscribe(messaging, 'messaging.foreground', payload => { payloads.push(payload); }); });
  cleanups.push(() => stop());
  expect(added).toHaveLength(1);
  registration.open('swreg-1');
  await until(() => host.subscriptionFrames(added[0]!).includes('sub'));
  host.push({ t: 'snap', subId: added[0]!, value: { messageId: 'm1' } });
  await until(() => payloads.length === 1);
  expect(payloads).toEqual([{ messageId: 'm1' }]);
});

test('D10: onMessage cancelled before its registration id settles sends neither worker-sub nor worker-unsub', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const registration = gate<string>();
  const messaging = messagingGetMessaging(db, () => registration.promise);
  let stop = (): void => {};
  const added = addedKeys(_snapSubs, () => { stop = messagingSubscribe(messaging, 'messaging.foreground', () => {}); });
  stop();
  registration.open('swreg-1');
  await registration.promise;
  await barrier(db);
  expect(host.frames.filter(frame => frame.t === 'sub' || frame.t === 'unsub')).toEqual([]);
  expect(added.filter(subId => _snapSubs.has(subId))).toEqual([]);
});

// ── D5: release order after a re-attach ───────────────────────────────────

test('D5: a subscription opened while detached is released before an operation held earlier', async () => {
  const host = new Host();
  const { db, reattached } = await dropped(host);
  const write = setDoc(doc(db, 'rooms/held'), { a: 1 });
  let stop = (): void => {};
  const [subId] = addedKeys(_snapSubs, () => { stop = onSnapshot(doc(db, 'rooms/listened'), () => {}); });
  cleanups.push(() => stop());
  const before = host.frames.length;
  host.start();
  await until(reattached);
  await write;
  await barrier(db);
  const after = host.frames.slice(before);
  const subAt = after.findIndex(frame => frame.t === 'sub' && frame.subId === subId);
  const writeAt = after.findIndex(frame => frame.method === 'setDoc');
  expect(subAt).toBeGreaterThanOrEqual(0);
  expect(subAt).toBeLessThan(writeAt);
});

// ── D10: cancellation ─────────────────────────────────────────────────────

test('D10: a listener opened and cancelled while detached sends nothing after re-attach', async () => {
  const host = new Host();
  const { db, reattached } = await dropped(host);
  let stop = (): void => {};
  const [subId] = addedKeys(_snapSubs, () => { stop = onSnapshot(doc(db, 'rooms/cancelled'), () => {}); });
  stop();
  host.start();
  await until(reattached);
  await barrier(db);
  expect(host.subscriptionFrames(subId!)).toEqual([]);
});

test('D10: calling a Firestore unsubscribe twice sends worker-unsub once', async () => {
  const host = new Host();
  const { db } = await attached(host);
  let stop = (): void => {};
  const [subId] = addedKeys(_snapSubs, () => { stop = onSnapshot(doc(db, 'rooms/twice'), () => {}); });
  await barrier(db);
  stop();
  stop();
  await barrier(db);
  expect(host.subscriptionFrames(subId!)).toEqual(['sub', 'unsub']);
});

test('D10: a Firestore listener ended by an error snapshot sends worker-unsub once when the app unsubscribes', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const errors: unknown[] = [];
  let stop = (): void => {};
  const [subId] = addedKeys(_snapSubs, () => { stop = onSnapshot(doc(db, 'rooms/denied'), () => {}, error => { errors.push(error); }); });
  await barrier(db);
  host.push({ t: 'snap', subId: subId!, value: { __error: { code: 'permission-denied', message: 'denied' } } });
  await until(() => errors.length === 1);
  stop();
  await barrier(db);
  expect(host.subscriptionFrames(subId!)).toEqual(['sub', 'unsub']);
});

test('D10: an RTDB onlyOnce listener sends worker-unsub once', async () => {
  const host = new Host();
  const { db } = await attached(host);
  let calls = 0;
  const [subId] = addedKeys(_snapSubs, () => {
    rtdbOnValue(rtdbRef(rtdbGetDatabase(db), 'rooms'), () => { calls += 1; }, { onlyOnce: true });
  });
  await barrier(db);
  host.push({ t: 'snap', subId: subId!, value: { exists: true, exportValue: 1, value: 1 } });
  await until(() => calls === 1);
  // The stop the onlyOnce delivery schedules runs before this later operation is issued.
  await new Promise<void>(resolve => queueMicrotask(resolve));
  await barrier(db);
  expect(host.subscriptionFrames(subId!)).toEqual(['sub', 'unsub']);
});

// ── D6: a failure that permits no retry ───────────────────────────────────

test('D6: a no-retry failure ends every open subscription once, with its own error', async () => {
  const host = new Host();
  const { db, states } = await attached(host);
  const errors: Array<{ code?: string; message?: string }> = [];
  const added = addedKeys(_snapSubs, () => {
    onSnapshot(doc(db, 'rooms/live'), () => {}, error => { errors.push(error as { code?: string; message?: string }); });
    rtdbOnValue(rtdbRef(rtdbGetDatabase(db), 'rooms'), () => {});
  });
  await barrier(db);
  host.pushRaw('not json');
  await until(() => states.at(-1) === 'closed');
  expect(errors.map(error => ({ code: error.code, message: error.message }))).toEqual([{ code: 'unavailable', message: INVALID_JSON }]);
  expect(added.filter(subId => _snapSubs.has(subId))).toEqual([]);
});

test('D6: after a no-retry failure a new listener reports through its error callback and an operation rejects', async () => {
  const host = new Host();
  const { db, states } = await attached(host);
  host.pushRaw('not json');
  await until(() => states.at(-1) === 'closed');
  const errors: Array<{ code?: string }> = [];
  const listen = (): unknown => onSnapshot(doc(db, 'rooms/late'), () => {}, error => { errors.push(error as { code?: string }); });
  expect(listen).not.toThrow();
  const write = await settle(setDoc(doc(db, 'rooms/late'), { a: 1 }));
  expect(write).toEqual({ code: 'unavailable', message: 'The hosted sandbox connection is closed.' });
  await until(() => errors.length === 1);
  expect(errors.map(error => error.code)).toEqual(['unavailable']);
});

// ── Decision 7: an AI stream in flight at a drop ──────────────────────────

test('an AI stream in flight at a drop fails once, and its unsub is released after re-attach', async () => {
  const host = new Host();
  const { db, states } = await attached(host);
  const stream = aiStreamGenerateContent(db, { model: 'models/test', request: {} });
  const outcomes: unknown[] = [];
  // The generator's first step opens the subscription before next() returns.
  const [subId] = addedKeys(_snapSubs, () => { void settle(stream.next()).then(outcome => { outcomes.push(outcome); }); });
  await barrier(db);
  host.stop();
  await until(() => states.at(-1) === 'interrupted');
  host.start();
  await until(() => states.filter(state => state === 'attached').length > 1);
  await barrier(db);
  expect(outcomes).toEqual([{ code: 'unavailable', message: CONNECTION_LOST }]);
  expect(host.subscriptionFrames(subId!)).toEqual(['sub', 'unsub']);
});

// ── Decision 7, amended for #1088: RTDB calls in flight at a drop ─────────

test('RTDB calls in flight at a drop: set is sent again and resolves, onDisconnect never settles, a transaction rejects with disconnect', async () => {
  const host = new Host();
  const inFlight = ['rtdb.set', 'rtdb.onDisconnectSet', 'rtdb.transactionCommit'];
  for (const method of inFlight) host.unanswered.add(method);
  host.answers.set('rtdb.get', { value: 1, exists: true });
  const { db, states } = await attached(host);
  const database = rtdbGetDatabase(db);
  const write = settle(rtdbSet(rtdbRef(database, 'rooms/r1'), 'across the drop'));
  let armSettled = false;
  void rtdbOnDisconnect(rtdbRef(database, 'status/alice')).set('offline').finally(() => { armSettled = true; });
  const transaction = settle(rtdbRunTransaction(rtdbRef(database, 'counter'), (count: number | null) => (count ?? 0) + 1));
  await until(() => inFlight.every(method => host.frames.some(frame => frame.method === method)));
  host.stop();
  await until(() => states.at(-1) === 'interrupted');
  host.unanswered.clear();
  host.start();
  await until(() => states.filter(state => state === 'attached').length > 1);
  expect(await write).toEqual({ value: undefined });
  expect(await transaction).toEqual({ code: undefined, message: 'disconnect' });
  await barrier(db);
  expect(armSettled).toBe(false);
  const sentTimes = (method: string) => host.frames.filter(frame => frame.method === method).length;
  expect(inFlight.map(sentTimes)).toEqual([2, 1, 1]);
});
