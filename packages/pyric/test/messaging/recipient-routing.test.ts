import { expect, test } from 'bun:test';
import { MessagingBroker } from '../../src/messaging/broker/broker.js';

test('a token targets its recipient and uses only that recipient’s visibility', () => {
  const broker = new MessagingBroker();
  const aliceToken = broker.getTokenFor('alice-registration', 'alice');
  broker.getTokenFor('david-registration', 'david');
  const deliveries: string[] = [];
  broker.onForegroundMessage(() => deliveries.push('alice foreground'), 'alice');
  broker.onBackgroundMessage(() => deliveries.push('alice background'), 'alice');
  broker.onForegroundMessage(() => deliveries.push('david foreground'), 'david');
  broker.setClientVisibility('alice-tab', 'hidden', 'alice');
  broker.setClientVisibility('david-tab', 'visible', 'david');

  broker.send({ token: aliceToken, data: { message: 'For Alice' } });

  expect(deliveries).toEqual(['alice background']);
});

for (const target of [{ topic: 'orbit' }, { condition: "'orbit' in topics && !('muted' in topics)" }]) {
  test(`topic membership limits ${JSON.stringify(target)} to matching recipients`, () => {
    const broker = new MessagingBroker();
    const alice = broker.getTokenFor('alice-registration', 'alice');
    const david = broker.getTokenFor('david-registration', 'david');
    broker.getTokenFor('outsider-registration', 'outsider');
    const deliveries: string[] = [];
    for (const recipient of ['alice', 'david', 'outsider']) {
      broker.onBackgroundMessage(() => deliveries.push(recipient), recipient);
    }
    broker.subscribeToTopic([alice, david], 'orbit');
    broker.unsubscribeFromTopic([david], 'orbit');
    broker.send({ ...target, data: { message: 'For members' } });
    expect(deliveries).toEqual(['alice']);
    broker.deleteTokenFor('alice-registration');
    broker.send({ ...target, data: { message: 'No active members' } });
    expect(deliveries).toEqual(['alice']);
  });
}
