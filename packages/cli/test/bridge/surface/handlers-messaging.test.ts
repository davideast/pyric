/**
 * The messaging methods, judged against the broker they call rather than
 * their own claim: a token the broker knows about receives what `send`
 * routes to it, `deliveries` reports the same route the broker chose, and
 * `tokens` reports the same membership `subscribeToTopic` /
 * `unsubscribeFromTopic` left behind.
 *
 * Minting a token, registering a receive-plane handler, and setting client
 * visibility are not service-tool methods (`0014-service-tools-with-sdk-methods.md`'s
 * design table has no method for them; they are the in-page client SDK's own
 * `getToken` / `onMessage` / visibility state). The suite reaches the broker
 * directly for that setup and exercises everything else through the tool.
 */
import { afterAll, expect, it } from 'bun:test';
import { messagingBrokerFor } from '../../../src/bridge/surface/service-handles.js';
import { ctx, finishHandlerSuite, run } from './handler-harness.js';

afterAll(() => finishHandlerSuite('messaging'));

it('delivers a send to a registered token subscribed to the topic, and deliveries lists it', async () => {
  const broker = messagingBrokerFor(ctx);
  const token = broker.getTokenFor('device-a');
  broker.setClientVisibility('device-a', 'hidden');
  const received: unknown[] = [];
  broker.onBackgroundMessage((payload) => received.push(payload));

  const subscribed = await run('messaging.subscribeToTopic', { tokens: [token], topic: 'alerts' });
  expect(subscribed.ok).toBe(true);
  expect((subscribed.data as { successCount: number }).successCount).toBe(1);

  const sent = await run('messaging.send', {
    message: { topic: 'alerts', notification: { title: 'Down', body: 'Service is down.' } },
  });
  expect(sent.ok).toBe(true);

  expect(received.length).toBe(1);

  const listed = await run('messaging.deliveries');
  expect(listed.ok).toBe(true);
  const { deliveries } = listed.data as { deliveries: Array<{ route: string; handled: boolean }> };
  const last = deliveries[deliveries.length - 1]!;
  // The kind the broker itself reported for this delivery, not a value this
  // suite asserted independently.
  expect(last.route).toBe('background');
  expect(last.handled).toBe(true);
});

it('stops delivery once unsubscribeFromTopic removes the membership', async () => {
  const broker = messagingBrokerFor(ctx);
  const token = broker.getTokenFor('device-b');
  broker.setClientVisibility('device-b', 'hidden');
  const received: unknown[] = [];
  broker.onBackgroundMessage((payload) => received.push(payload));

  await run('messaging.subscribeToTopic', { tokens: [token], topic: 'digest' });
  const unsubscribed = await run('messaging.unsubscribeFromTopic', {
    tokens: [token],
    topic: 'digest',
  });
  expect(unsubscribed.ok).toBe(true);
  expect((unsubscribed.data as { successCount: number }).successCount).toBe(1);

  const listedTokens = await run('messaging.tokens');
  expect(listedTokens.ok).toBe(true);
  const { tokens } = listedTokens.data as { tokens: Array<{ token: string; topics: string[] }> };
  const entry = tokens.find((candidate) => candidate.token === token)!;
  expect(entry.topics).not.toContain('digest');

  const before = received.length;
  await run('messaging.send', { message: { topic: 'digest', data: { k: 'v' } } });
  expect(received.length).toBe(before);
});

it('refuses a send to a token the sandbox does not recognize, naming tokens as the way to see what exists', async () => {
  const refused = await run('messaging.send', {
    message: { token: 'unknown-device-token-0000000000000000000000:APA91bStandInSuffix' },
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('tokens');
});

it('refuses a send that names none of token, topic, or condition', async () => {
  const refused = await run('messaging.send', { message: {} });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('token');
  expect(refused.summary).toContain('topic');
  expect(refused.summary).toContain('condition');
});

it('refuses a send that names more than one of token, topic, or condition', async () => {
  const refused = await run('messaging.send', {
    message: { topic: 'news', condition: "'news' in topics" },
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('token');
  expect(refused.summary).toContain('topic');
  expect(refused.summary).toContain('condition');
});
