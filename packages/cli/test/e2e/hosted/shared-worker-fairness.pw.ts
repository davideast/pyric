import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { startSoakServe } from '../soak/harness.js';

for (const scenario of [{ pendingCount: 1, closesEarly: false }, { pendingCount: 256, closesEarly: false }, { pendingCount: 256, closesEarly: true }]) {
  const { pendingCount, closesEarly } = scenario;
  test(`a SharedWorker client with ${pendingCount} pending operations preserves progress (early close: ${closesEarly})`, async ({ page }) => {
    let upstreamResponse: ServerResponse | undefined;
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
          'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
        },
      });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      const result = page.evaluate(async ({ baseUrl, pendingCount, closesEarly }) => {
        const snapshot = globalThis.__pyricRuntime?.getSnapshot();
        const epoch = snapshot?.runningEpoch;
        const hasNoWorker = snapshot?.mode !== 'shared-worker' || typeof epoch !== 'string';
        if (hasNoWorker) throw new Error('The real SharedWorker must be running.');
        const worker = new SharedWorker('/__pyric/sdk/worker.js', {
          type: 'classic', name: `pyric-shared-worker:${epoch}`,
        });
        const pending = new Map<string, (reply: unknown) => void>();
        const responseOrder: string[] = [];
        worker.port.onmessage = event => {
          const frame: unknown = event.data;
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
        worker.port.start();
        function call(message: Extract<InboundMessage, { t: 'op' | 'tool' | 'disconnect' }>): Promise<unknown> {
          return new Promise(resolve => {
            pending.set(message.id, resolve);
            worker.port.postMessage(message);
          });
        }
        try {
          const held = call({
            t: 'op', id: 'held', clientSessionId: 'slow-client', method: 'ai.generateContent', model: 'local',
            request: { contents: [{ role: 'user', parts: [{ text: 'Hold this operation' }] }] },
            engine: { kind: 'openai', baseUrl },
          });
          const queued = Array.from({ length: pendingCount - 1 }, (_, index) => {
            const usesTool = index === 0;
            if (usesTool) {
              return call({ t: 'tool', id: `queued-${index}`, clientSessionId: 'slow-client',
                name: 'firestore_get_document', args: { path: 'shared/greeting', as: 'admin' } });
            }
            return call({ t: 'op', id: `queued-${index}`, clientSessionId: 'slow-client', method: 'getDoc',
              path: 'shared/greeting', actAs: { mode: 'admin' } });
          });
          let excess: Promise<unknown> | undefined;
          const checksCapacity = pendingCount === 256;
          if (checksCapacity) {
            const output = document.createElement('output');
            output.id = 'capacity-result';
            document.body.append(output);
            excess = call({ t: 'op', id: 'excess', clientSessionId: 'slow-client', method: 'setDoc',
              path: 'limit/refused', data: { message: 'Must not be written' }, actAs: { mode: 'admin' } }).then(reply => {
                output.textContent = JSON.stringify(reply);
                return reply;
              });
          }
          const healthyCall = call({
            t: 'op', id: 'healthy', clientSessionId: 'healthy-client', method: 'setDoc',
            path: 'shared/greeting', data: { message: 'Independent client completed' }, actAs: { mode: 'admin' },
          });
          let earlyClose: Promise<unknown> | undefined;
          if (closesEarly) earlyClose = call({ t: 'disconnect', id: 'early-close' });
          const healthy = await healthyCall;
          const heldReply = await held;
          const queuedReplies = await Promise.all(queued);
          const closed = await earlyClose;
          let late: unknown;
          if (closesEarly) {
            late = await call({ t: 'op', id: 'late', clientSessionId: 'new-client-after-close', method: 'setDoc',
              path: 'limit/late', data: { message: 'Must not be written' }, actAs: { mode: 'admin' } });
          }
          return { healthy, held: heldReply, queued: queuedReplies, excess: await excess, closed, late, responseOrder };
        } finally {
          await call({ t: 'disconnect', id: 'close-slow', clientSessionId: 'slow-client' });
          await call({ t: 'disconnect', id: 'close-healthy', clientSessionId: 'healthy-client' });
          await call({ t: 'disconnect', id: 'close-port' });
          worker.port.close();
        }
      }, { baseUrl: `http://127.0.0.1:${address.port}/v1`, pendingCount, closesEarly }).then(value => ({ value }), error => ({ error: String(error) }));
      await expect.poll(() => upstreamResponse !== undefined).toBe(true);
      await expect(page.locator('#document')).toHaveText('Independent client completed');
      const checksCapacity = pendingCount === 256;
      if (checksCapacity) await expect(page.locator('#capacity-result')).toContainText('resource-exhausted');
      releaseUpstream();
      const completed = await result;
      expect(completed).toMatchObject({ value: { healthy: { ok: true }, held: { ok: true } } });
      if (checksCapacity) {
        expect(completed).toMatchObject({ value: { queued: Array(255).fill({ ok: true }), excess: { ok: false, error: { code: 'resource-exhausted' } } } });
        expect(await page.evaluate(async () => {
          const sdk = await import('firebase/firestore');
          return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'limit/refused'))).exists();
        })).toBe(false);
      }
      if (closesEarly) {
        expect(completed).toMatchObject({ value: { closed: { ok: true }, late: { ok: false, error: { code: 'app/app-deleted' } } } });
        const hasValue = 'value' in completed;
        if (hasValue) {
          const order = completed.value.responseOrder;
          expect(order.indexOf('early-close')).toBeGreaterThan(order.indexOf('queued-254'));
        }
        expect(await page.evaluate(async () => {
          const sdk = await import('firebase/firestore');
          return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'limit/late'))).exists();
        })).toBe(false);
      }
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
