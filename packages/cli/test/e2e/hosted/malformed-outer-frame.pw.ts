import { test } from '@playwright/test';
import { assertMalformedWriteRecovery } from './malformed-write-fixture.js';

const invalidFrames = [
  { name: 'invalid JSON', wire: '{' },
  { name: 'unknown frame type', wire: '{"type":"unsupported"}' },
  { name: 'null frame', wire: 'null' },
  { name: 'array frame', wire: '[]' },
  { name: 'number frame', wire: '7' },
  { name: 'string frame', wire: '"invalid"' },
  { name: 'missing frame type', wire: '{}' },
  { name: 'non-string frame type', wire: '{"type":7}' },
];

for (const scenario of invalidFrames) {
  test(`${scenario.name} rejects the write before mutation and permits app recovery`, async ({ browser }) => {
    await assertMalformedWriteRecovery(browser, () => scenario.wire);
  });
}
