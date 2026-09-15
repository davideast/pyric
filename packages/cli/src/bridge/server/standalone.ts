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

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBridge, type Bridge, type BridgeToolEvent } from './bridge.js';
import { buildMcpServer } from './mcp.js';
import { getBridgeToolSurface } from './mcp-contract.js';
import { createAuditWriter, type AuditWriter } from './audit.js';
import {
  createConsoleLogger,
  createSilentLogger,
  type BridgeLogger,
} from './logger.js';
import {
  DEFAULT_BRIDGE_PORT,
  MAX_BRIDGE_FRAME_BYTES,
  DEFAULT_HEALTH_PATH,
  DEFAULT_MCP_PATH,
  DEFAULT_SANDBOX_PATH,
  type BridgeMessage,
} from '../protocol.js';
import { parseBridgeMessage, requestEnvelopeError, requestProtocolError } from './request-envelope.js';
import { sendBridgeMessage } from './socket-message.js';
import { pyricVersion } from '../../serve/standalone-assets.js';
import { isAllowedLoopbackRequest, isAllowedUpgrade } from '../../serve/server.js';

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
  const envPort = Number(process.env.PYRIC_PORT);
  const hasEnvPort = Boolean(process.env.PYRIC_PORT) && Number.isFinite(envPort);
  let defaultPort = DEFAULT_BRIDGE_PORT;
  if (hasEnvPort) defaultPort = envPort;
  const port = opts.port ?? defaultPort;
  const defaultProject = process.env.PYRIC_PROJECT ?? 'sandbox';
  const project = opts.project ?? defaultProject;
  const logger = opts.logger ?? defaultLogger(opts.silent);
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

  let auditWriter: AuditWriter | null = null;
  const recordsAudit = opts.disableAuditLog !== true;
  if (recordsAudit) auditWriter = opts.auditWriter ?? createAuditWriter(project);

  const bridge = createBridge({
    project,
    version: BRIDGE_VERSION,
    onToolEvent: (event: BridgeToolEvent) => {
      auditWriter?.write(event);
      const succeeded = event.result.ok;
      logger.verbose(
        `tool ${event.tool} → ${succeeded ? 'ok' : 'fail'} (${event.durationMs}ms) [${event.mode}]`,
      );
    },
  });

  const { forwarded, inProcess } = getBridgeToolSurface({
    consumers: bridge.consumers,
    callerIdentity: bridge.callerIdentity,
  });

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
    const idleTimer = session.idleTimer;
    const hasIdleTimer = idleTimer !== null;
    if (hasIdleTimer) clearTimeout(idleTimer);
    session.idleTimer = setTimeout(() => {
      const sessionId = session.sessionId;
      const hasSessionId = Boolean(sessionId) && sessionId !== null;
      if (hasSessionId) {
        logger.verbose(`session ${sessionId.slice(0, 8)}… idle-closed`);
        sessions.delete(sessionId);
      }
      pendingSessions.delete(session);
      void session.close();
    }, sessionIdleMs);
  }

  async function newSession(): Promise<Session> {
    const isAtSessionCap = sessions.size >= maxSessions;
    if (isAtSessionCap) {
      const err = new Error(
        `pyric bridge: refusing new session — at session cap (${maxSessions}). Existing sessions: ${sessions.size}.`,
      );
      Object.assign(err, { statusCode: 503 });
      throw err;
    }
    const transport = new StreamableHTTPServerTransport({
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
    const session: Session = {
      transport,
      idleTimer: null,
      sessionId: null,
      async close() {
        const idleTimer = session.idleTimer;
        const hasIdleTimer = idleTimer !== null;
        if (hasIdleTimer) clearTimeout(idleTimer);
        session.idleTimer = null;
        await server.close().catch(() => {});
        await transport.close().catch(() => {});
      },
    };
    pendingSessions.add(session);
    await server.connect(session.transport);
    return session;
  }

  // ── HTTP server ─────────────────────────────────────────────────
  const http = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const debugEnabled = Boolean(process.env.PYRIC_DEBUG);
    if (debugEnabled) {
      process.stderr.write(`[pyric debug] ${req.method} ${url}\n`);
    }
    const requestsHealth = url === DEFAULT_HEALTH_PATH && req.method === 'GET';
    if (requestsHealth) {
      const body = JSON.stringify(bridge.health());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    const supportsMcpMethod = req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE';
    const requestsMcp = url === DEFAULT_MCP_PATH && supportsMcpMethod;
    if (requestsMcp) {
      const refusesOrigin = !isAllowedLoopbackRequest(req, '127.0.0.1', opts.allowedHosts);
      if (refusesOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: invalid host or origin' }));
        return;
      }
      try {
        const sessionId = req.headers['mcp-session-id'] ?? req.headers['Mcp-Session-Id'];
        const hasSessionId = typeof sessionId === 'string' && sessionId.length > 0;
        let session: Session | undefined;
        if (hasSessionId) session = sessions.get(sessionId);
        const retainedSession = session;
        const needsSession = retainedSession === undefined;
        if (needsSession) session = await newSession();
        else {
          session = retainedSession;
          bumpIdle(session);
        }
        const deletesSession = req.method === 'DELETE' && hasSessionId;
        if (deletesSession) {
          await session.close();
          sessions.delete(sessionId);
          res.writeHead(204);
          res.end();
          return;
        }
        await session.transport.handleRequest(req, res);
      } catch (err) {
        let statusCode = 500;
        const hasStatusCode = typeof err === 'object' && err !== null && 'statusCode' in err;
        if (hasStatusCode) {
          const code = err.statusCode;
          const hasNumericCode = typeof code === 'number';
          if (hasNumericCode) statusCode = code;
        }
        const isError = err instanceof Error;
        let message: string;
        let diagnostic: string;
        if (isError) {
          message = err.message;
          diagnostic = err.stack ?? message;
        } else {
          message = String(err);
          diagnostic = message;
        }
        logger.error(`MCP transport error: ${diagnostic}`);
        const canSendError = !res.headersSent;
        if (canSendError) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url }));
  });

  // ── WebSocket server (mounted on /sandbox) ──────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });
  http.on('upgrade', (req, socket, head) => {
    const hasWrongPath = (req.url ?? '') !== DEFAULT_SANDBOX_PATH;
    if (hasWrongPath) {
      socket.destroy();
      return;
    }
    // DNS-rebinding + cross-origin hijack guard (the request-time isAllowedHost
    // runs on the `request` event only — `upgrade` bypasses it). The standalone
    // bridge binds 127.0.0.1 only, so the allowlist is the loopback set.
    const refusesUpgrade = !isAllowedUpgrade(req.headers, '127.0.0.1', opts.allowedHosts);
    if (refusesUpgrade) {
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
  const hasBoundAddress = typeof address === 'object' && address !== null;
  const boundPort = hasBoundAddress ? address.port : port;
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
  let peerGeneration = 0;

  ws.on('message', (raw) => {
    const isClosingConnection = ws.readyState !== ws.OPEN;
    if (isClosingConnection) return;
    const parsed = parseBridgeMessage(raw.toString());
    const isInvalidMessage = parsed.kind === 'invalid';
    if (isInvalidMessage) {
      ws.close(1002, parsed.reason);
      return;
    }
    const msg = parsed.message;
    const isHello = msg.type === 'hello';
    if (isHello) {
      const protocolError = requestProtocolError(msg);
      const hasProtocolError = protocolError !== undefined;
      if (hasProtocolError) {
        ws.close(1008, protocolError);
        return;
      }
      const envelopeError = requestEnvelopeError(msg);
      const hasEnvelopeError = envelopeError !== undefined;
      if (hasEnvelopeError) {
        ws.close(1002, envelopeError);
        return;
      }
      if (helloed) return; // ignore duplicate hellos
      helloed = true;
      sandboxId = msg.sandboxId;
      logger.info(
        `peer connected — sandboxId=${sandboxId.slice(0, 12)} tools=${msg.tools.length}`,
      );
      disconnect = bridge.registerSandboxPeer(
        (out: BridgeMessage) => {
          try {
            sendBridgeMessage(ws, out, bridge.handleSandboxMessage);
          } catch {
            // socket likely closed; the close handler runs disconnect.
          }
        },
        msg.tools,
        msg.sandboxId,
      );
      peerGeneration = bridge.peerGeneration();
      sendBridgeMessage(ws, {
        type: 'hello-ack',
        protocol: 1,
        bridgeVersion: bridge.version,
      });
      return;
    }

    const isUnregistered = !helloed;
    if (isUnregistered) return; // ignore messages before hello
    const envelopeError = requestEnvelopeError(msg);
    const hasEnvelopeError = envelopeError !== undefined;
    if (hasEnvelopeError) {
      ws.close(1002, envelopeError);
      return;
    }
    bridge.handleSandboxMessage(msg, peerGeneration);
  });

  ws.on('close', () => {
    const releasePeer = disconnect;
    const hasPeer = releasePeer !== null;
    if (hasPeer) {
      releasePeer();
      const id = sandboxId;
      const hasId = id !== null && id.length > 0;
      let label = 'unknown';
      if (hasId) label = id.slice(0, 12);
      logger.info(`peer disconnected — sandboxId=${label}`);
    }
    disconnect = null;
  });

  ws.on('error', () => {
    // ws will follow up with a 'close' event; cleanup happens there.
  });
}

/** Construct a default logger only when the caller did not supply one. */
function defaultLogger(silent = false): BridgeLogger {
  if (silent) return createSilentLogger();
  return createConsoleLogger();
}
