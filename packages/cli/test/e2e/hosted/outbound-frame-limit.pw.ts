import { test } from '@playwright/test';
import { assertOversizedResponseRefusal } from './outbound-response-fixture.js';

test('an oversized collection response rejects only its request before socket delivery', async ({ browser }) => {
  await assertOversizedResponseRefusal(browser, 'read');
});

test('an oversized listener snapshot rejects without reconnecting the app', async ({ browser }) => {
  await assertOversizedResponseRefusal(browser, 'listen');
});
