import { test } from '@playwright/test';
import { assertMalformedWriteRecovery } from './malformed-write-fixture.js';

test('a document beyond 64 encoded containers refuses before writing and leaves clients usable', async ({ browser }) => {
  let data: unknown = 'leaf';
  let remaining = 65;
  let hasContainersRemaining = remaining > 0;
  while (hasContainersRemaining) {
    data = { nested: data };
    remaining -= 1;
    hasContainersRemaining = remaining > 0;
  }
  await assertMalformedWriteRecovery(browser, frame => JSON.stringify({
    ...frame, message: { ...frame.message, data },
  }));
});
