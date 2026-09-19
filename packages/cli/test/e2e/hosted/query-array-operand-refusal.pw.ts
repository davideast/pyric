import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';
import { queryFilterOutcome, type QueryOperation, type FilterWrapper } from './query-filter-fixture.js';

const modes = ['hosted', 'sharedworker', 'inpage'] as const;
for (const mode of modes) {
  test(`${mode} refuses malformed membership operands and preserves valid arrays`, async ({ page, context }) => {
    const healthy = await context.newPage();
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    await prepareRuntimeFixture(healthy, mode);
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      for (const app of [page, healthy]) {
        await app.goto(fixture.info.url);
        await expect(app.locator('#document')).toHaveText('Empty');
        await expect.poll(() => app.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      }
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        for (const data of [{ rank: 1, tags: ['a'] }, { rank: 2, tags: ['b'] }, { rank: 3, tags: ['a', 'b'] }, { rank: null, tags: [] }]) {
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'ranked', String(data.rank)), data);
        }
      });
      const operations: QueryOperation[] = ['read', 'count', 'listen'];
      const wrappers: FilterWrapper[] = ['plain', 'and', 'or'];
      const invalidValues = [1, '1', true, false, null, {}, { 0: 1, length: 1 }, undefined];
      for (const operator of ['in', 'not-in', 'array-contains-any']) {
        for (const value of invalidValues) {
          for (const collection of ['ranked', 'empty']) {
            for (const wrapper of wrappers) {
              for (const operation of operations) {
                const args = JSON.stringify({ operator, field: 'rank', value });
                expect(await queryFilterOutcome(page, { args, collection, wrapper, operation })).toMatchObject({
                  kind: 'failed', code: 'invalid-argument',
                });
              }
            }
          }
        }
      }
      const validFilters = [
        { operator: 'in', field: 'rank', value: [1, 3], values: [1, 3] },
        { operator: 'in', field: 'rank', value: [null], values: [null] },
        { operator: 'in', field: 'rank', value: [], values: [] },
        { operator: 'not-in', field: 'rank', value: [1, 3], values: [2] },
        { operator: 'not-in', field: 'rank', value: [null], values: [] },
        { operator: 'not-in', field: 'rank', value: [], values: [1, 2, 3] },
        { operator: 'array-contains-any', field: 'tags', value: ['b'], values: [2, 3] },
        { operator: 'array-contains-any', field: 'tags', value: [null], values: [] },
        { operator: 'array-contains-any', field: 'tags', value: [], values: [] },
      ];
      for (const { values, ...filter } of validFilters) {
        for (const operation of operations) {
          const outcome = await queryFilterOutcome(page, { args: JSON.stringify(filter), collection: 'ranked', wrapper: 'plain', operation });
          const usesCount = operation === 'count';
          if (usesCount) expect(outcome).toEqual({ kind: 'count', size: values.length });
          else expect(outcome).toEqual({ kind: 'values', values });
        }
      }
      for (const app of [healthy, page]) {
        await app.locator('#write').click();
        await expect(app.locator('#write-result')).toHaveText('Written');
        await expect(app.locator('#document')).toHaveText('Hello from the other browser');
      }
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await healthy.close();
      await fixture.stop();
    }
  });
}
