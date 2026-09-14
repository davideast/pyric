import { test, expect } from '@playwright/test';
import type { SdkRateSnapshot } from 'pyric/sandbox/internal';

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: served Firebase read aliases retain their public method names`, async ({ page }) => {
    if (runtime === 'inpage') {
      await page.addInitScript(() => {
        (globalThis as typeof globalThis & { __PYRIC_FORCE_INPAGE__: boolean }).__PYRIC_FORCE_INPAGE__ = true;
      });
    }
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('signed-out');
    const result = await page.evaluate(async () => {
      const auth = await import('firebase/auth');
      const sdk = await import('firebase/firestore');
      await auth.signInAnonymously(auth.getAuth());
      const db = sdk.getFirestore();
      const ref = sdk.doc(db, 'notes/rate-methods');
      await sdk.setDoc(ref, { measured: true });
      const snapshot = () => {
        const key = Symbol.for('pyric.sdk-rates');
        return (globalThis as unknown as Record<symbol, { snapshot(): SdkRateSnapshot }>)[key].snapshot();
      };
      const before = snapshot();
      await sdk.getDocFromServer(ref);
      await sdk.getDocFromCache(ref);
      await sdk.getDocsFromServer(sdk.collection(db, 'notes'));
      await sdk.getDocsFromCache(sdk.collection(db, 'notes'));
      return { before, after: snapshot() };
    });
    const counts = (snapshot: SdkRateSnapshot, method: string) => snapshot.services
      .find(service => service.service === 'firestore')?.methods.find(entry => entry.method === method)?.buckets
      .reduce((total, bucket) => total + bucket.calls, 0) ?? 0;
    for (const method of ['getDocFromServer', 'getDocFromCache', 'getDocsFromServer', 'getDocsFromCache']) {
      expect(counts(result.after, method) - counts(result.before, method)).toBe(1);
    }
    for (const method of ['getDoc', 'getDocs']) {
      expect(counts(result.after, method) - counts(result.before, method)).toBe(0);
    }
  });
}
