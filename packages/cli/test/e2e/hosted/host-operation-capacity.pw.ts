import { createServer, type ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerOpPayload, type WorkerResFrame } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

for (const transport of ['worker-relay', 'worker-port']) {
  for (const completion of ['success', 'failure']) {
    test(`host ${transport} capacity preserves accepted work after ${completion}`, async ({ page }) => {
      let upstreamResponse: ServerResponse | undefined;
      const upstream = createServer((request, response) => {
        request.resume();
        upstreamResponse = response;
      });
      let fixture: Awaited<ReturnType<typeof startHostedFixture>> | undefined;
      let socket: WebSocket | undefined;
      const replies = new Map<string, Pick<WorkerResFrame, 'ok' | 'error'>>();
      const acceptedIds = Array.from({ length: 255 }, (_, index) => `accepted-${index}`);
      const usesWorkerPort = transport === 'worker-port';
      const failsFirstOperation = completion === 'failure';
      let attached = false;

      function releaseUpstream(): void {
        const response = upstreamResponse;
        const cannotReply = response === undefined || response.writableEnded;
        if (cannotReply) return;
        const status = failsFirstOperation ? 400 : 200;
        response.writeHead(status, { 'Content-Type': 'application/json' });
        if (failsFirstOperation) {
          response.end(JSON.stringify({ error: { message: 'Controlled operation failure', type: 'invalid_request_error' } }));
          return;
        }
        response.end(JSON.stringify({
          id: 'local-capacity-fixture', object: 'chat.completion', created: 0, model: 'local',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Released' }, finish_reason: 'stop' }],
        }));
      }

      try {
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        const hasNoAddress = address === null || typeof address === 'string';
        if (hasNoAddress) throw new Error('The local AI fixture has no TCP address.');
        fixture = await startHostedFixture();
        const consumer = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
        socket = consumer;
        consumer.on('message', raw => {
          const frame: unknown = JSON.parse(raw.toString());
          const isUnknownFrame = !isBridgeMessage(frame);
          if (isUnknownFrame) return;
          const isAttached = frame.type === 'attach-ack';
          if (isAttached) attached = true;
          const isRelayResponse = frame.type === 'worker-res';
          if (isRelayResponse) replies.set(frame.id, frame);
          const isWorkerFrame = frame.type === 'worker-message-result';
          if (isWorkerFrame) {
            const message = frame.message;
            const isResponse = message.t === 'res';
            if (isResponse) replies.set(message.id, message);
          }
        });
        function sendOperation(id: string, op: WorkerOpPayload, clientSessionId?: string): void {
          if (usesWorkerPort) consumer.send(JSON.stringify({ type: 'worker-message', clientSessionId, message: { ...op, t: 'op', id } }));
          else consumer.send(JSON.stringify({ type: 'worker-op', id, op, clientSessionId }));
        }
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
        await expect.poll(() => consumer.readyState).toBe(WebSocket.OPEN);
        const selectedTransport = usesWorkerPort ? 'worker-port' : undefined;
        consumer.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'busy', transport: selectedTransport }));
        await expect.poll(() => attached).toBe(true);
        sendOperation('held', {
          method: 'ai.generateContent', model: 'local',
          request: { contents: [{ role: 'user', parts: [{ text: 'Hold this operation' }] }] },
          engine: { kind: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` },
        });
        await expect.poll(() => upstreamResponse !== undefined).toBe(true);
        for (const id of acceptedIds) {
          const sendsTool = usesWorkerPort && id === acceptedIds[0];
          if (sendsTool) {
            consumer.send(JSON.stringify({ type: 'worker-message', message: {
              t: 'tool', id, name: 'firestore_get_document', args: { path: 'shared/greeting' }, actAs: { mode: 'admin' },
            } }));
          } else {
            sendOperation(id, { method: 'getDoc', path: 'shared/greeting', actAs: { mode: 'admin' } });
          }
        }
        sendOperation('excess', {
          method: 'setDoc', path: 'limit/refused', data: { message: 'Must not be written' }, actAs: { mode: 'admin' },
        });
        await expect.poll(() => replies.get('excess')).toMatchObject({ ok: false, error: { code: 'resource-exhausted' } });
        sendOperation('forged', {
          method: 'setDoc', path: 'limit/forged', data: { message: 'Must not be written' }, actAs: { mode: 'admin' },
        }, 'unattached-client');
        await expect.poll(() => replies.get('forged')).toMatchObject({ ok: false, error: { code: 'resource-exhausted' } });
        expect(replies.has('held')).toBe(false);
        await page.locator('#write').click();
        await expect(page.locator('#write-result')).toHaveText('Written');
        releaseUpstream();
        await expect.poll(() => replies.size).toBe(258);
        expect(replies.get('held')?.ok).toBe(!failsFirstOperation);
        for (const id of acceptedIds) expect(replies.get(id)?.ok).toBe(true);
        expect(await page.evaluate(async () => {
          const sdk = await import('firebase/firestore');
          const refused = await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'limit/refused'));
          const forged = await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'limit/forged'));
          return [refused.exists(), forged.exists()];
        })).toEqual([false, false]);
        sendOperation('next', {
          method: 'setDoc', path: 'limit/next', data: { message: 'Capacity released' }, actAs: { mode: 'admin' },
        });
        await expect.poll(() => replies.get('next')).toMatchObject({ ok: true });
      } finally {
        releaseUpstream();
        socket?.close();
        try {
          await page.close().finally(() => fixture?.stop());
        } finally {
          upstream.closeAllConnections();
          await new Promise<void>((resolve, reject) => upstream.close(error => {
            const failed = error !== undefined;
            if (failed) reject(error);
            else resolve();
          }));
        }
      }
    });
  }
}
