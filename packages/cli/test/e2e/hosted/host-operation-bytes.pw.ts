import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerResFrame } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { startSoakServe } from '../soak/harness.js';

for (const scenario of [
  { transport: 'worker-port', boundaryOffset: -1, failsUpstream: false },
  { transport: 'worker-port', boundaryOffset: 0, failsUpstream: false },
  { transport: 'worker-port', boundaryOffset: 1, failsUpstream: false },
  { transport: 'worker-port', boundaryOffset: 1, failsUpstream: true },
  { transport: 'worker-relay', boundaryOffset: -1024, failsUpstream: false },
  { transport: 'worker-relay', boundaryOffset: 1024, failsUpstream: false },
]) {
  const { transport, boundaryOffset, failsUpstream } = scenario;
  const usesWorkerPort = transport === 'worker-port';
  test(`Node host ${transport} operation bytes enforce 24 MiB (offset: ${boundaryOffset}, failure: ${failsUpstream})`, async ({ page }) => {
    let upstreamResponse: ServerResponse | undefined;
    let upstreamRequests = 0;
    const upstream = createServer((request, response) => {
      request.resume();
      upstreamResponse = response;
      upstreamRequests += 1;
    });
    let fixture: Awaited<ReturnType<typeof startSoakServe>> | undefined;
    let socket: WebSocket | undefined;
    const replies = new Map<string, Pick<WorkerResFrame, 'ok' | 'error'>>();
    const utf8 = new TextEncoder();
    let attached = false;
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
        id: 'local-host-bytes', object: 'chat.completion', created: 0, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Released' }, finish_reason: 'stop' }],
      }));
    }
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The local AI fixture has no listening address.');
      fixture = await startSoakServe({
        flags: ['--hosted', '--no-capture'],
        extraFiles: {
          'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
          'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
          'storage.rules': "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
        },
      });
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
      function send(message: Extract<InboundMessage, { t: 'op' }>): void {
        if (usesWorkerPort) {
          consumer.send(JSON.stringify({ type: 'worker-message', message }));
        } else {
          const { t, id, ...op } = message;
          consumer.send(JSON.stringify({ type: 'worker-op', id, op }));
        }
      }
      const encodedBytes = (message: InboundMessage): number => utf8.encode(JSON.stringify(message)).byteLength;
      function upload(id: string, bytes: number): Extract<InboundMessage, { method: 'storage.putBytes' }> {
        const message = { t: 'op', id, method: 'storage.putBytes', path: `queue/${id}`,
          dataB64: '', metadata: { customMetadata: { label: 'é' } } } satisfies InboundMessage;
        const payloadBytes = bytes - encodedBytes(message);
        message.dataB64 = 'AAAA'.repeat(Math.floor(payloadBytes / 4));
        message.metadata.customMetadata.label += 'x'.repeat(payloadBytes % 4);
        return message;
      }
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => consumer.readyState).toBe(WebSocket.OPEN);
      const selectedTransport = usesWorkerPort ? 'worker-port' : undefined;
      consumer.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'busy', transport: selectedTransport }));
      await expect.poll(() => attached).toBe(true);
      for (const round of ['initial', 'refill']) {
        const held = { t: 'op', id: `${round}-held`, method: 'ai.generateContent', model: 'local',
          request: { contents: [{ role: 'user', parts: [{ text: 'Hold this operation' }] }] },
          engine: { kind: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` },
        } satisfies InboundMessage;
        const isInitial = round === 'initial';
        // Legacy relay remints correlation IDs and adds routing fields. Its
        // scenarios straddle the boundary with margin; worker-port tests are exact.
        const refillOffset = usesWorkerPort ? 0 : -1024;
        const offset = isInitial ? boundaryOffset : refillOffset;
        const first = upload(`${round}-first`, 8 * 1024 * 1024);
        const second = upload(`${round}-second`, 8 * 1024 * 1024);
        const third = upload(`${round}-third`, 24 * 1024 * 1024 - encodedBytes(held)
          - encodedBytes(first) - encodedBytes(second) + offset);
        expect(encodedBytes(held) + encodedBytes(first) + encodedBytes(second) + encodedBytes(third))
          .toBe(24 * 1024 * 1024 + offset);
        send(held);
        const requestCount = isInitial ? 1 : 2;
        await expect.poll(() => upstreamRequests).toBe(requestCount);
        send(first);
        send(second);
        send(third);
        const exceedsLimit = offset > 0;
        let refusalId = third.id;
        const fitsLimit = !exceedsLimit;
        if (fitsLimit) {
          refusalId = `${round}-probe`;
          send(upload(refusalId, 4096));
        }
        await expect.poll(() => replies.get(refusalId)).toMatchObject({ ok: false, error: { code: 'resource-exhausted' } });
        expect(replies.has(held.id)).toBe(false);
        await page.evaluate(async round => {
          const sdk = await import('firebase/firestore');
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'queue/healthy'), { round });
        }, round);
        releaseUpstream();
        const expectsHeldSuccess = !(isInitial && failsUpstream);
        await expect.poll(() => replies.get(held.id)).toMatchObject({ ok: expectsHeldSuccess });
        for (const message of [first, second]) {
          await expect.poll(() => replies.get(message.id)).toMatchObject({ ok: true });
        }
        const thirdSucceeds = !exceedsLimit;
        await expect.poll(() => replies.get(third.id)).toMatchObject({ ok: thirdSucceeds });
        const stored = await page.evaluate(async path => {
          const sdk = await import('firebase/storage');
          return sdk.getMetadata(sdk.ref(sdk.getStorage(), path)).then(
            metadata => ({ exists: true, size: metadata.size }),
            error => ({ exists: false, code: String(error.code) }),
          );
        }, third.path);
        expect(stored.exists).toBe(thirdSucceeds);
        if (exceedsLimit) expect(stored).toMatchObject({ code: 'storage/object-not-found' });
      }
    } finally {
      releaseUpstream();
      socket?.close();
      try {
        await page.close().finally(() => fixture?.stop());
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    }
  });
}
