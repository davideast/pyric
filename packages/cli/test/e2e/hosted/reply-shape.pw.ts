import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

const malformedOutcomes: Array<{ name: string; fields: Record<string, unknown> }> = [
  { name: 'missing status', fields: {} },
  { name: 'null status', fields: { ok: null } },
  { name: 'truthy non-Boolean status', fields: { ok: 'false' } },
  { name: 'falsy non-Boolean status', fields: { ok: 0 } },
  { name: 'missing error', fields: { ok: false } },
  { name: 'null error', fields: { ok: false, error: null } },
  { name: 'primitive error', fields: { ok: false, error: 'Denied' } },
  { name: 'array error', fields: { ok: false, error: [] } },
  { name: 'empty error', fields: { ok: false, error: {} } },
  { name: 'missing code', fields: { ok: false, error: { message: 'Denied' } } },
  { name: 'missing message', fields: { ok: false, error: { code: 'permission-denied' } } },
  { name: 'non-string code', fields: { ok: false, error: { code: 403, message: 'Denied' } } },
  { name: 'non-string message', fields: { ok: false, error: { code: 'permission-denied', message: [] } } },
];
const replyCases = [
  ...malformedOutcomes.map(outcome => ({
    ...outcome,
    expected: 'unavailable: The sandbox sent a malformed operation reply. The operation may have completed; check state before retrying.',
  })),
  {
    name: 'valid failure preserves its code and message',
    fields: { ok: false, error: { code: 'permission-denied', message: 'Fixture denial' } },
    expected: 'permission-denied: Fixture denial',
  },
];

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode}: malformed reply outcomes reject reads and both clients remain usable`, async ({ context }) => {
    const isHosted = mode === 'hosted';
    const flags = isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'];
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8') + `
          const { getDoc } = await import('firebase/firestore');
          const readResult = document.createElement('output');
          readResult.id = 'read-result';
          const readButton = document.createElement('button');
          readButton.textContent = 'Read document';
          readButton.onclick = async () => {
            readResult.textContent = 'Pending';
            try {
              const snapshot = await getDoc(sharedDocument);
              readResult.textContent = snapshot.data()?.message ?? 'Missing';
            } catch (error) {
              readResult.textContent = error.code + ': ' + error.message;
            }
          };
          document.body.append(readButton, readResult);
        `,
      },
    });
    const broken = await context.newPage();
    const healthy = await context.newPage();
    const errors: string[] = [];
    broken.on('pageerror', error => errors.push(error.message));
    try {
      if (isHosted) {
        await broken.routeWebSocket('**/__pyric/sandbox', route => {
          const server = route.connectToServer();
          const pendingCases = [...replyCases];
          let readId: string | undefined;
          route.onMessage(data => {
            const frame: unknown = JSON.parse(data.toString());
            const isRequest = isBridgeMessage(frame) && frame.type === 'worker-message';
            if (isRequest) {
              const message = frame.message;
              const isRead = message.t === 'op' && message.method === 'getDoc';
              if (isRead) readId = message.id;
            }
            server.send(data);
          });
          server.onMessage(data => {
            const frame: unknown = JSON.parse(data.toString());
            const isReply = isBridgeMessage(frame) && frame.type === 'worker-message-result';
            if (isReply) {
              const message = frame.message;
              const isReadReply = readId !== undefined && message.t === 'res' && message.id === readId;
              if (isReadReply) {
                readId = undefined;
                const replacement = pendingCases.shift();
                const injectsReply = replacement !== undefined;
                if (injectsReply) {
                  route.send(JSON.stringify({ ...frame, message: { t: 'res', id: message.id, ...replacement.fields } }));
                  return;
                }
              }
            }
            route.send(data);
          });
        });
      } else {
        await broken.addInitScript(outcomes => {
          const NativeSharedWorker = SharedWorker;
          globalThis.SharedWorker = class extends NativeSharedWorker {
            constructor(...args: ConstructorParameters<typeof SharedWorker>) {
              super(...args);
              const port = this.port;
              const pendingCases = [...outcomes];
              const postMessage = port.postMessage.bind(port);
              let readId: unknown;
              port.postMessage = (message: unknown, options?: Transferable[] | StructuredSerializeOptions) => {
                const isRecord = message !== null && typeof message === 'object';
                const isRead = isRecord && 'method' in message && message.method === 'getDoc' && 'id' in message;
                if (isRead) readId = message.id;
                const transfersObjects = Array.isArray(options);
                const serialization = transfersObjects ? { transfer: options } : options;
                postMessage(message, serialization);
              };
              port.addEventListener('message', event => {
                const message: unknown = event.data;
                const isRecord = message !== null && typeof message === 'object';
                const isReply = isRecord && 't' in message && message.t === 'res' && 'id' in message;
                const isReadReply = isReply && readId !== undefined && message.id === readId;
                if (isReadReply) {
                  readId = undefined;
                  const replacement = pendingCases.shift();
                  const injectsReply = replacement !== undefined;
                  if (injectsReply) {
                    event.stopImmediatePropagation();
                    port.dispatchEvent(new MessageEvent('message', { data: { t: 'res', id: message.id, ...replacement.fields } }));
                  }
                }
              });
            }
          };
        }, replyCases);
      }
      for (const page of [broken, healthy]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
        expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      }
      for (const outcome of replyCases) {
        await test.step(outcome.name, async () => {
          await broken.getByRole('button', { name: 'Read document' }).click();
          await expect(broken.locator('#read-result')).toHaveText(outcome.expected, { timeout: 3_000 });
        });
      }
      expect(errors).toEqual([]);
      await healthy.locator('#write').click();
      await expect(healthy.locator('#write-result')).toHaveText('Written');
      for (const page of [broken, healthy]) {
        await expect(page.locator('#document')).toHaveText('Hello from the other browser');
        await page.getByRole('button', { name: 'Read document' }).click();
        await expect(page.locator('#read-result')).toHaveText('Hello from the other browser');
      }
      await broken.locator('#write').click();
      await expect(broken.locator('#write-result')).toHaveText('Written');
      expect(errors).toEqual([]);
    } finally {
      await test.info().attach('page-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
      await Promise.all([broken.close(), healthy.close()]).finally(() => fixture.stop());
    }
  });
}
