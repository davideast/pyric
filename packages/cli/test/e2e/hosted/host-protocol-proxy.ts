import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

/** Relay a real host connection while replacing only its acknowledgment version. */
export async function startHostProtocolProxy(hostUrl: string, protocol: unknown) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const upstreams = new Set<WebSocket>();

  async function stop(): Promise<void> {
    for (const socket of server.clients) socket.terminate();
    for (const socket of upstreams) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  server.on('connection', downstream => {
    const upstream = new WebSocket(`${hostUrl.replace('http:', 'ws:')}/__pyric/sandbox`);
    upstreams.add(upstream);
    const pending: string[] = [];
    downstream.on('message', data => {
      const isReady = upstream.readyState === WebSocket.OPEN;
      if (isReady) upstream.send(data.toString());
      else pending.push(data.toString());
    });
    upstream.on('open', () => {
      for (const data of pending.splice(0)) upstream.send(data);
    });
    upstream.on('message', data => {
      const frame: unknown = JSON.parse(data.toString());
      const acknowledgesAttach = isBridgeMessage(frame) && frame.type === 'attach-ack';
      if (acknowledgesAttach) downstream.send(JSON.stringify({ ...frame, protocol }));
      else downstream.send(data.toString());
    });
    downstream.on('close', () => upstream.terminate());
    downstream.on('error', () => upstream.terminate());
    upstream.on('error', () => downstream.close());
    upstream.on('close', () => {
      upstreams.delete(upstream);
      downstream.close();
    });
  });

  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a listening protocol proxy');
    return { url: `http://127.0.0.1:${address.port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
