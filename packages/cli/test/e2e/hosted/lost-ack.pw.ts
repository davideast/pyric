import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('a lost hosted write acknowledgment rejects the SDK call without repeating the committed mutation', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'index.html': '<output id="result">Starting</output><output id="resumed-count"></output><button id="write" disabled>Increment</button><button id="read">Read after reconnect</button><script type="module" src="/writer.js"></script>',
      'reader.html': '<output id="count">Loading</output><script type="module" src="/reader.js"></script>',
      'writer.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getDoc, getFirestore, increment, setDoc, updateDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const counter = doc(getFirestore(app), 'counters', 'shared');
        await setDoc(counter, { count: 0 });
        const result = document.querySelector('#result');
        const button = document.querySelector('#write');
        result.textContent = 'Ready';
        button.disabled = false;
        document.querySelector('#read').addEventListener('click', async () => {
          const snapshot = await getDoc(counter);
          document.querySelector('#resumed-count').textContent = String(snapshot.data()?.count);
        });
        button.addEventListener('click', async () => {
          result.textContent = 'Pending';
          try {
            await updateDoc(counter, { count: increment(1) });
            result.textContent = 'Acknowledged';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
      `,
      'reader.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getDoc, getFirestore } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const snapshot = await getDoc(doc(getFirestore(app), 'counters', 'shared'));
        document.querySelector('#count').textContent = String(snapshot.data()?.count);
      `,
    },
  });
  const writerContext = await browser.newContext();
  const readerContext = await browser.newContext();
  try {
    let writeId: string | undefined;
    const resumed = Promise.withResolvers<void>();
    await writerContext.routeWebSocket('**/*', (route) => {
      const server = route.connectToServer();
      route.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isWorkerRequest = frame.type === 'worker-message';
          if (isWorkerRequest) {
            const request = frame.message;
            const isIncrement = request.t === 'op' && request.method === 'updateDoc';
            if (isIncrement) writeId = request.id;
          }
        }
        server.send(data);
      });
      server.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isReattached = frame.type === 'attach-ack' && writeId !== undefined;
          if (isReattached) resumed.resolve();
          const isWorkerReply = frame.type === 'worker-message-result';
          if (isWorkerReply) {
            const reply = frame.message;
            const isWriteReply = writeId !== undefined && reply.t === 'res' && reply.id === writeId;
            if (isWriteReply) {
              route.close({ code: 1001, reason: 'Fixture dropped the write acknowledgment' });
              server.close();
              return;
            }
          }
        }
        route.send(data);
      });
    });
    const writer = await writerContext.newPage();
    await writer.goto(serve.info.url);
    await expect(writer.locator('#result')).toHaveText('Ready');
    await writer.getByRole('button', { name: 'Increment', exact: true }).click();

    await expect(writer.locator('#result')).toHaveText(
      'unavailable: The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.',
    );
    await resumed.promise;
    await writer.getByRole('button', { name: 'Read after reconnect', exact: true }).click();
    await expect(writer.locator('#resumed-count')).toHaveText('1');
    const reader = await readerContext.newPage();
    await reader.goto(`${serve.info.url}/reader.html`);
    await expect(reader.locator('#count')).toHaveText('1');
  } finally {
    await writerContext.close();
    await readerContext.close();
    await serve.stop();
  }
});
