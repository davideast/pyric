import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { startSoakServe } from '../soak/harness.js';

for (const scenario of [
  { boundaryOffset: -1, replacesRealm: false, failsUpstream: false, closesEarly: false },
  { boundaryOffset: 0, replacesRealm: false, failsUpstream: false, closesEarly: false },
  { boundaryOffset: 1, replacesRealm: false, failsUpstream: false, closesEarly: false },
  { boundaryOffset: 1, replacesRealm: true, failsUpstream: false, closesEarly: false },
  { boundaryOffset: 1, replacesRealm: false, failsUpstream: true, closesEarly: false },
  { boundaryOffset: 0, replacesRealm: false, failsUpstream: false, closesEarly: true },
]) {
  const { boundaryOffset, replacesRealm, failsUpstream, closesEarly } = scenario;
  test(`Service Worker relay operation bytes enforce 24 MiB (offset: ${boundaryOffset}, replacement: ${replacesRealm}, failure: ${failsUpstream}, close: ${closesEarly})`, async ({ page }) => {
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
      const failsFirstRequest = failsUpstream && upstreamRequests === 1;
      if (failsFirstRequest) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Local test failure' } }));
        return;
      }
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
      const result = page.evaluate(async ({ baseUrl, boundaryOffset, replacesRealm, closesEarly }) => {
        const snapshot = globalThis.__pyricRuntime?.getSnapshot();
        const epoch = snapshot?.runningEpoch;
        const hasNoWorker = snapshot?.mode !== 'shared-worker' || typeof epoch !== 'string';
        if (hasNoWorker) throw new Error('The real SharedWorker must be running.');
        const channel = new BroadcastChannel('pyric-shared-worker:service-worker');
        const pending = new Map<string, (reply: unknown) => void>();
        const responseOrder: string[] = [];
        let slowSessionId = 'current';
        channel.onmessage = event => {
          const envelope: unknown = event.data;
          const hasMessage = envelope !== null && typeof envelope === 'object'
            && 'direction' in envelope && envelope.direction === 'client' && 'message' in envelope;
          const ignoresEnvelope = !hasMessage;
          if (ignoresEnvelope) return;
          const frame = envelope.message;
          const hasReplyFields = frame !== null && typeof frame === 'object' && 't' in frame && 'id' in frame;
          if (hasReplyFields) {
            const id = frame.id;
            const isReply = frame.t === 'res' && typeof id === 'string';
            if (isReply) {
              responseOrder.push(id);
              const resolve = pending.get(id);
              pending.delete(id);
              resolve?.(frame);
            }
          }
        };
        for (const clientId of ['slow-client', 'healthy-client']) {
          channel.postMessage({ direction: 'host', phase: 'attach', clientId, sessionId: 'current' });
        }
        function call(message: Extract<InboundMessage, { t: 'op' | 'tool' | 'disconnect' }>, clientId = 'slow-client'): Promise<unknown> {
          return new Promise(resolve => {
            pending.set(message.id, resolve);
            const isSlowClient = clientId === 'slow-client';
            const sessionId = isSlowClient ? slowSessionId : 'current';
            channel.postMessage({ direction: 'host', phase: 'message', clientId, sessionId, message });
          });
        }
        try {
          const heldMessage = {
            t: 'op', id: 'held', method: 'ai.generateContent', model: 'local',
            request: { contents: [{ role: 'user', parts: [{ text: 'Hold this operation' }] }] },
            engine: { kind: 'openai', baseUrl },
          } satisfies InboundMessage;
          const held = call(heldMessage);
          const encodedBytes = (message: InboundMessage): number => new TextEncoder().encode(JSON.stringify(message)).byteLength;
          function upload(id: string, bytes: number): Extract<InboundMessage, { method: 'storage.putBytes' }> {
            const message = { t: 'op', id, method: 'storage.putBytes',
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
          if (replacesRealm) {
            slowSessionId = 'replacement';
            channel.postMessage({ direction: 'host', phase: 'attach', clientId: 'slow-client', sessionId: slowSessionId });
          }
          const third = call(thirdMessage).then(reply => {
            output.textContent = JSON.stringify(reply);
            return reply;
          });
          let earlyClose: Promise<unknown> | undefined;
          if (closesEarly) earlyClose = call({ t: 'disconnect', id: 'early-close' });
          const healthy = await call({ t: 'op', id: 'healthy', method: 'setDoc',
            path: 'shared/greeting', data: { message: 'Independent client completed' }, actAs: { mode: 'admin' } }, 'healthy-client');
          const accepted = await Promise.all([held, first, second]);
          const thirdReply = await third;
          const closed = await earlyClose;
          if (closesEarly) {
            slowSessionId = 'reopened';
            channel.postMessage({ direction: 'host', phase: 'attach', clientId: 'slow-client', sessionId: slowSessionId });
          }
          const refillHeldMessage = { ...heldMessage, id: 'refill-held' };
          const refillHeld = call(refillHeldMessage);
          const refillFirst = upload('refill-first', 8 * 1024 * 1024);
          const refillSecond = upload('refill-second', 8 * 1024 * 1024);
          const refillThird = upload('refill-third', 24 * 1024 * 1024 - encodedBytes(refillHeldMessage)
            - encodedBytes(refillFirst) - encodedBytes(refillSecond));
          const refillCalls = [refillHeld, call(refillFirst), call(refillSecond), call(refillThird)];
          const refillHealthy = await call({ t: 'op', id: 'refill-healthy', method: 'setDoc',
            path: 'shared/greeting', data: { message: 'Refill queued' }, actAs: { mode: 'admin' } }, 'healthy-client');
          const refill = await Promise.all(refillCalls);
          return { totalBytes, healthy, accepted, third: thirdReply, refill, refillHealthy, closed, responseOrder };
        } finally {
          await call({ t: 'disconnect', id: 'close-slow' });
          await call({ t: 'disconnect', id: 'close-healthy' }, 'healthy-client');
          channel.close();
        }
      }, { baseUrl: `http://127.0.0.1:${address.port}/v1`, boundaryOffset, replacesRealm, closesEarly }).then(value => ({ value }), error => ({ error: String(error) }));
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
      const heldSucceeds = !failsUpstream;
      expect(completed).toMatchObject({ value: {
        totalBytes: 24 * 1024 * 1024 + boundaryOffset,
        healthy: { ok: true }, accepted: [{ ok: heldSucceeds }, { ok: true }, { ok: true }], third: { ok: thirdSucceeds }, refill: Array(4).fill({ ok: true }), refillHealthy: { ok: true },
      } });
      if (exceedsLimit) expect(completed).toMatchObject({ value: { third: { error: { code: 'resource-exhausted' } } } });
      if (closesEarly) {
        expect(completed).toMatchObject({ value: { closed: { ok: true } } });
        const hasValue = 'value' in completed;
        if (hasValue) {
          const order = completed.value.responseOrder;
          expect(order.indexOf('early-close')).toBeGreaterThan(order.indexOf('third'));
        }
      }
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
