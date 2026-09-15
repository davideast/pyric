import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

const invalidProtocols = [999, 0, null, undefined, '1', false, [], {}];

const invalidCapabilities: unknown[] = [42, null, undefined, false, 'worker-port', {}, [], ['other'], ['worker-port', 42], ['worker-port', null], ['worker-port', {}]];

const invalidFields = [{ peerConnected: 'yes' }, { bridgeVersion: 7 }, { clientSessionId: 7 },
  { resumeToken: 7 }, { hostInstanceId: {} }];

const invalidAcknowledgments = [
  ...invalidFields.map(fields => ({
    name: `fields ${JSON.stringify(fields)}`,
    fields,
    error: 'unavailable: The hosted sandbox sent a malformed attachment acknowledgment.',
  })),
  ...invalidProtocols.map(protocol => ({
    name: `protocol ${JSON.stringify(protocol)}`,
    fields: { protocol },
    error: 'unavailable: The hosted sandbox uses an unsupported bridge protocol. Expected version 1.',
  })),
  ...invalidCapabilities.map(capabilities => ({
    name: `capabilities ${JSON.stringify(capabilities)}`,
    fields: { capabilities },
    error: 'unavailable: The selected host does not support browser worker ports. Upgrade @pyric/cli, restart with --hosted, and reload this page.',
  })),
];

for (const acknowledgment of invalidAcknowledgments) {
  test(`host acknowledgment ${acknowledgment.name} rejects a queued SDK write before mutation`, async ({ browser }) => {
    test.setTimeout(30_000);
    const fixture = await startSoakServe({
      flags: ['--hosted', '--no-capture'],
      extraFiles: {
        'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /shared/greeting { allow read, write: if true; } } }",
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
        'writer.html': '<output id="result">Starting</output><script type="module" src="/writer.js"></script>',
        'writer.js': `
          import { initializeApp } from 'firebase/app';
          import { doc, getFirestore, setDoc } from 'firebase/firestore';
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
          const result = document.querySelector('#result');
          try {
            await setDoc(doc(getFirestore(app), 'shared/greeting'), { message: 'Incompatible write' });
            result.textContent = 'Written';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        `,
      },
    });
    const brokenContext = await browser.newContext();
    const healthyContext = await browser.newContext();
    try {
      let corrupted = false;
      let writesSent = 0;
      await brokenContext.routeWebSocket('**/__pyric/sandbox', route => {
        const server = route.connectToServer();
        route.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const isWorkerFrame = isBridgeMessage(frame) && frame.type === 'worker-message';
          if (isWorkerFrame) {
            const isWrite = frame.message.t === 'op' && frame.message.method === 'setDoc';
            if (isWrite) writesSent += 1;
          }
          server.send(data);
        });
        server.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const acknowledgesAttach = isBridgeMessage(frame) && frame.type === 'attach-ack';
          if (acknowledgesAttach) {
            corrupted = true;
            route.send(JSON.stringify({ ...frame, ...acknowledgment.fields }));
            return;
          }
          route.send(data);
        });
      });
      const broken = await brokenContext.newPage();
      const pageErrors: string[] = [];
      broken.on('pageerror', error => pageErrors.push(error.message));
      await broken.goto(`${fixture.info.url}/writer.html`);
      await expect(broken.locator('#result')).toHaveText(acknowledgment.error);
      expect(pageErrors).toEqual([]);
      expect(corrupted).toBe(true);
      expect(writesSent).toBe(0);
      const healthy = await healthyContext.newPage();
      await healthy.goto(fixture.info.url);
      await expect(healthy.locator('#document')).toHaveText('Empty');
      await healthy.getByRole('button', { name: 'Write shared document' }).click();
      await expect(healthy.locator('#write-result')).toHaveText('Written');
      await expect(healthy.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await brokenContext.close();
      await healthyContext.close();
      await fixture.stop();
    }
  });
}
