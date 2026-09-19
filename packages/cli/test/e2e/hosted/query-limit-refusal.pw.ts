import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

type LimitMethod = 'limit' | 'limitToLast';
type QueryOperation = 'read' | 'count' | 'listen';
const modes = ['hosted', 'sharedworker', 'inpage'] as const;
for (const mode of modes) {
  test(`${mode} refuses malformed limits and preserves finite counts`, async ({ page, context }) => {
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
        for (const rank of [1, 2, 3]) await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'ranked', String(rank)), { rank });
      });
      const methods: LimitMethod[] = ['limit', 'limitToLast'];
      const operations: QueryOperation[] = ['read', 'count', 'listen'];
      const invalidArgs = ['["1"]', '[null]', '[true]', '[false]', '[[]]', '[{}]', '[]', 'NaN', 'Infinity', '-Infinity'];
      for (const method of methods) {
        for (const args of invalidArgs) {
          for (const operation of operations) {
            expect(await limitOutcome(page, { args, method, operation })).toEqual({
              kind: 'failed', code: 'invalid-argument', message: 'Query limit must be a finite number.',
            });
          }
        }
        const validCounts = [
          { size: 0, head: [], tail: [] },
          { size: 1, head: [1], tail: [3] },
          { size: 2, head: [1, 2], tail: [2, 3] },
          { size: 99, head: [1, 2, 3], tail: [1, 2, 3] },
        ];
        for (const { size, head, tail } of validCounts) {
          for (const operation of operations) {
            await test.step(`${method}(${size}) ${operation}`, async () => {
              const outcome = await limitOutcome(page, { args: JSON.stringify([size]), method, operation });
              const usesCount = operation === 'count';
              const usesTail = method === 'limitToLast';
              const values = usesTail ? tail : head;
              if (usesCount) expect(outcome).toEqual({ kind: 'count', size: values.length });
              else expect(outcome).toEqual({ kind: 'values', values });
            });
          }
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

async function limitOutcome(page: Page, input: { args: string; method: LimitMethod; operation: QueryOperation }) {
  return page.evaluate(async ({ args, method, operation }) => {
    const sdk = await import('firebase/firestore');
    let unsubscribe = () => {};
    try {
      const isNonFiniteName = ['NaN', 'Infinity', '-Infinity'].includes(args);
      const count = isNonFiniteName ? Number(args) : JSON.parse(args)[0];
      const query = sdk.query(sdk.collection(sdk.getFirestore(), 'ranked'), sdk.orderBy('rank'), sdk[method](count));
      const usesCount = operation === 'count';
      if (usesCount) return { kind: 'count', size: (await sdk.getCountFromServer(query)).data().count };
      const usesListener = operation === 'listen';
      if (usesListener) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          unsubscribe = sdk.onSnapshot(query, snapshot => resolve(snapshot.docs.map(doc => doc.data().rank)), reject);
        });
        return { kind: 'values', values };
      }
      const snapshot = await sdk.getDocs(query);
      return { kind: 'values', values: snapshot.docs.map(doc => doc.data().rank) };
    } catch (error) {
      const isError = error instanceof Error;
      const hasCode = typeof error === 'object' && error !== null && 'code' in error;
      return { kind: 'failed', code: hasCode ? error.code : null, message: isError ? error.message : 'Non-Error rejection' };
    } finally {
      unsubscribe();
    }
  }, input);
}
