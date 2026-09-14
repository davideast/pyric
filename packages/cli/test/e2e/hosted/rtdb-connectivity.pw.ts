import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

function startConnectivityFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firebase.json': '{"database":{"rules":"database.rules.json"}}',
      'database.rules.json': '{"rules":{".read":"auth != null",".write":"auth != null"}}',
      'index.html': '<output id="connected">Starting</output><output id="history"></output><output id="parent"></output><output id="once"></output><output id="stopped"></output><button id="stop">Stop observing</button><output id="deletion"></output><button id="delete">Delete and listen again</button><button id="offline">Go offline</button><button id="online">Go online</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { deleteApp, initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { getDatabase, goOffline, goOnline, onValue, ref, set } from 'firebase/database';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const db = getDatabase(app);
        await set(ref(db, 'connectivity/owner'), 'ready');
        document.querySelector('#offline').addEventListener('click', () => goOffline(db));
        document.querySelector('#online').addEventListener('click', () => goOnline(db));
        const connectivity = ref(db, '.info/connected');
        onValue(ref(db, '.info'), (snapshot) => {
          document.querySelector('#parent').textContent = JSON.stringify(snapshot.val());
        });
        document.querySelector('#delete').addEventListener('click', async () => {
          await deleteApp(app);
          const result = document.querySelector('#deletion');
          try {
            onValue(connectivity, () => { result.textContent = 'Unexpected snapshot'; },
              (error) => { result.textContent = error.message; });
          } catch (error) {
            result.textContent = error.message;
          }
        });
        const once = [];
        const stopped = [];
        onValue(connectivity, (snapshot) => {
          once.push(snapshot.val());
          document.querySelector('#once').textContent = JSON.stringify(once);
        }, { onlyOnce: true });
        const stop = onValue(connectivity, (snapshot) => {
          stopped.push(snapshot.val());
          document.querySelector('#stopped').textContent = JSON.stringify(stopped);
        });
        document.querySelector('#stop').addEventListener('click', () => stop());
        const history = [];
        onValue(connectivity, (snapshot) => {
          const connected = snapshot.val();
          history.push(connected);
          document.querySelector('#connected').textContent = String(connected);
          document.querySelector('#history').textContent = JSON.stringify(history);
        });
      `,
    },
  });
}

for (const keepsRtdbOffline of [false, true]) {
  const title = keepsRtdbOffline
    ? 'socket recovery preserves an explicit RTDB offline choice'
    : 'an RTDB connectivity listener reports hosted socket loss and recovery';
  test(title, async ({ browser }) => {
    const serve = await startConnectivityFixture();
    const context = await browser.newContext();
    const otherContext = await browser.newContext();
    const resume = Promise.withResolvers<void>();
    const restored = Promise.withResolvers<void>();
    let interrupted = false;
    let cutConnection: (() => Promise<void>) | undefined;
    try {
      await context.routeWebSocket('**/*', (route) => {
        const server = route.connectToServer();
        route.onMessage(async (data) => {
          const frame: unknown = JSON.parse(data.toString());
          const isBridgeFrame = isBridgeMessage(frame);
          if (isBridgeFrame) {
            const holdsReconnect = interrupted && frame.type === 'attach';
            if (holdsReconnect) await resume.promise;
            const isWorkerRequest = frame.type === 'worker-message';
            if (isWorkerRequest) {
              const request = frame.message;
              const writesInitialState = request.t === 'op' && request.method === 'rtdb.set';
              if (writesInitialState) {
                cutConnection = async () => {
                  interrupted = true;
                  await route.close({ code: 1001, reason: 'Fixture interrupted the app connection' });
                  await server.close();
                };
              }
            }
          }
          server.send(data);
        });
        server.onMessage((data) => {
          const frame: unknown = JSON.parse(data.toString());
          const isBridgeFrame = isBridgeMessage(frame);
          if (isBridgeFrame) {
            const isRestored = interrupted && frame.type === 'attach-ack';
            if (isRestored) restored.resolve();
          }
          route.send(data);
        });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(serve.info.url);
      await expect(page.locator('#connected')).toHaveText('true');
      const otherPage = await otherContext.newPage();
      await otherPage.goto(serve.info.url);
      await expect(otherPage.locator('#connected')).toHaveText('true');
      const cut = cutConnection;
      const hasNoAppSocket = cut === undefined;
      if (hasNoAppSocket) throw new Error('The app never sent its initial RTDB write.');

      if (keepsRtdbOffline) {
        await page.getByRole('button', { name: 'Go offline', exact: true }).click();
        await expect(page.locator('#connected')).toHaveText('false');
      }
      await cut();

      await expect(page.locator('#connected')).toHaveText('false');
      await expect(otherPage.locator('#history')).toHaveText('[true]');
      resume.resolve();
      await restored.promise;
      if (keepsRtdbOffline) {
        await expect(page.locator('#history')).toHaveText('[true,false]');
        await page.getByRole('button', { name: 'Go online', exact: true }).click();
      }
      await expect(page.locator('#connected')).toHaveText('true');
      await expect(page.locator('#history')).toHaveText('[true,false,true]');
      expect(errors).toEqual([]);
    } finally {
      resume.resolve();
      await Promise.all([context.close(), otherContext.close()]).finally(() => serve.stop());
    }
  });
}

test('RTDB goOffline and goOnline update hosted connectivity listeners', async ({ page }) => {
  const serve = await startConnectivityFixture();
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#connected')).toHaveText('true');

    await page.getByRole('button', { name: 'Go offline', exact: true }).click();

    await expect(page.locator('#connected')).toHaveText('false');
    await page.getByRole('button', { name: 'Go online', exact: true }).click();
    await expect(page.locator('#connected')).toHaveText('true');
    await expect(page.locator('#history')).toHaveText('[true,false,true]');
  } finally {
    await serve.stop();
  }
});


for (const hosting of ['hosted', 'SharedWorker', 'in-page']) {
  test(`a deleted ${hosting} app refuses a new RTDB connectivity listener`, async ({ page }) => {
    const usesHostedSandbox = hosting === 'hosted';
    const flags = usesHostedSandbox ? ['--hosted', '--no-capture'] : ['--no-capture'];
    const serve = await startConnectivityFixture(flags);
    try {
      const usesInPageSandbox = hosting === 'in-page';
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url);
      await expect(page.locator('#connected')).toHaveText('true');

      await page.getByRole('button', { name: 'Delete and listen again', exact: true }).click();

      const expectedError = usesInPageSandbox
        ? 'FIREBASE FATAL ERROR: Cannot call ref on a deleted database. '
        : 'FIREBASE FATAL ERROR: Database has been deleted.';
      await expect(page.locator('#deletion')).toHaveText(expectedError);
    } finally {
      await serve.stop();
    }
  });
}


test('RTDB goOffline and goOnline update SharedWorker connectivity listeners', async ({ page }) => {
  const serve = await startConnectivityFixture(['--no-capture']);
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#connected')).toHaveText('true');
    await page.getByRole('button', { name: 'Go offline', exact: true }).click();
    await expect(page.locator('#connected')).toHaveText('false');
    await page.getByRole('button', { name: 'Go online', exact: true }).click();
    await expect(page.locator('#history')).toHaveText('[true,false,true]');
  } finally {
    await serve.stop();
  }
});

for (const hosting of ['hosted', 'SharedWorker', 'in-page']) {
  test(`${hosting} connectivity honors unsubscribe and onlyOnce`, async ({ page }) => {
    const usesHostedSandbox = hosting === 'hosted';
    const flags = usesHostedSandbox ? ['--hosted', '--no-capture'] : ['--no-capture'];
    const serve = await startConnectivityFixture(flags);
    try {
      const usesInPageSandbox = hosting === 'in-page';
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url);
      await expect(page.locator('#once')).toHaveText('[true]');
      await expect(page.locator('#stopped')).toHaveText('[true]');
      await page.getByRole('button', { name: 'Stop observing', exact: true }).click();
      await page.getByRole('button', { name: 'Go offline', exact: true }).click();
      await expect(page.locator('#connected')).toHaveText('false');
      await page.getByRole('button', { name: 'Go online', exact: true }).click();
      await expect(page.locator('#history')).toHaveText('[true,false,true]');
      await expect(page.locator('#once')).toHaveText('[true]');
      await expect(page.locator('#stopped')).toHaveText('[true]');
    } finally {
      await serve.stop();
    }
  });
}


for (const hosting of ['hosted', 'SharedWorker', 'in-page']) {
  test(`RTDB parent metadata follows the ${hosting} app connectivity`, async ({ page }) => {
    const usesHostedSandbox = hosting === 'hosted';
    const flags = usesHostedSandbox ? ['--hosted', '--no-capture'] : ['--no-capture'];
    const serve = await startConnectivityFixture(flags);
    try {
      const usesInPageSandbox = hosting === 'in-page';
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url);
      await expect(page.locator('#parent')).toHaveText('{"connected":true,"serverTimeOffset":0}');

      await page.getByRole('button', { name: 'Go offline', exact: true }).click();

      await expect(page.locator('#parent')).toHaveText('{"connected":false,"serverTimeOffset":0}');
      await page.getByRole('button', { name: 'Go online', exact: true }).click();
      await expect(page.locator('#parent')).toHaveText('{"connected":true,"serverTimeOffset":0}');
    } finally {
      await serve.stop();
    }
  });
}


test('in-page RTDB connectivity follows explicit network controls', async ({ browser }) => {
  const serve = await startConnectivityFixture(['--no-capture']);
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
    });
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await expect(page.locator('#connected')).toHaveText('true');

    await page.getByRole('button', { name: 'Go offline', exact: true }).click();

    await expect(page.locator('#connected')).toHaveText('false');
    await page.getByRole('button', { name: 'Go online', exact: true }).click();
    await expect(page.locator('#history')).toHaveText('[true,false,true]');
  } finally {
    await context.close().finally(() => serve.stop());
  }
});
