import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type ToolCallRequest } from '../../../src/bridge/protocol.js';
import { McpHttpClient, startSoakServe } from '../soak/harness.js';

for (const failsUpstream of [false, true]) {
  test(`independent MCP callers make progress through the SharedWorker browser relay (upstream failure: ${failsUpstream})`, async ({ page }) => {
    const calls: ToolCallRequest[] = [];
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      const frame: unknown = JSON.parse(String(payload));
      const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
      if (isToolCall) calls.push(frame);
    }));
    let heldResponse: ServerResponse | undefined;
    const upstream = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      const isPreflight = request.method === 'OPTIONS';
      if (isPreflight) {
        response.writeHead(204).end();
        return;
      }
      request.resume();
      heldResponse = response;
    });
    function releaseUpstream(): void {
      const response = heldResponse;
      const cannotReply = response === undefined || response.writableEnded;
      if (cannotReply) return;
      if (failsUpstream) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Local upstream failed' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'mcp-fairness', object: 'chat.completion', created: 0, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Released' }, finish_reason: 'stop' }],
      }));
    }
    let fixture: Awaited<ReturnType<typeof startSoakServe>> | undefined;
    const pending: Promise<unknown>[] = [];
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The local AI fixture has no listening address.');
      await page.addInitScript(({ baseUrl }) => {
        const postMessage = MessagePort.prototype.postMessage;
        let injected = false;
        MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
          const isRecord = message !== null && typeof message === 'object';
          const isTool = isRecord && 't' in message && message.t === 'tool' && 'args' in message;
          const args: unknown = isTool ? message.args : undefined;
          const hasPath = args !== null && typeof args === 'object' && 'path' in args;
          const isHeldTool = hasPath && args.path === 'held/first';
          const injectsPendingWork = isHeldTool && !injected;
          if (injectsPendingWork) {
            injected = true;
            // Exercise the real worker queue with a pending service operation,
            // retaining the caller ownership supplied by the browser relay.
            const hasClient = isRecord && 'clientSessionId' in message;
            const clientSessionId = hasClient ? message.clientSessionId : undefined;
            postMessage.call(this, {
              t: 'op', id: 'held-ai',
              clientSessionId,
              method: 'ai.generateContent', model: 'local',
              request: { contents: [{ role: 'user', parts: [{ text: 'Hold this caller' }] }] },
              engine: { kind: 'openai', baseUrl },
            });
          }
          const transfersObjects = Array.isArray(options);
          const serialization = transfersObjects ? { transfer: options } : options;
          return postMessage.call(this, message, serialization);
        };
      }, { baseUrl: `http://127.0.0.1:${address.port}/v1` });
      fixture = await startSoakServe({
        flags: ['--no-capture'],
        extraFiles: {
          'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
          'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
        },
      });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
      const busy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      const healthy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await busy.initialize();
      await healthy.initialize();
      let busyResult: unknown;
      const first = busy.toolCall('firestore_create_document', {
        path: 'held/first', data: { message: 'Released caller' }, as: 'admin',
      }).then(result => { busyResult = result; });
      pending.push(first);
      await expect.poll(() => heldResponse !== undefined).toBe(true);
      let queuedResult: unknown;
      const queuedRead = busy.toolCall('firestore_get_document', { path: 'held/first', as: 'admin' })
        .then(result => { queuedResult = result; });
      pending.push(queuedRead);
      await expect.poll(() => calls.length).toBe(2);
      let healthyResult: unknown;
      const second = healthy.toolCall('firestore_create_document', {
        path: 'shared/greeting', data: { message: 'Independent MCP caller' }, as: 'admin',
      }).then(result => { healthyResult = result; });
      pending.push(second);
      await expect.poll(() => healthyResult, { timeout: 3_000 }).toMatchObject({ ok: true });
      await expect(page.locator('#document')).toHaveText('Independent MCP caller');
      await expect(healthy.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
        .resolves.toMatchObject({ ok: true, data: { data: { message: 'Independent MCP caller' } } });
      expect(busyResult).toBeUndefined();
      expect(queuedResult).toBeUndefined();
      const [busyWrite, busyRead, healthyWrite] = calls;
      expect(busyWrite.callerId).toEqual(expect.any(String));
      expect(busyRead.callerId).toBe(busyWrite.callerId);
      expect(healthyWrite.callerId).toEqual(expect.any(String));
      expect(healthyWrite.callerId).not.toBe(busyWrite.callerId);
      releaseUpstream();
      await Promise.all([first, queuedRead]);
      expect(queuedResult).toMatchObject({ ok: true, data: { data: { message: 'Released caller' } } });
      expect(busyResult).toMatchObject({ ok: true });
      await expect(busy.toolCall('firestore_create_document', {
        path: 'shared/greeting', data: { message: 'Caller usable after release' }, as: 'admin',
      })).resolves.toMatchObject({ ok: true });
      await expect(page.locator('#document')).toHaveText('Caller usable after release');
      await expect(healthy.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
        .resolves.toMatchObject({ ok: true, data: { data: { message: 'Caller usable after release' } } });
      await expect(busy.toolCall('firestore_get_document', { path: 'held/first', as: 'admin' }))
        .resolves.toMatchObject({ ok: true, data: { data: { message: 'Released caller' } } });
    } finally {
      releaseUpstream();
      await Promise.allSettled(pending);
      await page.close().finally(() => fixture?.stop());
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
}
