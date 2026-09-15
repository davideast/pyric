import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { installEnvelopeReplyFault } from './document-reply-fault.js';

const malformed = [null, {}, { id: 'greeting', exists: 'yes' },
  { id: 7, exists: false }, { id: 'greeting', exists: true, data: { json: 7 } },
  { id: 'greeting', exists: false, path: 7 }];

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode}: malformed document results reject with a structured error`, async ({ page }) => {
    const isHosted = mode === 'hosted';
    const fixture = await startSoakServe({
      flags: isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await installEnvelopeReplyFault(page, 'res');
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
          document.documentElement.dataset.fault = JSON.stringify({ t: 'res', id: '$correlation', ok: true, value: frame });
          document.documentElement.dataset.inject = String(index);
          try {
            return await getDoc(reference).then(() => 'accepted', error => error.code);
          } finally { await deleteApp(app); }
        }, { index, frame });
        expect.soft(outcome, JSON.stringify(frame)).toBe('invalid-argument');
      }
      await page.locator('#write').click();
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
