import { test, expect, type Browser } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('a non-string wire document path rejects the write without affecting another client', async ({ browser }) => {
  await rejectMalformedWritePath(browser, "await setDoc(reference, { message: 'Accepted' });");
});

test('a non-string wire batch path rejects the writes without affecting another client', async ({ browser }) => {
  await rejectMalformedWritePath(browser, `
    const batch = writeBatch(db);
    batch.set(reference, { message: 'Accepted' });
    await batch.commit();
  `);
});

test('a non-string wire transaction path rejects the writes without affecting another client', async ({ browser }) => {
  await rejectMalformedWritePath(browser, `
    await runTransaction(db, async (transaction) => {
      transaction.set(reference, { message: 'Accepted' });
    });
  `);
});

test('SharedWorker rejects a non-string document path while another tab works', async ({ browser }) => {
  await rejectMalformedWritePath(browser, "await setDoc(reference, { message: 'Accepted' });", 'SharedWorker');
});

test('SharedWorker rejects a non-string batch path while another tab works', async ({ browser }) => {
  await rejectMalformedWritePath(browser, `
    const batch = writeBatch(db);
    batch.set(reference, { message: 'Accepted' });
    await batch.commit();
  `, 'SharedWorker');
});

test('SharedWorker rejects a non-string transaction path while another tab works', async ({ browser }) => {
  await rejectMalformedWritePath(browser, `
    await runTransaction(db, async (transaction) => {
      transaction.set(reference, { message: 'Accepted' });
    });
  `, 'SharedWorker');
});

async function rejectMalformedWritePath(browser: Browser, write: string, transport: 'hosted' | 'SharedWorker' = 'hosted'): Promise<void> {
  const isHosted = transport === 'hosted';
  const usesSharedWorker = transport === 'SharedWorker';
  const flags = ['--no-capture'];
  if (isHosted) flags.push('--hosted');
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /payloads/first { allow read, write: if true; } } }",
      'index.html': '<button id="write" disabled>Write document</button><button id="read" disabled>Read document</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc, writeBatch, runTransaction } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const reference = doc(db, 'payloads', 'first');
        const result = document.querySelector('#result');
        const writeButton = document.querySelector('#write');
        const readButton = document.querySelector('#read');
        writeButton.addEventListener('click', async () => {
          try {
            ${write}
            result.textContent = 'Written';
          } catch (error) {
            result.textContent = error.code;
          }
        });
        readButton.addEventListener('click', async () => {
          try {
            const snapshot = await getDoc(reference);
            const documentExists = snapshot.exists();
            if (documentExists) result.textContent = snapshot.data().message;
            else result.textContent = 'Missing';
          } catch (error) {
            result.textContent = error.code;
          }
        });
        writeButton.disabled = false;
        readButton.disabled = false;
        result.textContent = 'Ready';
      `,
    },
  });
  const brokenContext = await browser.newContext();
  let healthyContext = brokenContext;
  if (isHosted) healthyContext = await browser.newContext();
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
              const invalidRequest = { ...request, path: [request.path] };
              const invalidFrame = { ...frame, message: invalidRequest };
              server.send(JSON.stringify(invalidFrame));
              return;
            }
            const isAtomicWrite = request.t === 'op' && (request.method === 'batchCommit' || request.method === 'txnCommit');
            if (isAtomicWrite) {
              const writes = request.writes.map((write) => ({ ...write, path: [write.path] }));
              server.send(JSON.stringify({ ...frame, message: { ...request, writes } }));
              return;
            }
          }
        }
        server.send(data);
      });
      server.onMessage((data) => route.send(data));
    });
    const brokenPage = await brokenContext.newPage();
    if (usesSharedWorker) {
      await brokenPage.addInitScript({ content: `
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message, ...options) {
          const isMessage = message !== null && typeof message === 'object';
          if (isMessage) {
            const isWrite = message.t === 'op' && message.method === 'setDoc';
            if (isWrite) message = { ...message, path: [message.path] };
            const isAtomicWrite = message.t === 'op' && (message.method === 'batchCommit' || message.method === 'txnCommit');
            if (isAtomicWrite) {
              const writes = message.writes.map((write) => ({ ...write, path: [write.path] }));
              message = { ...message, writes };
            }
          }
          return post.call(this, message, ...options);
        };
      ` });
    }
    const errors: string[] = [];
    brokenPage.on('pageerror', (error) => errors.push(error.message));
    await brokenPage.goto(serve.info.url);
    await expect(brokenPage.locator('#result')).toHaveText('Ready');
    await brokenPage.getByRole('button', { name: 'Write document', exact: true }).click();
    await expect(brokenPage.locator('#result')).toHaveText('invalid-argument');

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
    await brokenPage.getByRole('button', { name: 'Read document', exact: true }).click();
    await expect(brokenPage.locator('#result')).toHaveText('Accepted');
    expect(errors).toEqual([]);
  } finally {
    const hasSeparateContext = healthyContext !== brokenContext;
    if (hasSeparateContext) await healthyContext.close();
    await brokenContext.close();
    await serve.stop();
  }
}
