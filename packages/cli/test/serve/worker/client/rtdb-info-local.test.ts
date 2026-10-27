import { expect, test } from 'bun:test';
import { wirePort } from '../../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort, RtdbDataSnapshot } from '../../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { rtdbGetDatabase, rtdbRef } from '../../../../src/serve/worker/client/rtdb-references.js';
import { rtdbGet } from '../../../../src/serve/worker/client/rtdb-reads.js';
import { rtdbOnChildAdded, rtdbOnChildChanged, rtdbOnValue } from '../../../../src/serve/worker/client/rtdb-listeners.js';
import { rtdbGoOffline, rtdbGoOnline } from '../../../../src/serve/worker/client/rtdb-connection-lifecycle.js';

// ADR-0019, 2026-10-16 amendment: the web hosted client serves `.info`
// itself. Value, single-event and child listeners and one-time reads on any
// path under `/.info` are answered by the client and never reach the host.
// 2026-10-17 amendment, D10: an onlyOnce listener is called once, even when
// its own callback changes the value.
//
// The port stands in for the hosted socket: it reports a connection state the
// test sets, and fails every operation it is sent, so a read that reached the
// host shows up as a rejection rather than a hang.

interface FakeHost {
  db: ClientDb;
  /** Every frame the client posted, apart from the clock subscription. */
  posted: InboundMessage[];
  setConnected(connected: boolean): void;
}

function fakeHost(initiallyConnected: boolean): FakeHost {
  const posted: InboundMessage[] = [];
  const listeners = new Set<(connected: boolean) => void>();
  let connected = initiallyConnected;
  const reply = (message: OutboundMessage): void => {
    queueMicrotask(() => port.onmessage?.(new MessageEvent('message', { data: message })));
  };
  const port: ClientPort = {
    onmessage: null,
    postMessage(message) {
      if (message.t === 'clock-subscribe') return;
      posted.push(message);
      const failure = { code: 'internal', message: 'This frame reached the host.' };
      if (message.t === 'op') reply({ t: 'res', id: message.id, ok: false, error: failure });
      if (message.t === 'sub') reply({ t: 'snap', subId: message.subId, value: { __error: failure } });
    },
    start() {},
    close() {},
    observeConnection(listener) {
      listeners.add(listener);
      queueMicrotask(() => { if (listeners.has(listener)) listener(connected); });
      return () => { listeners.delete(listener); };
    },
  };
  wirePort(port);
  return {
    db: { __kind: 'client-db', port },
    posted,
    setConnected(next) {
      connected = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

/** Resolves on the listener's next delivery; the test waits on a positive event, never a delay. */
function recorder<T>(): { seen: T[]; record(value: T): void; next(count: number): Promise<void> } {
  const seen: T[] = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  return {
    seen,
    record(value) {
      seen.push(value);
      for (const entry of [...waiting]) {
        if (seen.length >= entry.count) { waiting.splice(waiting.indexOf(entry), 1); entry.resolve(); }
      }
    },
    next(count) {
      if (seen.length >= count) return Promise.resolve();
      return new Promise(resolve => waiting.push({ count, resolve }));
    },
  };
}

function settle(promise: Promise<RtdbDataSnapshot>): Promise<unknown> {
  return promise.then(snapshot => ({ value: snapshot.val() }), (error: Error) => ({ error: error.message }));
}

// DF-7 (#1247). Production rejects a one-shot get() of .info/connected with
// Error 'Invalid token in path' and no code: the SDK sends the read to the
// database, which refuses the .info token (observation
// rtdb-modular-info-write-validation, behavior.getConnected). Any other .info
// path is read through the same SDK path. The client refuses before the read
// can reach the worker, as the sandbox does; listeners are answered locally.
test('get() on .info paths rejects as production does and is never sent', async () => {
  const host = fakeHost(true);
  const database = rtdbGetDatabase(host.db);
  const reads = await Promise.all([
    settle(rtdbGet(rtdbRef(database, '.info/connected'))),
    settle(rtdbGet(rtdbRef(database, '.info/serverTimeOffset'))),
    settle(rtdbGet(rtdbRef(database, '.info'))),
    settle(rtdbGet(rtdbRef(database, '.info/custom/child'))),
  ]);
  expect(reads).toEqual(Array.from({ length: 4 }, () => ({ error: 'Invalid token in path' })));
  expect(host.posted).toEqual([]);
});

test('get() on .info/connected rejects while the client is not attached', async () => {
  const host = fakeHost(false);
  const read = await settle(rtdbGet(rtdbRef(rtdbGetDatabase(host.db), '.info/connected')));
  expect(read).toEqual({ error: 'Invalid token in path' });
  expect(host.posted).toEqual([]);
});

test('onValue on .info/serverTimeOffset and other .info paths delivers once and is never sent', async () => {
  const host = fakeHost(true);
  const database = rtdbGetDatabase(host.db);
  const offset = recorder<unknown>();
  const other = recorder<unknown>();
  const connected = recorder<unknown>();
  rtdbOnValue(rtdbRef(database, '.info/serverTimeOffset'), snapshot => offset.record(snapshot.val()));
  rtdbOnValue(rtdbRef(database, '.info/custom'), snapshot => other.record(snapshot.val()));
  rtdbOnValue(rtdbRef(database, '.info/connected'), snapshot => connected.record(snapshot.val()));
  await connected.next(1);
  host.setConnected(false);
  host.setConnected(true);
  // The connection listener saw both changes, so the others had the chance to deliver again.
  await connected.next(3);
  expect(connected.seen).toEqual([true, false, true]);
  expect(offset.seen).toEqual([0]);
  expect(other.seen).toEqual([null]);
  expect(host.posted).toEqual([]);
});

test('child listeners on /.info are served by the client', async () => {
  const host = fakeHost(true);
  const database = rtdbGetDatabase(host.db);
  const added = recorder<[string | null, unknown]>();
  const changed = recorder<[string | null, unknown]>();
  rtdbOnChildAdded(rtdbRef(database, '.info'), snapshot => added.record([snapshot.key, snapshot.val()]));
  rtdbOnChildChanged(rtdbRef(database, '.info'), snapshot => changed.record([snapshot.key, snapshot.val()]));
  await added.next(2);
  host.setConnected(false);
  await changed.next(1);
  expect(added.seen).toEqual([['connected', true], ['serverTimeOffset', 0]]);
  expect(changed.seen).toEqual([['connected', false]]);
  expect(host.posted).toEqual([]);
});

test('an onlyOnce .info/connected listener is called once when its callback changes the value', async () => {
  const host = fakeHost(true);
  const database = rtdbGetDatabase(host.db);
  const once = recorder<unknown>();
  const watcher = recorder<unknown>();
  rtdbOnValue(rtdbRef(database, '.info/connected'), snapshot => {
    once.record(snapshot.val());
    rtdbGoOffline(database);
  }, { onlyOnce: true });
  await once.next(1);
  rtdbOnValue(rtdbRef(database, '.info/connected'), snapshot => watcher.record(snapshot.val()));
  await watcher.next(1);
  rtdbGoOnline(database);
  await watcher.next(2);
  expect(watcher.seen).toEqual([false, true]);
  expect(once.seen).toEqual([true]);
});

test('an onlyOnce listener on .info/serverTimeOffset is called once and is never sent', async () => {
  const host = fakeHost(true);
  const offset = recorder<unknown>();
  rtdbOnValue(rtdbRef(rtdbGetDatabase(host.db), '.info/serverTimeOffset'), snapshot => offset.record(snapshot.val()), { onlyOnce: true });
  await offset.next(1);
  expect(offset.seen).toEqual([0]);
  expect(host.posted).toEqual([]);
});
