import { test } from '@playwright/test';
import { assertMalformedWriteRecovery } from './malformed-write-fixture.js';

const malformedMessages = [
  { name: 'null', value: null },
  { name: 'array', value: [] },
  { name: 'number', value: 7 },
  { name: 'boolean', value: false },
  { name: 'missing message', value: undefined },
  { name: 'missing type', value: {} },
  { name: 'string', value: 'invalid' },
  { name: 'unknown message type', value: { t: 'unsupported' } },
];

for (const scenario of malformedMessages) {
  test(`worker envelope with ${scenario.name} cannot leave a request pending or interrupt another app`, async ({ browser }) => {
    await assertMalformedWriteRecovery(browser, frame => JSON.stringify({ ...frame, message: scenario.value }));
  });
}
