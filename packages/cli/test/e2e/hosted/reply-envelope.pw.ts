import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { installEnvelopeReplyFault, installBridgeReplyFault } from './document-reply-fault.js';

const malformedFrames = [null, [], 7, {}, { t: 'unknown' },
  { t: 'res', ok: true, value: {} }, { t: 'res', id: 7, ok: true, value: {} },
  { t: 'snap', subId: null, value: {} }, { t: 'event', subId: 'events', events: {} },
  { t: 'runtime-reload', epoch: null }, { t: 'clock', state: null },
  { t: 'clock', state: { mode: 'unsupported', fixedAt: 0, offsetMs: 0 } },
];

for (const mode of ['hosted', 'shared-worker', 'hosted-outer']) {
  test(`${mode}: malformed reply envelopes terminate their work without affecting another app`, async ({ page }) => {
    const isOuter = mode === 'hosted-outer';
    const isHosted = mode !== 'shared-worker';
    const frames = isOuter ? [null, {}, { type: 'unknown' }] : malformedFrames;
    const fixture = await startSoakServe({
      flags: isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      if (isOuter) await installBridgeReplyFault(page);
      else await installEnvelopeReplyFault(page);
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      for (const [index, frame] of frames.entries()) {
        const outcome = await page.evaluate(async ({ index, frame }) => {
          const { initializeApp, deleteApp, getApps } = await import('firebase/app');
          const { getAuth, signInAnonymously } = await import('firebase/auth');
          const { getFirestore, getDoc, doc } = await import('firebase/firestore');
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }, `malformed-${index}`);
          await signInAnonymously(getAuth(app));
          document.documentElement.dataset.fault = JSON.stringify(frame);
          document.documentElement.dataset.inject = String(index);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const read = getDoc(doc(getFirestore(app), 'shared/greeting')).then(
              () => 'accepted', error => error.code,
            );
            const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve('stranded'), 1_000); });
            return await Promise.race([read, timeout]);
          } finally {
            clearTimeout(timer);
            // A terminal transport failure still removes the app, but its
            // disconnect acknowledgment cannot arrive over the closed socket.
            await deleteApp(app).catch(error => {
              const isClosedTransport = error.code === 'unavailable';
              if (isClosedTransport) return;
              throw error;
            });
            const remainsRegistered = getApps().includes(app);
            if (remainsRegistered) throw new Error('Failed transport retained its deleted app.');
          }
        }, { index, frame });
        expect.soft(outcome, JSON.stringify(frame)).toBe('unavailable');
      }
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      expect(errors).toEqual([]);
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
