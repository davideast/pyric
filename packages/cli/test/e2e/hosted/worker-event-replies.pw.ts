import { expect, test } from '@playwright/test';
import { wirePort, disconnectPort } from '../../../src/serve/worker/client/core.js';
import { subscribeEvents, eventHistory } from '../../../src/serve/worker/client/studio.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';

function eventClient() {
  const channel = new MessageChannel();
  const subscribed = Promise.withResolvers<string>();
  const unsubscribed = Promise.withResolvers<string>();
  channel.port2.onmessage = event => {
    const message = event.data;
    const isSubscription = message.t === 'sub';
    const isUnsubscribe = message.t === 'unsub';
    if (isSubscription) subscribed.resolve(message.subId);
    if (isUnsubscribe) unsubscribed.resolve(message.subId);
  };
  wirePort(channel.port1);
  const db: ClientDb = { __kind: 'client-db', port: channel.port1 };
  return { db, subscribed: subscribed.promise, unsubscribed: unsubscribed.promise,
    send: (message: unknown) => channel.port2.postMessage(message),
    barrier() { return new Promise<void>(resolve => {
      const receive = (event: MessageEvent) => {
        const isBarrier = event.data.t === 'clock';
        if (isBarrier) { channel.port1.removeEventListener('message', receive); resolve(); }
      };
      channel.port1.addEventListener('message', receive);
      channel.port2.postMessage({ t: 'clock', state: { mode: 'wall', fixedAt: 0, offsetMs: 0 } });
    }); },
    close() { disconnectPort(channel.port1); channel.port1.close(); channel.port2.close(); } };
}

test('event batches cannot cross app port ownership', async () => {
  const first = eventClient();
  const second = eventClient();
  const firstBatches: unknown[] = [];
  const secondBatches: unknown[] = [];
  const stopFirst = subscribeEvents(first.db, events => firstBatches.push(events));
  const stopSecond = subscribeEvents(second.db, events => secondBatches.push(events));
  try {
    const [firstId, secondId] = await Promise.all([first.subscribed, second.subscribed]);
    first.send({ t: 'event', subId: secondId, events: [] });
    first.send({ t: 'event', subId: firstId, events: [] });
    second.send({ t: 'event', subId: firstId, events: [] });
    second.send({ t: 'event', subId: secondId, events: [] });
    await Promise.all([first.barrier(), second.barrier()]);
    expect(firstBatches).toEqual([[]]);
    expect(secondBatches).toEqual([[]]);
  } finally { stopFirst(); stopSecond(); first.close(); second.close(); }
});

test('malformed event history rejects and unsubscribes instead of stranding its caller', async () => {
  const client = eventClient();
  const healthy = eventClient();
  try {
    const outcome = eventHistory(client.db).then(() => 'accepted', error => error.code);
    const subId = await client.subscribed;
    client.send({ t: 'event', subId, events: {} });
    const result = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve('stranded'), 500))]);
    expect(result).toBe('unavailable');
    await expect(client.unsubscribed).resolves.toBe(subId);
    const next = eventHistory(healthy.db);
    healthy.send({ t: 'event', subId: await healthy.subscribed, events: [] });
    await expect(next).resolves.toEqual([]);
  } finally { client.close(); healthy.close(); }
});
