import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { startSoakServe } from '../soak/harness.js';

for (const scenario of [
  { replacesRealm: false, failsUpstream: false, closesEarly: false },
  { replacesRealm: true, failsUpstream: false, closesEarly: false },
  { replacesRealm: false, failsUpstream: true, closesEarly: false },
  { replacesRealm: false, failsUpstream: false, closesEarly: true },
]) {
  const { replacesRealm, failsUpstream, closesEarly } = scenario;
  test(`Service Worker relay refuses operation 257 while another client progresses (replacement: ${replacesRealm}, failure: ${failsUpstream}, early close: ${closesEarly})`, async ({ page }) => {
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
      if (failsUpstream) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Local test failure' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'local-relay-capacity', object: 'chat.completion', created: 0, model: 'local',
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
      const result = page.evaluate(async ({ baseUrl, replacesRealm, closesEarly }) => {
        const runsSharedWorker = globalThis.__pyricRuntime?.getSnapshot().mode === 'shared-worker';
        const hasNoSharedWorker = !runsSharedWorker;
        if (hasNoSharedWorker) throw new Error('The authoritative SharedWorker must be running.');
        const channel = new BroadcastChannel('pyric-shared-worker:service-worker');
        const pending = new Map<string, (reply: unknown) => void>();
        const responseOrder: string[] = [];
        channel.onmessage = event => {
          const envelope: unknown = event.data;
          const hasMessage = envelope !== null && typeof envelope === 'object'
            && 'direction' in envelope && envelope.direction === 'client' && 'message' in envelope;
          if (hasMessage) {
            const message = envelope.message;
            const hasReply = message !== null && typeof message === 'object' && 't' in message && 'id' in message;
            if (hasReply) {
              const id = message.id;
              const isReply = message.t === 'res' && typeof id === 'string';
              if (isReply) {
                responseOrder.push(id);
                const resolve = pending.get(id);
                pending.delete(id);
                resolve?.(message);
              }
            }
          }
        };
        let slowSessionId = 'current';
        function call(clientId: string, message: Extract<InboundMessage, { t: 'op' | 'tool' | 'disconnect' }>): Promise<unknown> {
          return new Promise(resolve => {
            pending.set(message.id, resolve);
            const isSlowClient = clientId === 'slow';
            const sessionId = isSlowClient ? slowSessionId : 'current';
            channel.postMessage({ direction: 'host', phase: 'message', clientId, sessionId, message });
          });
        }
        for (const clientId of ['slow', 'healthy']) {
          channel.postMessage({ direction: 'host', phase: 'attach', clientId, sessionId: 'current' });
        }
        try {
          const held = call('slow', {
            t: 'op', id: 'held', method: 'ai.generateContent', model: 'local',
            request: { contents: [{ role: 'user', parts: [{ text: 'Hold this operation' }] }] },
            engine: { kind: 'openai', baseUrl },
          });
          const queued = Array.from({ length: 255 }, (_, index) => {
            const usesTool = index === 0;
            if (usesTool) return call('slow', { t: 'tool', id: `queued-${index}`,
              name: 'firestore_get_document', args: { path: 'shared/greeting', as: 'admin' } });
            return call('slow', { t: 'op', id: `queued-${index}`, method: 'getDoc',
              path: 'shared/greeting', actAs: { mode: 'admin' } });
          });
          if (replacesRealm) {
            slowSessionId = 'replacement';
            channel.postMessage({ direction: 'host', phase: 'attach', clientId: 'slow', sessionId: slowSessionId });
          }
          const output = document.createElement('output');
          output.id = 'capacity-result';
          document.body.append(output);
          const excess = call('slow', { t: 'op', id: 'excess', method: 'setDoc',
            path: 'limit/refused', data: { message: 'Must not be written' }, actAs: { mode: 'admin' } }).then(reply => {
              output.textContent = JSON.stringify(reply);
              return reply;
            });
          const healthy = await call('healthy', { t: 'op', id: 'healthy', method: 'setDoc',
            path: 'shared/greeting', data: { message: 'Independent client completed' }, actAs: { mode: 'admin' } });
          let earlyClose: Promise<unknown> | undefined;
          if (closesEarly) earlyClose = call('slow', { t: 'disconnect', id: 'early-close' });
          const accepted = await Promise.all([held, ...queued]);
          const closed = await earlyClose;
          if (closesEarly) {
            slowSessionId = 'reopened';
            channel.postMessage({ direction: 'host', phase: 'attach', clientId: 'slow', sessionId: slowSessionId });
          }
          const refill = await Promise.all(Array.from({ length: 256 }, (_, index) => call('slow', {
            t: 'op', id: `refill-${index}`, method: 'getDoc', path: 'shared/greeting', actAs: { mode: 'admin' },
          })));
          return { healthy, accepted, excess: await excess, refill, closed, responseOrder };
        } finally {
          await call('slow', { t: 'disconnect', id: 'close-slow' });
          await call('healthy', { t: 'disconnect', id: 'close-healthy' });
          channel.close();
        }
      }, { baseUrl: `http://127.0.0.1:${address.port}/v1`, replacesRealm, closesEarly }).then(value => ({ value }), error => ({ error: String(error) }));
      await expect.poll(() => upstreamResponse !== undefined).toBe(true);
      await expect(page.locator('#document')).toHaveText('Independent client completed');
      await expect(page.locator('#capacity-result')).toContainText('resource-exhausted');
      releaseUpstream();
      const completed = await result;
      const heldSucceeded = !failsUpstream;
      expect(completed).toMatchObject({ value: {
        healthy: { ok: true }, accepted: [{ ok: heldSucceeded }, ...Array(255).fill({ ok: true })],
        excess: { ok: false, error: { code: 'resource-exhausted' } }, refill: Array(256).fill({ ok: true }),
      } });
      if (closesEarly) {
        expect(completed).toMatchObject({ value: { closed: { ok: true } } });
        const hasValue = 'value' in completed;
        if (hasValue) {
          const order = completed.value.responseOrder;
          expect(order.indexOf('early-close')).toBeGreaterThan(order.indexOf('queued-254'));
        }
      }
      expect(await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'limit/refused'))).exists();
      })).toBe(false);
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
