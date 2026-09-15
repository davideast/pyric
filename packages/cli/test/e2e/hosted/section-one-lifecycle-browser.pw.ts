import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';

test('app attachment closes its socket and rejects queued work at five seconds', async ({ browser }) => {
  const fixture = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'index.html': '<output id="result">Pending</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getFirestore, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        setDoc(doc(getFirestore(app), 'shared/attach-timeout'), { message: 'Must remain unsent' }).then(
          () => { document.querySelector('#result').textContent = 'Written'; },
          error => { document.querySelector('#result').textContent = error.code; },
        );
      `,
    },
  });
  const context = await browser.newContext();
  let held = false;
  let sockets = 0;
  let appClosed = false;
  let sentWrites = 0;
  const workers: string[] = [];
  try {
    context.on('request', request => {
      const isWorker = new URL(request.url()).pathname === '/__pyric/sdk/worker.js';
      if (isWorker) workers.push(request.url());
    });
    await context.routeWebSocket('**/*', route => {
      sockets += 1;
      const isApp = sockets === 2;
      const server = route.connectToServer();
      route.onClose(() => {
        server.close();
        if (isApp) appClosed = true;
      });
      route.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        const isWrite = isFrame && frame.type === 'worker-message' && frame.message.t === 'op' && frame.message.method === 'setDoc';
        if (isWrite) sentWrites += 1;
        server.send(data);
      });
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        const holdsAttach = isApp && isFrame && frame.type === 'attach-ack';
        if (holdsAttach) {
          held = true;
          return;
        }
        route.send(data);
      });
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
    await page.goto(fixture.info.url);
    await expect.poll(() => held, { timeout: 5_000, message: 'App attachment must reach its held acknowledgment.' }).toBe(true);
    await page.clock.runFor(4_999);
    await expect(page.locator('#result')).toHaveText('Pending');
    expect(appClosed).toBe(false);
    await page.clock.runFor(1);
    await expect(page.locator('#result')).toHaveText('unavailable');
    await expect.poll(() => appClosed).toBe(true);
    await page.clock.runFor(10_000);
    expect(sockets).toBe(2);
    expect(sentWrites).toBe(0);
    expect(workers).toEqual([]);
    expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
  } finally {
    await context.close();
    await fixture.stop();
  }
});

test('hosted reconnect has one owner and bounded exponential backoff until deletion', async ({ browser }) => {
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  let sockets = 0;
  let attempts = 0;
  let cut: (() => Promise<void>) | undefined;
  try {
    await context.addInitScript(() => {
      const NativeWebSocket = WebSocket;
      let allocated = 0;
      let closed = 0;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          allocated += 1;
          const isAppSocket = allocated >= 2;
          if (isAppSocket) this.addEventListener('close', () => {
            closed += 1;
            document.documentElement.dataset.closedAppSockets = String(closed);
          });
        }
      };
    });
    await context.routeWebSocket('**/*', route => {
      sockets += 1;
      const isInitialApp = sockets === 2;
      const isReconnect = sockets > 2;
      const server = route.connectToServer();
      if (isReconnect) {
        attempts += 1;
        route.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const isFrame = isBridgeMessage(frame);
          const attemptsAttach = isFrame && frame.type === 'attach';
          if (attemptsAttach) {
            route.close({ code: 1001, reason: 'Retry remains unavailable' });
            server.close();
            return;
          }
          server.send(data);
        });
        return;
      }
      if (isInitialApp) {
        cut = async () => {
          await route.close({ code: 1001, reason: 'Start retry sequence' });
          await server.close();
        };
      }
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const interrupt = cut;
    const hasNoApp = interrupt === undefined;
    if (hasNoApp) throw new Error('The app did not open its socket.');
    await interrupt();
    await expect(page.locator('html')).toHaveAttribute('data-closed-app-sockets', '1');
    const windows = [
      { minimum: 250, maximum: 275 },
      { minimum: 500, maximum: 550 },
      { minimum: 1_000, maximum: 1_100 },
      { minimum: 2_000, maximum: 2_200 },
      { minimum: 4_000, maximum: 4_250 },
      { minimum: 5_000, maximum: 5_000 },
      { minimum: 5_000, maximum: 5_000 },
    ];
    for (const window of windows) {
      const previousAttempts = attempts;
      await page.clock.runFor(window.minimum - 1);
      expect(attempts).toBe(previousAttempts);
      await page.clock.runFor(window.maximum - window.minimum + 1);
      await expect.poll(() => attempts).toBe(previousAttempts + 1);
      await expect(page.locator('html')).toHaveAttribute('data-closed-app-sockets', String(previousAttempts + 2));
    }
    const attemptsBeforeDeletion = attempts;
    await page.evaluate(async () => {
      const { deleteApp, getApp } = await import('firebase/app');
      await deleteApp(getApp());
    });
    await page.clock.runFor(20_000);
    expect(attempts).toBe(attemptsBeforeDeletion);
  } finally {
    await context.close();
    await fixture.stop();
  }
});
