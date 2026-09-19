import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { queryFilterOutcome, type QueryOperation, type FilterWrapper } from './query-filter-fixture.js';
import { startSoakServe } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

const modes = ['hosted', 'sharedworker', 'inpage'] as const;
for (const mode of modes) {
  test(`${mode} refuses unsupported operators before row matching or composite short circuits`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        for (const data of [{ rank: 1, tags: ['a'] }, { rank: 2, tags: ['b'] }, { rank: 3, tags: ['a', 'b'] }]) {
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'ranked', String(data.rank)), data);
        }
      });
      const operations: QueryOperation[] = ['read', 'count', 'listen'];
      const wrappers: FilterWrapper[] = ['plain', 'and', 'or'];
      for (const operator of ['===', '', undefined, null, 7, false, [], {}]) {
        for (const collection of ['ranked', 'empty']) {
          for (const wrapper of wrappers) {
            for (const operation of operations) {
              const args = JSON.stringify({ operator, field: 'rank', value: 2 });
              expect(await queryFilterOutcome(page, { args, collection, wrapper, operation })).toEqual({
                kind: 'failed', code: 'invalid-argument', message: 'Unsupported Firestore filter operator.',
              });
            }
          }
        }
      }
      const validFilters = [
        { operator: '<', field: 'rank', value: 2, values: [1] },
        { operator: '<=', field: 'rank', value: 2, values: [1, 2] },
        { operator: '==', field: 'rank', value: 2, values: [2] },
        { operator: '!=', field: 'rank', value: 2, values: [1, 3] },
        { operator: '>=', field: 'rank', value: 2, values: [2, 3] },
        { operator: '>', field: 'rank', value: 2, values: [3] },
        { operator: 'in', field: 'rank', value: [1, 3], values: [1, 3] },
        { operator: 'not-in', field: 'rank', value: [1, 3], values: [2] },
        { operator: 'array-contains', field: 'tags', value: 'a', values: [1, 3] },
        { operator: 'array-contains-any', field: 'tags', value: ['b'], values: [2, 3] },
      ];
      for (const { values, ...filter } of validFilters) {
        for (const operation of operations) {
          const outcome = await queryFilterOutcome(page, { args: JSON.stringify(filter), collection: 'ranked', wrapper: 'plain', operation });
          const usesCount = operation === 'count';
          if (usesCount) expect(outcome).toEqual({ kind: 'count', size: values.length });
          else expect(outcome).toEqual({ kind: 'values', values });
        }
      }
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
