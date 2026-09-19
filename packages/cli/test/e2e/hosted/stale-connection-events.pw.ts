import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('delayed events from an old socket cannot overwrite or disconnect a recovered app', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  const control = await connectRemoteSandbox({ url: fixture.info.url });
  try {
    await context.addInitScript(() => {
      const NativeWebSocket = WebSocket;
      let holdsMessage = true;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          // Register before the SDK so the actual snapshot event can be delayed.
          this.addEventListener('message', event => {
            const isUnrelatedValue = typeof event.data !== 'string' || !event.data.includes('Delayed old value');
            if (isUnrelatedValue) return;
            const frame: unknown = JSON.parse(event.data);
            const hasEnvelope = typeof frame === 'object' && frame !== null && 'type' in frame && 'message' in frame;
            const skipsEnvelope = !hasEnvelope;
            if (skipsEnvelope) return;
            const message = frame.message;
            const isWorkerResult = frame.type === 'worker-message-result';
            const hasMessageTag = typeof message === 'object' && message !== null && 't' in message;
            const isSnapshot = isWorkerResult && hasMessageTag && message.t === 'snap';
            const delaysMessage = holdsMessage && isSnapshot;
            if (delaysMessage) {
              holdsMessage = false;
              event.stopImmediatePropagation();
              // Retain the real event; replay it only after this socket has been replaced.
              const releaseMessage = () => { this.dispatchEvent(event); };
              document.documentElement.dataset.delayedMessage = 'held';
              let releaseClose: (() => void) | undefined;
              this.addEventListener('close', closed => {
                releaseClose = () => { this.dispatchEvent(closed); };
                document.documentElement.dataset.originalClosed = 'true';
              }, { once: true });
              window.addEventListener('cut-original', () => { this.close(); }, { once: true });
              window.addEventListener('release-old-events', () => {
                releaseMessage();
                releaseClose?.();
                document.documentElement.dataset.delayedMessage = 'released';
              }, { once: true });
            }
          });
        }
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await control.channel.op({ method: 'setDoc', path: 'shared/greeting',
      data: { message: 'Delayed old value' }, actAs: { mode: 'admin' } });
    await expect(page.locator('html')).toHaveAttribute('data-delayed-message', 'held');
    await expect(page.locator('#document')).toHaveText('Empty');
    await control.channel.op({ method: 'setDoc', path: 'shared/greeting',
      data: { message: 'Current value' }, actAs: { mode: 'admin' } });
    await expect(page.locator('#document')).toHaveText('Current value');
    await page.evaluate(() => window.dispatchEvent(new Event('cut-original')));
    await expect(page.locator('html')).toHaveAttribute('data-original-closed', 'true');
    await control.channel.op({ method: 'setDoc', path: 'shared/greeting',
      data: { message: 'Recovered value' }, actAs: { mode: 'admin' } });
    await expect(page.locator('#document')).toHaveText('Recovered value');
    await page.evaluate(() => window.dispatchEvent(new Event('release-old-events')));
    await expect(page.locator('html')).toHaveAttribute('data-delayed-message', 'released');
    await expect(page.locator('#document')).toHaveText('Recovered value');
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    expect(errors).toEqual([]);
  } finally {
    control.close();
    await context.close();
    await fixture.stop();
  }
});
