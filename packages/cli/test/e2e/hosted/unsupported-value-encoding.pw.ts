import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('an unsupported value encoding rejects the write without affecting another client', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /encoding/first { allow read, write: if true; } } }",
      'index.html': '<button id="write" disabled>Write document</button><button id="read" disabled>Read document</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const reference = doc(db, 'encoding', 'first');
        const result = document.querySelector('#result');
        const writeButton = document.querySelector('#write');
        const readButton = document.querySelector('#read');
        writeButton.addEventListener('click', async () => {
          try {
            await setDoc(reference, { message: 'Accepted' });
            result.textContent = 'Written';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
        readButton.addEventListener('click', async () => {
          try {
            const snapshot = await getDoc(reference);
            const documentExists = snapshot.exists();
            if (documentExists) result.textContent = snapshot.data().message;
            else result.textContent = 'Missing';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
        writeButton.disabled = false;
        readButton.disabled = false;
        result.textContent = 'Ready';
      `,
    },
  });
  const brokenContext = await browser.newContext();
  const healthyContext = await browser.newContext();
  try {
    await brokenContext.routeWebSocket('**/*', (route) => {
      const server = route.connectToServer();
      route.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isWorkerRequest = frame.type === 'worker-message';
          if (isWorkerRequest) {
            const request = frame.message;
            const isWrite = request.t === 'op' && request.method === 'setDoc';
            if (isWrite) {
              const invalidRequest = { ...request, valueEncoding: 'pyric/firestore-values/999' };
              const invalidFrame = { ...frame, message: invalidRequest };
              server.send(JSON.stringify(invalidFrame));
              return;
            }
          }
        }
        server.send(data);
      });
      server.onMessage((data) => route.send(data));
    });
    const brokenPage = await brokenContext.newPage();
    const errors: string[] = [];
    brokenPage.on('pageerror', (error) => errors.push(error.message));
    await brokenPage.goto(serve.info.url);
    await expect(brokenPage.locator('#result')).toHaveText('Ready');
    await brokenPage.getByRole('button', { name: 'Write document', exact: true }).click();
    await expect(brokenPage.locator('#result')).toHaveText('invalid-argument: Unsupported Firestore value encoding.');

    const healthyPage = await healthyContext.newPage();
    healthyPage.on('pageerror', (error) => errors.push(error.message));
    await healthyPage.goto(serve.info.url);
    await expect(healthyPage.locator('#result')).toHaveText('Ready');
    await healthyPage.getByRole('button', { name: 'Read document', exact: true }).click();
    await expect(healthyPage.locator('#result')).toHaveText('Missing');
    await healthyPage.getByRole('button', { name: 'Write document', exact: true }).click();
    await expect(healthyPage.locator('#result')).toHaveText('Written');
    await healthyPage.getByRole('button', { name: 'Read document', exact: true }).click();
    await expect(healthyPage.locator('#result')).toHaveText('Accepted');
    expect(errors).toEqual([]);
  } finally {
    await brokenContext.close();
    await healthyContext.close();
    await serve.stop();
  }
});
