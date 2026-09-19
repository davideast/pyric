import { test } from '@playwright/test';
import { assertQueryDepthRefusal, type QueryDepthKind } from './query-depth-fixture.js';

test('an over-deep query operand refuses while another app remains usable', async ({ browser }) => {
  await assertQueryDepthRefusal(browser, 'where');
});

test('an over-deep cursor operand refuses while another app remains usable', async ({ browser }) => {
  await assertQueryDepthRefusal(browser, 'startAt');
});

const remainingCursors: QueryDepthKind[] = ['startAfter', 'endAt', 'endBefore'];
for (const kind of remainingCursors) {
  test(`an over-deep ${kind} operand refuses while another app remains usable`, async ({ browser }) => {
    await assertQueryDepthRefusal(browser, kind);
  });
}
