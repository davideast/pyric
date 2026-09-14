import { test } from '@playwright/test';
import { assertMalformedWriteRecovery } from './malformed-write-fixture.js';

const invalidIds = [
  { name: 'null', value: null },
  { name: 'missing', value: undefined },
  { name: 'number', value: 7 },
  { name: 'boolean', value: false },
  { name: 'array', value: [] },
  { name: 'object', value: {} },
];

for (const scenario of invalidIds) {
  test(`a ${scenario.name} request ID rejects the write before mutation and permits app recovery`, async ({ browser }) => {
    await assertMalformedWriteRecovery(browser, frame => JSON.stringify({ ...frame, message: { ...frame.message, id: scenario.value } }));
  });
}
