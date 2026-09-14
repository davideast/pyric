import { expect, test, type Browser, type Page } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { nestedDocument } from './document-depth-fixture.js';

export type QueryDepthKind = 'where' | 'startAt' | 'startAfter' | 'endAt' | 'endBefore';

export async function assertQueryDepthRefusal(browser: Browser, kind: QueryDepthKind): Promise<void> {
  const fixture = await startHostedFixture();
  const requestingContext = await browser.newContext();
  const healthyContext = await browser.newContext();
  try {
    const requesting = await requestingContext.newPage();
    const healthy = await healthyContext.newPage();
    for (const page of [requesting, healthy]) {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
    }
    const outcome = await queryDepthOutcome(requesting, {
      valueJson: JSON.stringify(nestedDocument(65, 'maps')), kind, operation: 'read',
    });
    expect(outcome).toEqual({
      kind: 'failed',
      code: 'invalid-argument',
      message: 'Encoded document nesting exceeds 64 containers.',
    });
    await healthy.locator('#write').click();
    await expect(healthy.locator('#write-result')).toHaveText('Written');
    for (const page of [requesting, healthy]) {
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    }
    await requesting.locator('#write').click();
    await expect(requesting.locator('#write-result')).toHaveText('Written');
    expect(fixture.stderr()).not.toContain('uncaught exception');
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await requestingContext.close();
    await healthyContext.close();
    await fixture.stop();
  }
}


type QueryOutcome =
  | { kind: 'success'; count: number }
  | { kind: 'failed'; code: unknown; message: string };

export async function queryDepthOutcome(page: Page, request: {
  valueJson: string;
  kind: QueryDepthKind;
  operation: 'read' | 'count' | 'listen';
}): Promise<QueryOutcome> {
  return page.evaluate(async ({ valueJson, kind, operation }): Promise<QueryOutcome> => {
    const sdk = await import('firebase/firestore');
    const value = JSON.parse(valueJson);
    const source = sdk.collection(sdk.getFirestore(), 'limits');
    let query: ReturnType<typeof sdk.query>;
    const usesFilter = kind === 'where';
    if (usesFilter) query = sdk.query(source, sdk.where('value', '==', value));
    else query = sdk.query(source, sdk.orderBy('value'), sdk[kind](value));
    let unsubscribe = () => {};
    try {
      const usesCount = operation === 'count';
      if (usesCount) {
        const result = await sdk.getCountFromServer(query);
        return { kind: 'success', count: result.data().count };
      }
      const usesListener = operation === 'listen';
      if (usesListener) {
        const count = await new Promise<number>((resolve, reject) => {
          unsubscribe = sdk.onSnapshot(query, snapshot => resolve(snapshot.size), reject);
        });
        return { kind: 'success', count };
      }
      const result = await sdk.getDocs(query);
      return { kind: 'success', count: result.size };
    } catch (error) {
      const isError = error instanceof Error;
      const hasCode = typeof error === 'object' && error !== null && 'code' in error;
      return {
        kind: 'failed',
        code: hasCode ? error.code : null,
        message: isError ? error.message : 'Non-Error rejection',
      };
    } finally {
      unsubscribe();
    }
  }, request);
}
