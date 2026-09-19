import { expect, test } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from '../../src/sandbox/index.js';
import { getMessagingBroker } from '../../src/messaging/broker/index.js';

test('a replacement sandbox restores token ownership, deletion, and topic membership', async () => {
  const backend = createMemoryBackend();
  const original = initializeSandbox();
  await original.enablePersistence({ key: 'messaging', injectedBackend: backend });
  const broker = getMessagingBroker(original);
  const active = broker.getTokenFor('alice-registration', 'alice');
  const deleted = broker.getTokenFor('david-registration', 'david');
  broker.subscribeToTopic([active, deleted], 'orbit');
  broker.deleteTokenFor('david-registration');
  await original.flush();

  const replacement = initializeSandbox();
  await replacement.enablePersistence({ key: 'messaging', injectedBackend: backend });
  const restored = getMessagingBroker(replacement);
  expect(restored.getTokenFor('alice-registration', 'alice')).toBe(active);
  expect(restored.tokenState(deleted)).toBe('unregistered');
  const deliveries: string[] = [];
  restored.onBackgroundMessage(() => deliveries.push('alice'), 'alice');
  restored.onBackgroundMessage(() => deliveries.push('david'), 'david');
  restored.send({ topic: 'orbit', data: { message: 'After restart' } });
  expect(deliveries).toEqual(['alice']);
  await replacement.resetAll();
  expect(restored.tokenState(active)).toBe('unknown');
});
