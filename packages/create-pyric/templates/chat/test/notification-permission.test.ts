import assert from 'node:assert/strict';
import test from 'node:test';
import { requestNotificationPermission } from '../src/services/notification-permission.ts';

test('does not enable notifications when the browser permission is denied', async () => {
  let requested = false;
  const enabled = await requestNotificationPermission({
    permission: 'denied',
    requestPermission: async () => {
      requested = true;
      return 'granted';
    },
  });

  assert.equal(enabled, false);
  assert.equal(requested, false);
});
