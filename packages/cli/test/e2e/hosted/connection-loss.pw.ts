import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

function startConnectionFixture() {
  return startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'index.html': '<output id="result">Starting</output><output id="app"></output><output id="listener">Starting</output><button id="read" disabled>Read document</button><button id="stop">Stop listening</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { getApp, initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getDoc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const documentRef = doc(getFirestore(app), 'connection', 'example');
        await setDoc(documentRef, { value: 'saved' });
        const result = document.querySelector('#result');
        const listener = document.querySelector('#listener');
        const stopListening = onSnapshot(documentRef, (snapshot) => {
          listener.textContent = snapshot.data()?.value;
        });
        document.querySelector('#stop').addEventListener('click', () => {
          stopListening();
          listener.textContent = 'Stopped';
        });
        const readButton = document.querySelector('#read');
        readButton.addEventListener('click', async () => {
          try {
            await getDoc(documentRef);
            result.textContent = 'Read';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
          document.querySelector('#app').textContent = getApp().name;
        });
        readButton.disabled = false;
        result.textContent = 'Ready';
      `,
    },
  });
}

test('an SDK read issued after hosted connection loss reports unavailable without deleting its app', async ({ page }) => {
  const serve = await startConnectionFixture();
  try {
    const connected = page.waitForEvent('websocket');
    await page.goto(serve.info.url);
    await expect(page.locator('#result')).toHaveText('Ready');
    const socket = await connected;
    const closed = socket.waitForEvent('close');
    await serve.stop();
    await closed;

    await page.getByRole('button', { name: 'Read document' }).click();

    await expect(page.locator('#result')).toHaveText('unavailable: The hosted sandbox connection is closed.');
    await expect(page.locator('#app')).toHaveText('[DEFAULT]');
  } finally {
    await serve.stop();
  }
});

test('an app can unsubscribe repeatedly after hosted connection loss', async ({ page }) => {
  const serve = await startConnectionFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const connected = page.waitForEvent('websocket');
    await page.goto(serve.info.url);
    await expect(page.locator('#listener')).toHaveText('saved');
    const socket = await connected;
    const closed = socket.waitForEvent('close');
    await serve.stop();
    await closed;

    await page.getByRole('button', { name: 'Stop listening' }).click();
    await page.getByRole('button', { name: 'Stop listening' }).click();

    await expect(page.locator('#listener')).toHaveText('Stopped');
    expect(errors).toEqual([]);
  } finally {
    await serve.stop();
  }
});
