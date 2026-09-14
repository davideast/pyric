import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('a hosted listener resumes with its original identity after socket loss', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /messages/shared { allow write: if request.auth != null; allow read: if request.auth.uid == resource.data.owner; } } }",
      'index.html': '<output id="identity">Starting</output><output id="document">Loading</output><script type="module" src="/observer.js"></script>',
      'writer.html': '<input aria-label="Document owner"><button disabled>Write while disconnected</button><output id="result">Starting</output><script type="module" src="/writer.js"></script>',
      'observer.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const credential = await signInAnonymously(getAuth(app));
        const reference = doc(getFirestore(app), 'messages/shared');
        await setDoc(reference, { owner: credential.user.uid, message: 'Before' });
        document.querySelector('#identity').textContent = credential.user.uid;
        onSnapshot(reference, (snapshot) => {
          document.querySelector('#document').textContent = snapshot.data().message;
        }, (error) => {
          document.querySelector('#document').textContent = error.code;
        });
      `,
      'writer.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getFirestore, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const reference = doc(getFirestore(app), 'messages/shared');
        const result = document.querySelector('#result');
        const button = document.querySelector('button');
        button.addEventListener('click', async () => {
          try {
            await setDoc(reference, { owner: document.querySelector('input').value, message: 'After' });
            result.textContent = 'Written';
          } catch (error) {
            result.textContent = error.code;
          }
        });
        result.textContent = 'Ready';
        button.disabled = false;
      `,
    },
  });
  const observerContext = await browser.newContext();
  const writerContext = await browser.newContext();
  const resume = Promise.withResolvers<void>();
  let interrupted = false;
  let cutConnection: (() => Promise<void>) | undefined;
  try {
    await observerContext.routeWebSocket('**/*', (route) => {
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
            const isSubscription = request.t === 'sub';
            if (isSubscription) {
              const target = request.target;
              const hasReferenceTarget = typeof target === 'object' && '__ref' in target;
              const isDocumentListener = hasReferenceTarget && target.__ref === 'doc';
              if (isDocumentListener) {
                cutConnection = async () => {
                  interrupted = true;
                  await route.close({ code: 1001, reason: 'Fixture interrupted the observer connection' });
                  await server.close();
                };
              }
            }
          }
        }
        server.send(data);
      });
      server.onMessage((data) => route.send(data));
    });
    const errors: string[] = [];
    const observer = await observerContext.newPage();
    observer.on('pageerror', (error) => errors.push(error.message));
    await observer.goto(serve.info.url);
    await expect(observer.locator('#document')).toHaveText('Before');
    const owner = await observer.locator('#identity').innerText();
    const writer = await writerContext.newPage();
    writer.on('pageerror', (error) => errors.push(error.message));
    await writer.goto(`${serve.info.url}/writer.html`);
    await expect(writer.locator('#result')).toHaveText('Ready');
    await writer.getByRole('textbox', { name: 'Document owner' }).fill(owner);

    const cut = cutConnection;
    const hasNoObserverSocket = cut === undefined;
    if (hasNoObserverSocket) throw new Error('The observer never sent its document subscription.');
    await cut();
    await writer.getByRole('button', { name: 'Write while disconnected', exact: true }).click();
    await expect(writer.locator('#result')).toHaveText('Written');
    resume.resolve();
    await expect(observer.locator('#document')).toHaveText('After');
    await expect(observer.locator('#identity')).toHaveText(owner);
    expect(errors).toEqual([]);
  } finally {
    resume.resolve();
    await Promise.all([observerContext.close(), writerContext.close()]).finally(() => serve.stop());
  }
});
