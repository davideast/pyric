/**
 * A bridge with a browser peer socket, for tests that drive forwarded tools
 * end to end over real HTTP and WebSocket.
 *
 * The standalone `pyric bridge` used to serve this, until it lost its
 * browser socket (#1468). This harness composes the same parts the mounted
 * bridge (`pyric sandbox --bridge`) uses: `createBridge`, the full tool
 * surface, `buildMcpServer` per MCP session, and `attachPeer` from
 * `bridge/server/peer.ts` on `/sandbox`. It exposes the `Bridge`, so a test
 * can register consumers and read the caller identity directly.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { buildMcpServer } from '../../src/bridge/server/mcp.js';
import { getBridgeToolSurface } from '../../src/bridge/server/mcp-contract.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { MAX_BRIDGE_FRAME_BYTES } from '../../src/bridge/protocol.js';

export interface PeerBridgeServer {
  readonly bridge: Bridge;
  readonly port: number;
  /** `http://127.0.0.1:<port>`; MCP at `/mcp`, health at `/health`, peers at `/sandbox`. */
  readonly url: string;
  stop(): Promise<void>;
}

type McpSession = {
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
};

export async function startPeerBridgeServer(port = 0): Promise<PeerBridgeServer> {
  const bridge = createBridge({ logger: createSilentLogger(), project: 'sandbox', version: 'test' });
  const surface = getBridgeToolSurface({
    projectDir: process.cwd(),
    consumers: bridge.consumers,
    callerIdentity: bridge.callerIdentity,
  });
  const sessions = new Map<string, McpSession>();
  const pending = new Set<McpSession>();

  async function newSession(): Promise<McpSession> {
    const server = buildMcpServer(bridge, surface);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
        pending.delete(session);
      },
    });
    const session: McpSession = {
      transport,
      async close() {
        await server.close().catch(() => {});
        await transport.close().catch(() => {});
      },
    };
    pending.add(session);
    await server.connect(transport);
    return session;
  }

  const http = createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bridge.health()));
      return;
    }
    if (url !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const hasSessionId = typeof sessionId === 'string' && sessionId.length > 0;
    const existing = hasSessionId ? sessions.get(sessionId) : undefined;
    const session = existing ?? await newSession();
    if (req.method === 'DELETE' && hasSessionId) {
      await session.close();
      sessions.delete(sessionId);
      res.writeHead(204);
      res.end();
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/sandbox') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachPeer(bridge, ws));
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => resolve());
  });
  const address = http.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    bridge,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    async stop() {
      wss.close();
      for (const client of wss.clients) client.terminate();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      for (const session of [...sessions.values(), ...pending]) await session.close();
      sessions.clear();
      pending.clear();
    },
  };
}
