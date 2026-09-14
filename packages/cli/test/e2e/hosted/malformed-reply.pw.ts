import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('a malformed host reply rejects the pending SDK read while another browser remains usable', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'index.html': '<output id="result">Starting</output><button id="read" disabled>Read document</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getDoc, getFirestore } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const documentRef = doc(getFirestore(app), 'requests', 'example');
        const result = document.querySelector('#result');
        const button = document.querySelector('#read');
        button.addEventListener('click', async () => {
          result.textContent = 'Pending';
          try {
            const snapshot = await getDoc(documentRef);
            const documentExists = snapshot.exists();
            result.textContent = documentExists ? 'Found' : 'Missing';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
        button.disabled = false;
        result.textContent = 'Ready';
      `,
    },
  });
  const brokenContext = await browser.newContext();
  const healthyContext = await browser.newContext();
  try {
    let readId: string | undefined;
    await brokenContext.routeWebSocket('**/*', (route) => {
      const server = route.connectToServer();
      route.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isWorkerRequest = frame.type === 'worker-message';
          if (isWorkerRequest) {
            const request = frame.message;
            const isRead = request.t === 'op' && request.method === 'getDoc';
            if (isRead) readId = request.id;
          }
        }
        server.send(data);
      });
      server.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isWorkerReply = frame.type === 'worker-message-result';
          if (isWorkerReply) {
            const reply = frame.message;
            const isReadReply = readId !== undefined && reply.t === 'res' && reply.id === readId;
            if (isReadReply) {
              route.send('{');
              return;
            }
          }
        }
        route.send(data);
      });
    });
    const brokenPage = await brokenContext.newPage();
    const errors: string[] = [];
    brokenPage.on('pageerror', (error) => errors.push(error.message));
    await brokenPage.goto(serve.info.url);
    await expect(brokenPage.locator('#result')).toHaveText('Ready');
    await brokenPage.getByRole('button', { name: 'Read document' }).click();

    await expect(brokenPage.locator('#result')).toHaveText(
      'unavailable: The hosted sandbox sent invalid JSON. Requests already sent may have completed; check state before retrying.',
    );
    expect(errors).toEqual([]);

    const healthyPage = await healthyContext.newPage();
    await healthyPage.goto(serve.info.url);
    await healthyPage.getByRole('button', { name: 'Read document' }).click();
    await expect(healthyPage.locator('#result')).toHaveText('Missing');
  } finally {
    await brokenContext.close();
    await healthyContext.close();
    await serve.stop();
  }
});
