import assert from 'node:assert/strict';
import test from 'node:test';
import { showPersistentNotification } from '../src/services/notification-display.ts';

test('uses the persistent service-worker display surface when available', async () => {
  const shown: Array<{ title: string; options?: NotificationOptions }> = [];
  let usedPageConstructor = false;
  const registration = {
    showNotification: async (title: string, options?: NotificationOptions) => {
      shown.push({ title, options });
    },
  };
  class PageNotification {
    constructor() {
      usedPageConstructor = true;
    }
  }

  await showPersistentNotification(
    registration,
    'PyChat',
    { body: 'Assistant reply', tag: 'conversation-1' },
    PageNotification as unknown as typeof Notification,
  );

  assert.deepEqual(shown, [{ title: 'PyChat', options: { body: 'Assistant reply', tag: 'conversation-1' } }]);
  assert.equal(usedPageConstructor, false);
});
