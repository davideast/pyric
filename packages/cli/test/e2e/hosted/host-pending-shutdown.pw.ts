import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type BridgeMessage, type WorkerOpPayload } from '../../../src/bridge/protocol.js';
import { McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

for (const scenario of [
  { deletesApp: false, failsRequest: false },
  { deletesApp: true, failsRequest: false },
  { deletesApp: true, failsRequest: true },
]) {
  const { deletesApp, failsRequest } = scenario;
  test(`shutdown drains accepted work before releasing the project (deleted app: ${deletesApp}, failed request: ${failsRequest})`, async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      heldResponse = response;
    });
    let heldResponse: ServerResponse | undefined;
    function releaseRequest(): void {
      const response = heldResponse;
      const cannotReply = response === undefined || response.writableEnded;
      if (cannotReply) return;
      if (failsRequest) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Local upstream refused the request' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'shutdown', object: 'chat.completion', created: 0, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Finished' }, finish_reason: 'stop' }],
      }));
    }
    const fixture = await startHostedFixture();
    let socket: WebSocket | undefined;
    let contender: ReturnType<typeof startHost> | undefined;
    let replacement: ReturnType<typeof startHost> | undefined;
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The local upstream has no address.');
      const consumer = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
      socket = consumer;
      const replies: BridgeMessage[] = [];
      consumer.on('message', data => {
        const frame: unknown = JSON.parse(data.toString());
        const isKnownFrame = isBridgeMessage(frame);
        if (isKnownFrame) replies.push(frame);
      });
      await once(consumer, 'open');
      const transport = deletesApp ? 'worker-port' : undefined;
      consumer.send(JSON.stringify({ type: 'attach', protocol: 1, transport }));
      await expect.poll(() => replies.some(frame => frame.type === 'attach-ack')).toBe(true);
      function sendOperation(id: string, op: WorkerOpPayload): void {
        if (deletesApp) consumer.send(JSON.stringify({ type: 'worker-message', message: { t: 'op', id, ...op } }));
        else consumer.send(JSON.stringify({ type: 'worker-op', id, op }));
      }
      sendOperation('held', {
        method: 'ai.generateContent', model: 'local',
        request: { contents: [{ role: 'user', parts: [{ text: 'Finish before shutdown' }] }] },
        engine: { kind: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` },
      });
      await expect.poll(() => heldResponse !== undefined).toBe(true);
      sendOperation('accepted-write', {
        method: 'setDoc', path: 'shared/shutdown', data: { message: 'Drained before shutdown' }, actAs: { mode: 'admin' },
      });
      if (deletesApp) consumer.send(JSON.stringify({ type: 'worker-message', message: { t: 'disconnect', id: 'delete-app' } }));
      // The pong follows dispatch of the preceding operation on this same wire.
      consumer.send(JSON.stringify({ type: 'ping', id: 'queued' }));
      await expect.poll(() => replies.some(frame => frame.type === 'pong' && frame.id === 'queued')).toBe(true);
      const disconnected = once(consumer, 'close');
      consumer.close();
      await disconnected;

      const exited = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await expect.poll(fixture.stderr).toContain('Shutting down...');
      contender = startHost(fixture.dir, fixture.info.port);
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
      expect(fixture.child.exitCode).toBeNull();

      releaseRequest();
      expect(await exited).toEqual([0, null]);
      replacement = startHost(fixture.dir, fixture.info.port);
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await mcp.initialize();
      await expect(mcp.toolCall('firestore_get_document', { path: 'shared/shutdown', as: 'admin' }))
        .resolves.toMatchObject({ ok: true, data: { exists: true, data: { message: 'Drained before shutdown' } } });
    } finally {
      releaseRequest();
      socket?.terminate();
      await contender?.stop();
      await replacement?.stop();
      await fixture.stop();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
}
