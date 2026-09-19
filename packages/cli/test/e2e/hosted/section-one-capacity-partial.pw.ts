import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { startSoakServe } from '../soak/harness.js';

for (const runtimeMode of ['native', 'service-worker', 'hosted']) {
  for (const failsFirst of [false, true]) {
    test(`${runtimeMode} worker reuses released bytes while a successor is held (failure: ${failsFirst})`, async ({ page }) => {
      const responses: ServerResponse[] = [];
      const upstream = createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', '*');
        const isPreflight = request.method === 'OPTIONS';
        if (isPreflight) {
          response.writeHead(204);
          response.end();
          return;
        }
        request.resume();
        responses.push(response);
      });
      function release(index: number, fails = false): void {
        const response = responses[index];
        const cannotReply = response === undefined || response.writableEnded;
        if (cannotReply) return;
        if (fails) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Controlled capacity failure' } }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'capacity', object: 'chat.completion', created: 0, model: 'local',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Released' }, finish_reason: 'stop' }] }));
      }
      let fixture: Awaited<ReturnType<typeof startSoakServe>> | undefined;
      try {
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        const hasNoAddress = address === null || typeof address === 'string';
        if (hasNoAddress) throw new Error('The capacity upstream did not bind.');
        const isHosted = runtimeMode === 'hosted';
        const flags = isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'];
        fixture = await startSoakServe({ flags, extraFiles: {
          'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
          'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
          'storage.rules': "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
        } });
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
        const result = page.evaluate(async ({ baseUrl, runtimeMode }) => {
          const runtime = globalThis.__pyricRuntime?.getSnapshot();
          const epoch = runtime?.runningEpoch;
          const isHosted = runtimeMode === 'hosted';
          const hasNoWorker = !isHosted && (runtime?.mode !== 'shared-worker' || typeof epoch !== 'string');
          if (hasNoWorker) throw new Error('Expected the actual default SharedWorker.');
          const pending = new Map<string, (reply: unknown) => void>();
          function receive(frame: unknown): void {
            const hasFields = frame !== null && typeof frame === 'object' && 't' in frame && 'id' in frame;
            if (hasFields) {
              const id = frame.id;
              const isReply = frame.t === 'res' && typeof id === 'string';
              if (isReply) {
                const resolve = pending.get(id);
                pending.delete(id);
                resolve?.(frame);
              }
            }
          }
          function ownerMessage(message: InboundMessage): InboundMessage {
            const isNative = runtimeMode === 'native';
            if (isNative) return message;
            const { clientSessionId, ...operation } = message;
            return operation;
          }
          let send: (message: InboundMessage) => void;
          let closeTransport: () => void;
          if (isHosted) {
            const sockets = new Map<string, WebSocket>();
            for (const clientId of ['busy', 'other']) {
              const socketUrl = new URL('/__pyric/sandbox', location.href);
              socketUrl.protocol = 'ws:';
              const socket = new WebSocket(socketUrl);
              await new Promise<void>((resolve, reject) => {
                socket.onerror = () => reject(new Error('Hosted capacity socket failed.'));
                socket.onopen = () => socket.send(JSON.stringify({ type: 'attach', protocol: 1,
                  clientSessionId: clientId, transport: 'worker-port' }));
                socket.onmessage = event => {
                  const frame: unknown = JSON.parse(String(event.data));
                  const hasType = frame !== null && typeof frame === 'object' && 'type' in frame;
                  if (hasType) {
                    const isAttached = frame.type === 'attach-ack';
                    if (isAttached) resolve();
                    const hasMessage = frame.type === 'worker-message-result' && 'message' in frame;
                    if (hasMessage) receive(frame.message);
                  }
                };
              });
              sockets.set(clientId, socket);
            }
            send = message => {
              const clientId = message.clientSessionId ?? 'busy';
              const socket = sockets.get(clientId);
              const hasNoSocket = socket === undefined;
              if (hasNoSocket) throw new Error('Missing capacity client socket.');
              socket.send(JSON.stringify({ type: 'worker-message', message: ownerMessage(message) }));
            };
            closeTransport = () => { for (const socket of sockets.values()) socket.close(); };
          } else {
            const usesServiceWorkerRelay = runtimeMode === 'service-worker';
            if (usesServiceWorkerRelay) {
              const channel = new BroadcastChannel('pyric-shared-worker:service-worker');
              channel.onmessage = event => {
                const frame: unknown = event.data;
                const hasMessage = frame !== null && typeof frame === 'object'
                  && 'direction' in frame && frame.direction === 'client' && 'message' in frame;
                if (hasMessage) receive(frame.message);
              };
              for (const clientId of ['busy', 'other']) {
                channel.postMessage({ direction: 'host', phase: 'attach', clientId, sessionId: 'partial' });
              }
              send = message => channel.postMessage({ direction: 'host', phase: 'message',
                clientId: message.clientSessionId ?? 'busy', sessionId: 'partial', message: ownerMessage(message) });
              closeTransport = () => channel.close();
            } else {
              const worker = new SharedWorker('/__pyric/sdk/worker.js', {
                type: 'classic', name: `pyric-shared-worker:${epoch}`,
              });
              worker.port.onmessage = event => receive(event.data);
              worker.port.start();
              send = message => worker.port.postMessage(message);
              closeTransport = () => worker.port.close();
            }
          }
          const progress = document.createElement('output');
          progress.id = 'capacity-progress';
          document.body.append(progress);
          const bytes = (message: InboundMessage): number => new TextEncoder().encode(JSON.stringify(ownerMessage(message))).byteLength;
          function call(message: Extract<InboundMessage, { t: 'op' | 'disconnect' }>): Promise<unknown> {
            return new Promise(resolve => {
              pending.set(message.id, resolve);
              send(message);
            });
          }
          function held(id: string): Extract<InboundMessage, { method: 'ai.generateContent' }> {
            return { t: 'op', id, clientSessionId: 'busy', method: 'ai.generateContent', model: 'local',
              request: { contents: [{ role: 'user', parts: [{ text: 'Hold capacity' }] }] },
              engine: { kind: 'openai', baseUrl } };
          }
          function upload(id: string, size: number): Extract<InboundMessage, { method: 'storage.putBytes' }> {
            const message = { t: 'op', id, clientSessionId: 'busy', method: 'storage.putBytes',
              path: `capacity/${id}`, dataB64: '', metadata: { customMetadata: { label: 'é' } } } satisfies InboundMessage;
            const padding = size - bytes(message);
            message.dataB64 = 'AAAA'.repeat(Math.floor(padding / 4));
            message.metadata.customMetadata.label += 'x'.repeat(padding % 4);
            return message;
          }
          function fill(prefix: string, availableBytes: number): InboundMessage[] {
            const first = upload(`${prefix}-one`, 8 * 1024 * 1024);
            const second = upload(`${prefix}-two`, 8 * 1024 * 1024);
            return [first, second, upload(`${prefix}-three`, availableBytes - bytes(first) - bytes(second))];
          }
          function queueUploads(messages: InboundMessage[]): Promise<unknown>[] {
            return messages.map(message => {
              const isUpload = message.t === 'op' && message.method === 'storage.putBytes';
              if (isUpload) return call(message);
              throw new Error('Capacity fixture expected an upload.');
            });
          }
          try {
            const firstMessage = held('first');
            const successorMessage = held('successor');
            const first = call(firstMessage);
            const successor = call(successorMessage);
            const uploads = fill('initial', 24 * 1024 * 1024 - bytes(firstMessage) - bytes(successorMessage));
            const accepted = queueUploads(uploads);
            const initialRefusal = await call(upload('refused-initial', 1024));
            progress.textContent = 'Initial capacity occupied';
            const firstReply = await first;
            const replacementMessage = upload('replacement', bytes(firstMessage));
            const replacement = call(replacementMessage);
            const partialRefusal = await call(upload('refused-partial', 1024));
            const healthy = await call({ t: 'op', id: 'healthy', clientSessionId: 'other', method: 'setDoc',
              path: 'shared/greeting', data: { message: 'Partial refill occupied' }, actAs: { mode: 'admin' } });
            const successorStillHeld = pending.has(successorMessage.id);
            progress.textContent = 'Partial refill occupied';
            const drained = await Promise.all([successor, ...accepted, replacement]);
            const fullHeldMessage = held('full-held');
            const fullHeld = call(fullHeldMessage);
            const fullMessages = fill('full', 24 * 1024 * 1024 - bytes(fullHeldMessage));
            const fullCalls = queueUploads(fullMessages);
            const fullRefusal = await call(upload('refused-full', 1024));
            progress.textContent = 'Full refill occupied';
            const full = await Promise.all([fullHeld, ...fullCalls]);
            return { firstReply, initialRefusal, partialRefusal, fullRefusal, healthy, successorStillHeld,
              chargedBytes: bytes(firstMessage) + bytes(successorMessage) + uploads.reduce((sum, message) => sum + bytes(message), 0),
              releasedBytes: bytes(firstMessage), replacementBytes: bytes(replacementMessage), drained, full };
          } finally {
            await call({ t: 'disconnect', id: 'disconnect-busy', clientSessionId: 'busy' });
            await call({ t: 'disconnect', id: 'disconnect-other', clientSessionId: 'other' });
            const isNative = runtimeMode === 'native';
            if (isNative) await call({ t: 'disconnect', id: 'disconnect-port' });
            closeTransport();
          }
        }, { baseUrl: `http://127.0.0.1:${address.port}/v1`, runtimeMode }).then(value => ({ value }), error => ({ error: String(error) }));
        await expect.poll(() => responses.length).toBe(1);
        await expect(page.locator('#capacity-progress')).toHaveText('Initial capacity occupied');
        release(0, failsFirst);
        await expect.poll(() => responses.length).toBe(2);
        await expect(page.locator('#capacity-progress')).toHaveText('Partial refill occupied');
        await expect(page.locator('#document')).toHaveText('Partial refill occupied');
        release(1);
        await expect.poll(() => responses.length).toBe(3);
        await expect(page.locator('#capacity-progress')).toHaveText('Full refill occupied');
        release(2);
        const completed = await result;
        const firstSucceeds = !failsFirst;
        const refusal = { ok: false, error: { code: 'resource-exhausted' } };
        expect(completed).toMatchObject({ value: { firstReply: { ok: firstSucceeds },
          initialRefusal: refusal, partialRefusal: refusal, fullRefusal: refusal,
          healthy: { ok: true }, successorStillHeld: true, chargedBytes: 24 * 1024 * 1024,
          drained: Array(5).fill({ ok: true }), full: Array(4).fill({ ok: true }) } });
        const hasValue = 'value' in completed;
        if (hasValue) expect(completed.value.replacementBytes).toBe(completed.value.releasedBytes);
        const missing = await page.evaluate(async () => {
          const storage = await import('firebase/storage');
          return Promise.all(['refused-initial', 'refused-partial', 'refused-full'].map(async id =>
            storage.getMetadata(storage.ref(storage.getStorage(), `capacity/${id}`)).then(
              () => 'unexpected object', error => String(error.code))));
        });
        expect(missing).toEqual(Array(3).fill('storage/object-not-found'));
      } finally {
        for (const [index] of responses.entries()) release(index);
        await page.close().finally(() => fixture?.stop());
        upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    });
  }
}
