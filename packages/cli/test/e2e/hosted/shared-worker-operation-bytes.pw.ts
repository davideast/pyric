import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { startSoakServe } from '../soak/harness.js';

for (const boundaryOffset of [-1, 0, 1]) {
  test(`SharedWorker queued operation bytes enforce 24 MiB (offset: ${boundaryOffset})`, async ({ page }) => {
    let upstreamResponse: ServerResponse | undefined;
    let upstreamRequests = 0;
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
      upstreamResponse = response;
      upstreamRequests += 1;
    });
    let fixture: Awaited<ReturnType<typeof startSoakServe>> | undefined;
    function releaseUpstream(): void {
      const response = upstreamResponse;
      const cannotReply = response === undefined || response.writableEnded;
      if (cannotReply) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'local-worker-fairness', object: 'chat.completion', created: 0, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Released' }, finish_reason: 'stop' }],
      }));
    }
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The local AI fixture has no listening address.');
      fixture = await startSoakServe({
        flags: ['--no-capture'],
        extraFiles: {
          'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
          'storage.rules': "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
          'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
        },
      });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      const result = page.evaluate(async ({ baseUrl, boundaryOffset }) => {
        const snapshot = globalThis.__pyricRuntime?.getSnapshot();
        const epoch = snapshot?.runningEpoch;
        const hasNoWorker = snapshot?.mode !== 'shared-worker' || typeof epoch !== 'string';
        if (hasNoWorker) throw new Error('The real SharedWorker must be running.');
        const worker = new SharedWorker('/__pyric/sdk/worker.js', {
          type: 'classic', name: `pyric-shared-worker:${epoch}`,
        });
        const pending = new Map<string, (reply: unknown) => void>();
        worker.port.onmessage = event => {
          const frame: unknown = event.data;
          const hasReplyFields = frame !== null && typeof frame === 'object' && 't' in frame && 'id' in frame;
          if (hasReplyFields) {
            const id = frame.id;
            const isReply = frame.t === 'res' && typeof id === 'string';
            if (isReply) {
              const resolve = pending.get(id);
              pending.delete(id);
              resolve?.(frame);
            }
          }
        };
        worker.port.start();
        function call(message: Extract<InboundMessage, { t: 'op' | 'tool' | 'disconnect' }>): Promise<unknown> {
          return new Promise(resolve => {
            pending.set(message.id, resolve);
            worker.port.postMessage(message);
          });
        }
        try {
          const heldMessage = {
            t: 'op', id: 'held', clientSessionId: 'slow-client', method: 'ai.generateContent', model: 'local',
            request: { contents: [{ role: 'user', parts: [{ text: 'Hold this operation' }] }] },
            engine: { kind: 'openai', baseUrl },
          } satisfies InboundMessage;
          const held = call(heldMessage);
          const encodedBytes = (message: InboundMessage): number => new TextEncoder().encode(JSON.stringify(message)).byteLength;
          function upload(id: string, bytes: number): Extract<InboundMessage, { method: 'storage.putBytes' }> {
            const message = { t: 'op', id, clientSessionId: 'slow-client', method: 'storage.putBytes',
              path: `queue/${id}`, dataB64: '', metadata: { customMetadata: { label: 'é' } } } satisfies InboundMessage;
            const payloadBytes = bytes - encodedBytes(message);
            message.dataB64 = 'AAAA'.repeat(Math.floor(payloadBytes / 4));
            message.metadata.customMetadata.label += 'x'.repeat(payloadBytes % 4);
            return message;
          }
          const firstMessage = upload('first', 8 * 1024 * 1024);
          const secondMessage = upload('second', 8 * 1024 * 1024);
          const thirdBytes = 24 * 1024 * 1024 - encodedBytes(heldMessage)
            - encodedBytes(firstMessage) - encodedBytes(secondMessage) + boundaryOffset;
          const thirdMessage = upload('third', thirdBytes);
          const totalBytes = encodedBytes(heldMessage) + encodedBytes(firstMessage)
            + encodedBytes(secondMessage) + encodedBytes(thirdMessage);
          const first = call(firstMessage);
          const second = call(secondMessage);
          const output = document.createElement('output');
          output.id = 'capacity-result';
          document.body.append(output);
          const third = call(thirdMessage).then(reply => {
            output.textContent = JSON.stringify(reply);
            return reply;
          });
          const healthy = await call({ t: 'op', id: 'healthy', clientSessionId: 'healthy-client', method: 'setDoc',
            path: 'shared/greeting', data: { message: 'Independent client completed' }, actAs: { mode: 'admin' } });
          const accepted = await Promise.all([held, first, second]);
          const thirdReply = await third;
          const refillHeldMessage = { ...heldMessage, id: 'refill-held' };
          const refillHeld = call(refillHeldMessage);
          const refillFirst = upload('refill-first', 8 * 1024 * 1024);
          const refillSecond = upload('refill-second', 8 * 1024 * 1024);
          const refillThird = upload('refill-third', 24 * 1024 * 1024 - encodedBytes(refillHeldMessage)
            - encodedBytes(refillFirst) - encodedBytes(refillSecond));
          const refillCalls = [refillHeld, call(refillFirst), call(refillSecond), call(refillThird)];
          const refillHealthy = await call({ t: 'op', id: 'refill-healthy', clientSessionId: 'healthy-client', method: 'setDoc',
            path: 'shared/greeting', data: { message: 'Refill queued' }, actAs: { mode: 'admin' } });
          const refill = await Promise.all(refillCalls);
          return { totalBytes, healthy, accepted, third: thirdReply, refill, refillHealthy };
        } finally {
          await call({ t: 'disconnect', id: 'close-slow', clientSessionId: 'slow-client' });
          await call({ t: 'disconnect', id: 'close-healthy', clientSessionId: 'healthy-client' });
          await call({ t: 'disconnect', id: 'close-port' });
          worker.port.close();
        }
      }, { baseUrl: `http://127.0.0.1:${address.port}/v1`, boundaryOffset }).then(value => ({ value }), error => ({ error: String(error) }));
      await expect.poll(() => upstreamResponse !== undefined).toBe(true);
      await expect(page.locator('#document')).toHaveText('Independent client completed');
      const exceedsLimit = boundaryOffset > 0;
      if (exceedsLimit) await expect(page.locator('#capacity-result')).toContainText('resource-exhausted');
      releaseUpstream();
      await expect.poll(() => upstreamRequests).toBe(2);
      await expect(page.locator('#document')).toHaveText('Refill queued');
      releaseUpstream();
      const completed = await result;
      const thirdSucceeds = !exceedsLimit;
      expect(completed).toMatchObject({ value: {
        totalBytes: 24 * 1024 * 1024 + boundaryOffset,
        healthy: { ok: true }, accepted: Array(3).fill({ ok: true }), third: { ok: thirdSucceeds }, refill: Array(4).fill({ ok: true }), refillHealthy: { ok: true },
      } });
      if (exceedsLimit) expect(completed).toMatchObject({ value: { third: { error: { code: 'resource-exhausted' } } } });
      const stored = await page.evaluate(async () => {
        const sdk = await import('firebase/storage');
        return sdk.getMetadata(sdk.ref(sdk.getStorage(), 'queue/third')).then(
          metadata => ({ exists: true, size: metadata.size }),
          error => ({ exists: false, code: String(error.code) }),
        );
      });
      expect(stored.exists).toBe(thirdSucceeds);
      if (exceedsLimit) expect(stored).toMatchObject({ code: 'storage/object-not-found' });
    } finally {
      releaseUpstream();
      try {
        await page.close().finally(() => fixture?.stop());
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    }
  });
}
