/**
 * Ephemeral loopback worker-relay host for in-process `functions.fire`.
 *
 * Main-thread IPC (`process.send`) reaches only the child's entry thread, so
 * any `node:worker_threads` `Worker` or nested child process spawned inside a
 * user Functions handler would have no sandbox host to dial. Binding an
 * authenticated `127.0.0.1:0` loopback relay for the lifetime of a single
 * synthetic trigger execution gives the main thread, `eval` Workers, file
 * Workers, and nested subprocesses one shared `HostCtx` backed by
 * `ctx.sandbox`, without writing `.pyric/serve.json` to disk.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getFirestore } from 'pyric/firestore';
import type { LocalSandbox } from 'pyric/sandbox';
import { WebSocketServer, type WebSocket } from 'ws';
import { cliVersion } from '../../pkg-version.js';
import {
  cleanupPortWithDisconnect,
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../serve/worker/protocol.js';
import {
  MAX_BRIDGE_FRAME_BYTES,
  WORKER_RELAY_CAPABILITY,
  isBridgeMessage,
  type BridgeMessage,
} from '../protocol.js';

export interface EphemeralFunctionsHost {
  serveUrl(): string;
  readonly instanceId: string;
  readonly sessionToken: string;
  close(): Promise<void>;
}

const WS_PATH = '/__pyric/sandbox';
const HEALTH_PATH = '/__pyric/health';
const INIT_PATH = '/__pyric/init.json';
const BEACON_PATH = '/__pyric/beacon';

function hasValidToken(req: IncomingMessage, expected: string): boolean {
  const header = req.headers['x-pyric-session-token'];
  if (typeof header === 'string') return header === expected;
  return false;
}

function sendFrame(ws: WebSocket, frame: BridgeMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

export async function startEphemeralFunctionsHost(
  sandbox: LocalSandbox,
  options: { projectId: string; defaultInstance: string },
): Promise<EphemeralFunctionsHost> {
  const instanceId = `ephemeral-fn-${randomUUID()}`;
  const sessionToken = randomBytes(24).toString('hex');
  const hostCtx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    flushPersistence: async () => {},
    instanceId,
    subs: new Map(),
    messagingEnabled: true,
    defaultRtdbInstance: options.defaultInstance,
    rtdbProjectId: options.projectId,
    appOptions: { projectId: options.projectId },
  };

  let portNumber = 0;
  let closing = false;
  let pending = Promise.resolve();
  const portCleanups = new Set<() => Promise<void>>();
  const openSockets = new Set<WebSocket>();

  const enqueue = (port: PortLike, message: InboundMessage): void => {
    if (closing) return;
    pending = pending
      .then(() => {
        if (closing) return undefined;
        return handleMessage(hostCtx, port, message);
      })
      .catch(() => undefined);
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === HEALTH_PATH) {
      if (closing) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'ephemeral host closing' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          mode: 'sandbox',
          instanceId,
          sandboxConnected: true,
          project: options.projectId,
        }),
      );
      return;
    }
    if (pathname === BEACON_PATH) {
      req.resume();
      res.writeHead(204).end();
      return;
    }
    if (pathname === INIT_PATH) {
      if (!hasValidToken(req, sessionToken)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          instanceId,
          sessionToken,
          hosted: true,
          rules: null,
          rulesHash: null,
          storageRules: null,
          storageRulesHash: null,
          bridgeUrl: `ws://127.0.0.1:${portNumber}${WS_PATH}`,
          seed: null,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  };

  const server = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (closing || pathname !== WS_PATH || !hasValidToken(req, sessionToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      openSockets.add(ws);
      const clientSessionId = `ephemeral-client-${randomUUID()}`;
      const port: PortLike = {
        postMessage(raw: unknown) {
          const message = raw as OutboundMessage;
          if (message.t === 'res') {
            if (message.ok) {
              sendFrame(ws, { type: 'worker-res', id: message.id, ok: true, value: message.value });
            } else {
              sendFrame(ws, { type: 'worker-res', id: message.id, ok: false, error: message.error });
            }
          } else if (message.t === 'snap') {
            sendFrame(ws, { type: 'worker-snap', subId: message.subId, value: message.value });
          }
        },
      };

      let cleanedPromise: Promise<void> | undefined;
      const cleanupThisPort = (): Promise<void> => {
        cleanedPromise ??= pending
          .then(() => cleanupPortWithDisconnect(hostCtx, port))
          .catch(() => undefined);
        return cleanedPromise;
      };
      portCleanups.add(cleanupThisPort);

      ws.on('message', (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!isBridgeMessage(parsed)) return;
        if (parsed.type === 'attach') {
          sendFrame(ws, {
            type: 'attach-ack',
            protocol: 1,
            bridgeVersion: cliVersion(),
            serveVersion: cliVersion(),
            clientSessionId,
            peerConnected: true,
            capabilities: [WORKER_RELAY_CAPABILITY],
          });
          return;
        }
        if (parsed.type === 'ping') {
          sendFrame(ws, { type: 'pong', id: parsed.id });
          return;
        }
        if (parsed.type === 'worker-op') {
          enqueue(port, { ...parsed.op, t: 'op', id: parsed.id } as InboundMessage);
        } else if (parsed.type === 'worker-sub') {
          enqueue(port, { ...parsed.sub, t: 'sub', subId: parsed.subId } as InboundMessage);
        } else if (parsed.type === 'worker-unsub') {
          enqueue(port, { t: 'unsub', subId: parsed.subId });
        }
      });

      ws.once('close', () => {
        openSockets.delete(ws);
        void cleanupThisPort();
      });
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  server.unref();
  portNumber = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${portNumber}`;

  let closePromise: Promise<void> | undefined;
  return {
    serveUrl: () => url,
    instanceId,
    sessionToken,
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        for (const ws of openSockets) {
          try {
            ws.close();
          } catch {
            // Ignore socket teardown errors.
          }
        }
        openSockets.clear();
        await Promise.all([...portCleanups].map((fn) => fn()));
        portCleanups.clear();
        await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
        server.closeAllConnections();
        await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
      })();
      return closePromise;
    },
  };
}
