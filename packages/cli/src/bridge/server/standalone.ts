/**
 * Standalone bridge server. Spins up an HTTP server on a known
 * loopback port that handles three routes:
 *
 *   GET  /health           — diagnostic
 *   POST /mcp              — MCP-over-HTTP (StreamableHTTPServerTransport)
 *   GET  /sandbox (Upgrade) — WebSocket the browser tab connects to
 *
 * Bound to 127.0.0.1 only. Refuses to start if the port is occupied.
 *
 * Premortem fixes baked in:
 *  - #A2 — per-session idle timeout (10 min default) + max-session cap.
 *  - #U1 — peer connect/disconnect logged; per-call logging behind
 *    PYRIC_VERBOSE=1.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBridge, type Bridge, type BridgeToolEvent } from './bridge.js';
import { buildMcpServer } from './mcp.js';
import { getDefaultMcpToolSurface } from './mcp-contract.js';
import { createAuditWriter, type AuditWriter } from './audit.js';
import {
  createConsoleLogger,
  createSilentLogger,
  type BridgeLogger,
} from './logger.js';
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_HEALTH_PATH,
  DEFAULT_MCP_PATH,
  DEFAULT_SANDBOX_PATH,
  type BridgeMessage,
  isBridgeMessage,
} from '../protocol.js';
import { pyricVersion } from '../../serve/standalone-assets.js';
import { isAllowedUpgrade } from '../../serve/server.js';

const BRIDGE_VERSION = pyricVersion();
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_SESSIONS = 50;

export interface StartServerOptions {
  /** Port to bind. Default: 5174. Env: PYRIC_PORT. */
  port?: number;
  /** Sandbox label surfaced in health and audit metadata. */
  project?: string;
  /** Disable the audit log writer (useful in tests). */
  disableAuditLog?: boolean;
  /** Extra hostnames allowed past the WS-upgrade rebinding/origin guard
   *  (besides the loopback set the bridge binds to). Mirrors serve's
   *  `--allowed-host`. */
  allowedHosts?: string[];
  /** Override the audit writer (testing). */
  auditWriter?: AuditWriter;
  /** Premortem #A2 — kill idle sessions after this many ms. Default 10 min. */
  sessionIdleMs?: number;
  /** Premortem #A2 — refuse new sessions when this many are active. Default 50. */
  maxSessions?: number;
  /** Premortem #U1 — logger; defaults to stderr `[pyric]` prefix. */
  logger?: BridgeLogger;
  /** Convenience: install a silent logger (tests). */
  silent?: boolean;

}

export interface ServerHandle {
  readonly bridge: Bridge;
  readonly port: number;
  readonly url: string;
  readonly auditLogPath: string | null;
  stop(): Promise<void>;
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<ServerHandle> {
  // `??` doesn't short-circuit on NaN; Number(undefined) is NaN, which
  // would silently slip through to the http server and produce
  // "options.port should be >= 0 and < 65536. Received NaN."
  // Resolve the env var separately so the default actually wins.
  const envPort = process.env.PYRIC_PORT ? Number(process.env.PYRIC_PORT) : undefined;
  const port = opts.port ?? (Number.isFinite(envPort) ? envPort : undefined) ?? DEFAULT_BRIDGE_PORT;
  const project = opts.project ?? process.env.PYRIC_PROJECT ?? 'sandbox';
  const logger =
    opts.logger ?? (opts.silent ? createSilentLogger() : createConsoleLogger());
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

  // Set up audit log writer (best-effort).
  const auditWriter = opts.disableAuditLog
    ? null
    : opts.auditWriter ?? createAuditWriter(project);

  const bridge = createBridge({
    project,
    version: BRIDGE_VERSION,
    onToolEvent: (event: BridgeToolEvent) => {
      auditWriter?.write(event);
      logger.verbose(
        `tool ${event.tool} → ${event.result.ok ? 'ok' : 'fail'} (${event.durationMs}ms) [${event.mode}]`,
      );
    },
  });

  const { forwarded, inProcess } = getDefaultMcpToolSurface();

  // Per-session transport+server map. Each MCP client connection
  // gets its own pair; cleared on DELETE / idle / transport close.
  type Session = {
    transport: StreamableHTTPServerTransport;
    close: () => Promise<void>;
    /** Idle-timeout handle; reset on each request. */
    idleTimer: ReturnType<typeof setTimeout> | null;
    sessionId: string | null;
  };
  const sessions = new Map<string, Session>();
  const pendingSessions = new Set<Session>();

  function bumpIdle(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.sessionId) {
        logger.verbose(`session ${session.sessionId.slice(0, 8)}… idle-closed`);
        sessions.delete(session.sessionId);
      }
      pendingSessions.delete(session);
      void session.close();
    }, sessionIdleMs);
  }

  async function newSession(): Promise<Session> {
    if (sessions.size >= maxSessions) {
      const err = new Error(
        `pyric bridge: refusing new session — at session cap (${maxSessions}). Existing sessions: ${sessions.size}.`,
      );
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    }
    const session: Session = {
      transport: null as unknown as StreamableHTTPServerTransport,
      close: async () => {},
      idleTimer: null,
      sessionId: null,
    };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.sessionId = id;
        sessions.set(id, session);
        pendingSessions.delete(session);
        bumpIdle(session);
        logger.verbose(`session ${id.slice(0, 8)}… initialized`);
      },
    });
    const server = buildMcpServer(bridge, { forwarded, inProcess });
    session.close = async () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = null;
      await server.close().catch(() => {});
      await session.transport.close().catch(() => {});
    };
    pendingSessions.add(session);
    await server.connect(session.transport);
    return session;
  }

  // ── HTTP server ─────────────────────────────────────────────────
  const http = createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (process.env.PYRIC_DEBUG) {
      process.stderr.write(`[pyric debug] ${req.method} ${url}\n`);
    }
    if (url === DEFAULT_HEALTH_PATH && req.method === 'GET') {
      const body = JSON.stringify(bridge.health());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (url === DEFAULT_MCP_PATH && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      try {
        const sessionId = (req.headers['mcp-session-id'] ?? req.headers['Mcp-Session-Id']) as string | undefined;
        let session: Session | undefined;
        if (sessionId && sessions.has(sessionId)) {
          session = sessions.get(sessionId);
          if (session) bumpIdle(session);
        } else {
          session = await newSession();
        }
        if (req.method === 'DELETE' && sessionId) {
          if (session) await session.close();
          sessions.delete(sessionId);
          res.writeHead(204);
          res.end();
          return;
        }
        await session!.transport.handleRequest(
          req as IncomingMessage,
          res as ServerResponse,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        logger.error(`MCP transport error: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url }));
  });

  // ── WebSocket server (mounted on /sandbox) ──────────────────────
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '') !== DEFAULT_SANDBOX_PATH) {
      socket.destroy();
      return;
    }
    // DNS-rebinding + cross-origin hijack guard (the request-time isAllowedHost
    // runs on the `request` event only — `upgrade` bypasses it). The standalone
    // bridge binds 127.0.0.1 only, so the allowlist is the loopback set.
    if (!isAllowedUpgrade(req.headers, '127.0.0.1', opts.allowedHosts)) {
      logger.error(
        `refused WS upgrade — Host='${req.headers.host ?? ''}' Origin='${req.headers.origin ?? ''}' (rebinding/origin guard)`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachPeer(bridge, ws, logger);
    });
  });

  // Bind to loopback only.
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const address = http.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${boundPort}`;

  logger.info(`bridge ${BRIDGE_VERSION} listening on ${url} — sandbox: ${project}`);

  return {
    bridge,
    port: boundPort,
    url,
    auditLogPath: auditWriter?.path ?? null,
    async stop() {
      // Stop accepting new WebSocket upgrades…
      wss.close();
      // …and forcibly terminate any existing WS clients. Without this,
      // http.close() below waits for clients to disconnect on their own
      // (MCP keep-alives sit forever — a Ctrl-C with any open peer
      // would hang the CLI shutdown indefinitely).
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* already closed */ }
      }
      // Destroy any open HTTP keep-alive sockets. Node 18.2+.
      http.closeAllConnections();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
      });
      for (const session of sessions.values()) {
        await session.close().catch(() => {});
      }
      for (const session of pendingSessions) {
        await session.close().catch(() => {});
      }
      sessions.clear();
      pendingSessions.clear();
      logger.info('bridge stopped');
    },
  };
}

function attachPeer(bridge: Bridge, ws: WebSocket, logger: BridgeLogger): void {
  let disconnect: (() => void) | null = null;
  let helloed = false;
  let sandboxId: string | null = null;

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed
    }
    if (!isBridgeMessage(msg)) return;

    if (msg.type === 'hello') {
      if (helloed) return; // ignore duplicate hellos
      helloed = true;
      sandboxId = msg.sandboxId;
      logger.info(
        `peer connected — sandboxId=${sandboxId.slice(0, 12)} tools=${msg.tools.length}`,
      );
      disconnect = bridge.registerSandboxPeer(
        (out: BridgeMessage) => {
          try {
            ws.send(JSON.stringify(out));
          } catch {
            // socket likely closed; the close handler runs disconnect.
          }
        },
        msg.tools,
        msg.sandboxId,
      );
      ws.send(
        JSON.stringify({
          type: 'hello-ack',
          protocol: 1,
          bridgeVersion: bridge.version,
        }),
      );
      return;
    }

    if (!helloed) return; // ignore messages before hello
    bridge.handleSandboxMessage(msg);
  });

  ws.on('close', () => {
    if (disconnect) {
      disconnect();
      logger.info(
        `peer disconnected — sandboxId=${sandboxId ? sandboxId.slice(0, 12) : 'unknown'}`,
      );
    }
    disconnect = null;
  });

  ws.on('error', () => {
    // ws will follow up with a 'close' event; cleanup happens there.
  });
}
