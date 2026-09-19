import { test, expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

test('deleting an app during hosted attach cancels unsent work and closes its socket', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /cancelled/startup { allow read: if true; allow write: if request.resource.data.mustNotExist == true; } } }",
      'index.html': '<output id="operation">Idle</output><output id="deletion">Idle</output><output id="apps"></output><output id="replacement"></output><button id="open">Open app</button><button id="delete" disabled>Delete app</button><button id="reopen" disabled>Reopen app</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { deleteApp, getApps, initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
        const options = { apiKey: 'demo', projectId: 'demo-hosted' };
        const operation = document.querySelector('#operation');
        const deletion = document.querySelector('#deletion');
        const deleteButton = document.querySelector('#delete');
        const reopenButton = document.querySelector('#reopen');
        let app;
        document.querySelector('#open').addEventListener('click', () => {
          app = initializeApp(options);
          const reference = doc(getFirestore(app), 'cancelled', 'startup');
          operation.textContent = 'Pending';
          setDoc(reference, { mustNotExist: true }).then(
            () => { operation.textContent = 'Written'; },
            (error) => { operation.textContent = error.code; },
          );
          deleteButton.disabled = false;
        });
        deleteButton.addEventListener('click', async () => {
          deletion.textContent = 'Deleting';
          try {
            await deleteApp(app);
            deletion.textContent = 'Deleted';
            document.querySelector('#apps').textContent = String(getApps().length);
            reopenButton.disabled = false;
          } catch (error) {
            deletion.textContent = error.code + ': ' + error.message;
          }
        });
        reopenButton.addEventListener('click', async () => {
          const replacement = initializeApp(options);
          const reference = doc(getFirestore(replacement), 'cancelled', 'startup');
          const snapshot = await getDoc(reference);
          const documentExists = snapshot.exists();
          await deleteApp(replacement);
          document.querySelector('#replacement').textContent = documentExists ? 'Found' : 'Missing';
        });
      `,
    },
  });
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      const NativeWebSocket = WebSocket;
      let holdsNextSocket = false;
      window.addEventListener('hold-app-attach', () => { holdsNextSocket = true; });
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          const holdsAttach = holdsNextSocket;
          holdsNextSocket = false;
          const skipsHold = !holdsAttach;
          if (skipsHold) return;
          window.addEventListener('release-app-attach', event => {
            const hasMessage = event instanceof CustomEvent && typeof event.detail === 'string';
            if (hasMessage) this.dispatchEvent(new MessageEvent('message', { data: event.detail }));
            document.documentElement.dataset.appAttach = 'released';
          }, { once: true });
        }
      };
    });
    let delayAppAttach = false;
    let appConnections = 0;
    let controlAttached = false;
    let heldAcknowledgment: string | undefined;
    let appSocketClosed = false;
    await context.routeWebSocket('**/*', (route) => {
      const server = route.connectToServer();
      const isDelayedAppConnection = delayAppAttach;
      if (isDelayedAppConnection) {
        appConnections += 1;
        route.onClose(() => {
          server.close();
          appSocketClosed = true;
        });
      }
      server.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isAttach = frame.type === 'attach-ack';
          if (isAttach) {
            if (isDelayedAppConnection) {
              heldAcknowledgment = data.toString();
              return;
            }
            controlAttached = true;
          }
        }
        route.send(data);
      });
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(serve.info.url);
    await expect.poll(() => controlAttached, { timeout: 5_000, message: 'Control connection must attach before creating the app.' }).toBe(true);
    delayAppAttach = true;
    await page.evaluate(() => window.dispatchEvent(new Event('hold-app-attach')));
    await page.getByRole('button', { name: 'Open app', exact: true }).click();
    await expect.poll(() => ({ held: heldAcknowledgment !== undefined, appConnections, errors }), {
      timeout: 5_000, message: 'The new app must receive an attach acknowledgment to hold.',
    }).toEqual({ held: true, appConnections: 1, errors: [] });
    await expect(page.locator('#operation')).toHaveText('Pending');

    await page.getByRole('button', { name: 'Delete app', exact: true }).click();

    await expect(page.locator('#deletion')).toHaveText('Deleted');
    await expect(page.locator('#operation')).toHaveText('app/app-deleted');
    await expect(page.locator('#apps')).toHaveText('0');
    await expect.poll(() => appSocketClosed, { timeout: 5_000, message: 'Deleted app socket must close.' }).toBe(true);
    await page.evaluate(message => window.dispatchEvent(new CustomEvent('release-app-attach', { detail: message })), heldAcknowledgment);
    await page.clock.runFor(10_000);
    await expect(page.locator('html')).toHaveAttribute('data-app-attach', 'released');
    expect(appConnections).toBe(1);
    await expect(page.locator('#apps')).toHaveText('0');
    delayAppAttach = false;
    await page.getByRole('button', { name: 'Reopen app', exact: true }).click();
    await expect(page.locator('#replacement')).toHaveText('Missing');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
});
