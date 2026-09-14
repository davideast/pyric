import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { nestedDocument, type DocumentShape } from './document-depth-fixture.js';
import { queryDepthOutcome, type QueryDepthKind } from './query-depth-fixture.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} bounds filter and cursor operands across query operations`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#write')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      const shapes: DocumentShape[] = ['maps', 'arrays', 'escaped'];
      const kinds: QueryDepthKind[] = ['where', 'startAt', 'startAfter', 'endAt', 'endBefore'];
      for (const shape of shapes) {
        await page.evaluate(async valueJson => {
          const sdk = await import('firebase/firestore');
          const target = sdk.doc(sdk.getFirestore(), 'limits/stored');
          await sdk.setDoc(target, { value: JSON.parse(valueJson) });
        }, JSON.stringify(nestedDocument(63, shape)));
        for (const kind of kinds) {
          for (const depth of [63, 64, 65, 256]) {
            await test.step(`${kind} ${shape}: ${depth} encoded containers`, async () => {
              const outcome = await queryDepthOutcome(page, {
                valueJson: JSON.stringify(nestedDocument(depth, shape)), kind, operation: 'read',
              });
              const exceedsDepth = depth > 64;
              if (exceedsDepth) {
                expect(outcome).toEqual({
                  kind: 'failed', code: 'invalid-argument', message: 'Encoded document nesting exceeds 64 containers.',
                });
              } else {
                expect(outcome.kind).toBe('success');
                const comparesEqualValue = depth === 63;
                if (comparesEqualValue) {
                  const excludesEqualValue = kind === 'startAfter' || kind === 'endBefore';
                  const expectedCount = excludesEqualValue ? 0 : 1;
                  expect(outcome).toEqual({ kind: 'success', count: expectedCount });
                }
              }
            });
          }
        }
      }
      const operations: ('count' | 'listen')[] = ['count', 'listen'];
      for (const operation of operations) {
        for (const kind of kinds) {
          await test.step(`${operation} ${kind} rejects then accepts a valid operand`, async () => {
            const refused = await queryDepthOutcome(page, {
              valueJson: JSON.stringify(nestedDocument(65, 'escaped')), kind, operation,
            });
            expect(refused).toEqual({
              kind: 'failed', code: 'invalid-argument', message: 'Encoded document nesting exceeds 64 containers.',
            });
            const accepted = await queryDepthOutcome(page, {
              valueJson: JSON.stringify(nestedDocument(63, 'escaped')), kind, operation,
            });
            const excludesEqualValue = kind === 'startAfter' || kind === 'endBefore';
            const expectedCount = excludesEqualValue ? 0 : 1;
            expect(accepted).toEqual({ kind: 'success', count: expectedCount });
          });
        }
      }
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      expect(fixture.stderr()).not.toContain('uncaught exception');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
