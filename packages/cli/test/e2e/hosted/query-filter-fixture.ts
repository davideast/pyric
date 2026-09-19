import type { Page } from '@playwright/test';

export type QueryOperation = 'read' | 'count' | 'listen';
export type FilterWrapper = 'plain' | 'and' | 'or';

export async function queryFilterOutcome(page: Page, input: { args: string; collection: string; wrapper: FilterWrapper; operation: QueryOperation }) {
  return page.evaluate(async ({ args, collection, wrapper, operation }) => {
    const sdk = await import('firebase/firestore');
    let unsubscribe = () => {};
    try {
      const { field, operator, value } = JSON.parse(args);
      const filter = sdk.where(field, operator, value);
      const source = sdk.query(sdk.collection(sdk.getFirestore(), collection), sdk.orderBy('rank'));
      const usesAnd = wrapper === 'and';
      const usesOr = wrapper === 'or';
      let query: typeof source;
      if (usesAnd) query = sdk.query(source, sdk.and(sdk.where('rank', '<', 0), filter));
      else if (usesOr) query = sdk.query(source, sdk.or(sdk.where('rank', '>=', 0), filter));
      else query = sdk.query(source, filter);
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
