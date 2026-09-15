import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

for (const mode of ['hosted', 'shared-worker']) {
 for (const delivery of ['res', 'snap']) {
  test(`${mode} ${delivery}: replies cannot settle another app's pending read`, async ({ page }) => {
    const isHosted = mode === 'hosted';
    const listens = delivery === 'snap';
    const readFunction = listens
      ? '(reference) => new Promise(resolve => { const stop = onSnapshot(reference, snapshot => { stop(); resolve(snapshot); }); })'
      : 'getDoc';
    const fixture = await startSoakServe({
      flags: isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'],
      extraFiles: {
        'firestore.rules': 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /correlation/{doc} { allow read, write: if true; } } }',
        'index.html': '<button id="read" disabled>Read both apps</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { doc, getDoc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
          const config = { apiKey: 'demo', projectId: 'demo-hosted' };
          const first = doc(getFirestore(initializeApp(config)), 'correlation/first');
          const second = doc(getFirestore(initializeApp(config, 'second')), 'correlation/second');
          await Promise.all([setDoc(first, { label: 'First app' }), setDoc(second, { label: 'Second app' })]);
          const read = ${readFunction};
          const result = document.querySelector('#result');
          const button = document.querySelector('#read');
          button.onclick = async () => {
            result.textContent = 'Pending';
            try {
              const documents = await Promise.all([read(first), read(second)]);
              result.textContent = documents.map(snapshot => snapshot.data().label).join(', ');
            } catch (error) { result.textContent = error.code + ': ' + error.message; }
          };
          result.textContent = 'Ready';
          button.disabled = false;
        `,
      },
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(delivery => {
        function isRecord(value: unknown): value is Record<string, unknown> {
          const isObject = value !== null && typeof value === 'object';
          return isObject;
        }
        const held: Array<{ message: Record<string, unknown>; deliver: (message: unknown) => void }> = [];
        let injected = false;
        function intercept(event: MessageEvent, deliver: (message: unknown) => void): void {
          if (injected) return;
          const isJson = typeof event.data === 'string';
          let frame: unknown = event.data;
          if (isJson) {
            try { frame = JSON.parse(event.data); } catch { return; }
          }
          const parsed = frame;
          const isBridgeReply = isRecord(parsed) && parsed.type === 'worker-message-result';
          const message = isBridgeReply ? parsed.message : parsed;
          const isReply = isRecord(message) && message.t === delivery;
          const value = isReply ? message.value : undefined;
          const isDocument = isRecord(value) && (value.path === 'correlation/first' || value.path === 'correlation/second');
          const isTarget = isReply && isDocument;
          if (isTarget) {
            event.stopImmediatePropagation();
            held.push({ message, deliver: replacement => {
              const output = isBridgeReply ? { ...parsed, message: replacement } : replacement;
              deliver(isJson ? JSON.stringify(output) : output);
            } });
            const hasBothReplies = held.length === 2;
            if (hasBothReplies) {
              injected = true;
              const [first, second] = held;
              const isResponse = delivery === 'res';
              const correlation = isResponse ? 'id' : 'subId';
              first.deliver({ ...first.message, [correlation]: second.message[correlation] });
              second.deliver({ ...second.message, [correlation]: first.message[correlation] });
              first.deliver(first.message);
              second.deliver(second.message);
              document.documentElement.dataset.corruption = 'delivered';
            }
          }
        }
        const NativeWebSocket = WebSocket;
        globalThis.WebSocket = class extends NativeWebSocket {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            this.addEventListener('message', event => intercept(event, data => {
              this.dispatchEvent(new MessageEvent('message', { data }));
            }));
          }
        };
        const NativeSharedWorker = SharedWorker;
        globalThis.SharedWorker = class extends NativeSharedWorker {
          constructor(...args: ConstructorParameters<typeof SharedWorker>) {
            super(...args);
            this.port.addEventListener('message', event => intercept(event, data => {
              this.port.dispatchEvent(new MessageEvent('message', { data }));
            }));
          }
        };
      }, delivery);
      await page.goto(fixture.info.url);
      await expect(page.locator('#result')).toHaveText('Ready');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      await page.locator('#read').click();
      await expect(page.locator('html')).toHaveAttribute('data-corruption', 'delivered');
      await expect(page.locator('#result')).toHaveText('First app, Second app');
      await page.locator('#read').click();
      await expect(page.locator('#result')).toHaveText('First app, Second app');
      expect(errors).toEqual([]);
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
}
