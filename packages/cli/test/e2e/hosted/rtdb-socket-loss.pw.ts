import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('socket loss runs RTDB onDisconnect work before the hosted session expires', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firebase.json': '{"database":{"rules":"database.rules.json"}}',
      'database.rules.json': '{"rules":{".read":"auth != null",".write":"auth != null"}}',
      'index.html': '<output>Starting</output><button>Finish resumed session</button><script type="module" src="/owner.js"></script>',
      'observer.html': '<output>Starting</output><script type="module" src="/observer.js"></script>',
      'owner.js': `
        import { deleteApp, initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { getDatabase, onDisconnect, ref, set } from 'firebase/database';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const status = ref(getDatabase(app), 'presence/owner');
        await set(status, 'online');
        await onDisconnect(status).set('offline');
        document.querySelector('output').textContent = 'Ready';
        document.querySelector('button').addEventListener('click', async () => {
          try {
            await set(status, 'returned');
            await deleteApp(app);
            document.querySelector('output').textContent = 'Deleted';
          } catch (error) {
            document.querySelector('output').textContent = error.code;
          }
        });
      `,
      'observer.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { getDatabase, onValue, ref } from 'firebase/database';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        onValue(ref(getDatabase(app), 'presence/owner'), (snapshot) => {
          document.querySelector('output').textContent = snapshot.val();
        }, (error) => {
          document.querySelector('output').textContent = error.code;
        });
      `,
    },
  });
  const ownerContext = await browser.newContext();
  const observerContext = await browser.newContext();
  const resume = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  let interrupted = false;
  let cutConnection: (() => Promise<void>) | undefined;
  try {
    await ownerContext.routeWebSocket('**/*', (route) => {
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
            const registersDisconnect = request.t === 'op' && request.method === 'rtdb.onDisconnectSet';
            if (registersDisconnect) {
              cutConnection = async () => {
                interrupted = true;
                await route.close({ code: 1001, reason: 'Fixture interrupted the RTDB owner' });
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
          const isReattached = interrupted && frame.type === 'attach-ack';
          if (isReattached) resumed.resolve();
        }
        route.send(data);
      });
    });
    const errors: string[] = [];
    const owner = await ownerContext.newPage();
    owner.on('pageerror', (error) => errors.push(error.message));
    await owner.goto(serve.info.url);
    await expect(owner.locator('output')).toHaveText('Ready');
    const observer = await observerContext.newPage();
    observer.on('pageerror', (error) => errors.push(error.message));
    await observer.goto(`${serve.info.url}/observer.html`);
    await expect(observer.locator('output')).toHaveText('online');

    const cut = cutConnection;
    const hasNoOwnerSocket = cut === undefined;
    if (hasNoOwnerSocket) throw new Error('The owner never registered its disconnect operation.');
    await cut();

    await expect(observer.locator('output')).toHaveText('offline');
    resume.resolve();
    await resumed.promise;
    await owner.getByRole('button', { name: 'Finish resumed session', exact: true }).click();
    await expect(owner.locator('output')).toHaveText('Deleted');
    await observer.reload();
    await expect(observer.locator('output')).toHaveText('returned');
    expect(errors).toEqual([]);
  } finally {
    resume.resolve();
    await Promise.all([ownerContext.close(), observerContext.close()]).finally(() => serve.stop());
  }
});
