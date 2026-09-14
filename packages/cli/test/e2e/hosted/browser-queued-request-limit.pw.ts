import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

test('an oversized startup write refuses before attach without discarding accepted work', async ({ page }) => {
  const fixture = await startHostedFixture();
  let holdAttach = false;
  const held = Promise.withResolvers<() => void>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    server.onMessage(data => {
      const frame: unknown = JSON.parse(data.toString());
      const isHeldAttach = holdAttach && isBridgeMessage(frame) && frame.type === 'attach-ack';
      if (isHeldAttach) {
        held.resolve(() => route.send(data));
        return;
      }
      route.send(data);
    });
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
    holdAttach = true;
    await page.evaluate(async () => {
      const { initializeApp } = await import('firebase/app');
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const sdk = await import('firebase/firestore');
      const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }, 'queued-frame');
      const db = sdk.getFirestore(app);
      const oversized = document.createElement('output');
      oversized.id = 'oversized';
      oversized.textContent = 'Pending';
      const accepted = document.createElement('output');
      accepted.id = 'accepted';
      accepted.textContent = 'Pending';
      document.body.append(oversized, accepted);
      const signedIn = signInAnonymously(getAuth(app));
      sdk.setDoc(sdk.doc(db, 'shared/oversized'), { message: 'é'.repeat(6 * 1024 * 1024) }).then(
        () => { oversized.textContent = 'Written'; },
        error => { oversized.textContent = error.code; },
      );
      signedIn.then(async () => {
        await sdk.setDoc(sdk.doc(db, 'shared/greeting'), { message: 'Accepted startup work' });
        accepted.textContent = 'Written';
      }, error => { accepted.textContent = error.code; });
    });
    const release = await held.promise;
    await expect(page.locator('#oversized')).toHaveText('resource-exhausted');
    await expect(page.locator('#accepted')).toHaveText('Pending');
    holdAttach = false;
    release();
    await expect(page.locator('#accepted')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Accepted startup work');
    const rejectedWriteExists = await page.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'shared/oversized'))).exists();
    });
    expect(rejectedWriteExists).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await fixture.stop();
  }
});
