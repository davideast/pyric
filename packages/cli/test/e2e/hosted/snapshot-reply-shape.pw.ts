import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { installEnvelopeReplyFault } from './document-reply-fault.js';

const malformed = [
  { t: 'snap', subId: '$correlation' },
  ...[null, false, {}, 'Denied', { code: 7, message: 'Denied' }, { code: 'denied', message: null }]
    .map(error => ({ t: 'snap', subId: '$correlation', value: { __error: error } })),
];

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode}: malformed snapshot errors terminate the listener before later delivery`, async ({ page }) => {
    const isHosted = mode === 'hosted';
    const fixture = await startSoakServe({
      flags: isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await installEnvelopeReplyFault(page, 'snap');
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      for (const [index, frame] of malformed.entries()) {
        const outcome = await page.evaluate(async ({ index, frame }) => {
          const { initializeApp, deleteApp } = await import('firebase/app');
          const { getAuth, signInAnonymously } = await import('firebase/auth');
          const { getFirestore, getDoc, setDoc, doc, onSnapshot } = await import('firebase/firestore');
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }, `snapshot-${index}`);
          await signInAnonymously(getAuth(app));
          const reference = doc(getFirestore(app), 'shared/greeting');
          document.documentElement.dataset.fault = JSON.stringify(frame);
          document.documentElement.dataset.inject = String(index);
          const result = Promise.withResolvers<string>();
          let deliveries = 0;
          const stop = onSnapshot(reference, () => {
            deliveries += 1;
            result.resolve('accepted');
          }, error => result.resolve(error.code));
          const timer = setTimeout(() => result.resolve('stranded'), 1_000);
          try {
            const error = await result.promise;
            await setDoc(reference, { message: `After malformed listener ${index}` });
            await getDoc(reference);
            return { error, deliveries };
          } finally {
            clearTimeout(timer);
            stop();
            await deleteApp(app);
          }
        }, { index, frame });
        expect.soft(outcome, JSON.stringify(frame)).toEqual({ error: 'unavailable', deliveries: 0 });
      }
      await page.locator('#write').click();
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
