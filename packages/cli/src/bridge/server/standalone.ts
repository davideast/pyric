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
 * Two modes:
 *  - sandbox: forwards data-plane tool calls to the WS-connected
 *    browser. Rules tools execute in-process.
 *  - prod: data-plane + control-plane tools execute in-process via
 *    composeMcpRegistry. Every prod-write tool call goes through the
 *    confirmation handler (terminal y/n prompt by default) before
 *    execution. See design rationale
 *
 * Premortem fixes baked in:
 *  - #S1 — prod-mode tool calls require terminal confirmation
 *    (`/dev/tty` prompt) instead of a Bearer token. The token was
 *    security theater against the threats that mattered; the
 *    confirmation gate is the first defense that actually works
 *    against same-user malicious processes.
 *  - #A2 — per-session idle timeout (10 min default) + max-session cap.
 *  - #U1 — peer connect/disconnect logged; per-call logging behind
 *    PYRIC_VERBOSE=1.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolHandler } from '@inbrowser/agent';
import { createBridge, type Bridge, type BridgeToolEvent } from './bridge.js';
import { buildMcpServer } from './mcp.js';
import { getSandboxToolMetadata, getRulesToolHandlers } from './tool-metadata.js';
import { createAuditWriter, type AuditWriter } from './audit.js';
import {
  createConsoleLogger,
  createSilentLogger,
  type BridgeLogger,
} from './logger.js';
import {
  createInteractiveConfirmHandler,
  createDenyAllHandler,
  createPolicyHandler,
  hasInteractiveTTY,
  type ConfirmHandler,
} from './confirm.js';
import {
  DEFAULT_PROD_POLICIES,
  DEFAULT_SANDBOX_POLICY,
  buildPolicyMap,
  type ConfirmPolicy,
} from './confirm-policy.js';
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_HEALTH_PATH,
  DEFAULT_MCP_PATH,
  DEFAULT_SANDBOX_PATH,
  type BridgeMode,
  type BridgeMessage,
  isBridgeMessage,
} from '../protocol.js';
import { pyricVersion } from '../../serve/standalone-assets.js';
import { isAllowedUpgrade } from '../../serve/server.js';

const BRIDGE_VERSION = pyricVersion();
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_CONFIRM_TIMEOUT_MS = 45_000;

export interface StartServerOptions {
  /** Sandbox or prod. Default: sandbox. */
  mode?: BridgeMode;
  /** Port to bind. Default: 5174. Env: PYRIC_PORT. */
  port?: number;
  /** Project id (prod mode requires this; sandbox mode defaults to 'sandbox'). */
  project?: string;
  /**
   * For prod mode: extra ToolHandlers to register (typically the result
   * of `composeMcpRegistry({ profile: 'full', adminDeps, scope })`).
   * Required for prod mode; ignored in sandbox mode.
   */
  prodTools?: ToolHandler[];
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

  // ── Prod-mode confirmation (premortem #S1 v2) ─────────────────────

  /**
   * Per-tool confirmation override: tools listed here drop to `never`
   * (auto-approve without prompt). Use sparingly — every entry is a
   * tool you've decided doesn't need the keystroke gate.
   */
  autoApproveTools?: string[];
  /**
   * Per-tool override: tools listed here force to `always` (prompt
   * every time). Use to raise the default for read tools when paranoid.
   */
  requireConfirmTools?: string[];
  /** Force EVERY tool to `always`, even reads. Paranoid mode. */
  requireConfirmAll?: boolean;
  /** Per-prompt timeout. Default 45_000 (45 s). */
  confirmTimeoutMs?: number;
  /**
   * Run prod mode without an interactive TTY. Requires `autoApproveTools`
   * to pre-approve any tool the caller wants invocable; everything not
   * in the allow list denies silently. Throws at startup if mode==='prod'
   * AND no TTY AND nonInteractive===false.
   */
  nonInteractive?: boolean;
  /**
   * Direct override of the confirm handler — testing escape hatch.
   * When set, every other confirm-related option is ignored.
   */
  confirmHandler?: ConfirmHandler;
}

export interface ServerHandle {
  readonly bridge: Bridge;
  readonly port: number;
  readonly url: string;
  readonly auditLogPath: string | null;
  /** The active confirm handler (null in sandbox mode). */
  readonly confirmHandler: ConfirmHandler | null;
  stop(): Promise<void>;
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<ServerHandle> {
  const mode: BridgeMode = opts.mode ?? 'sandbox';
  // `??` doesn't short-circuit on NaN; Number(undefined) is NaN, which
  // would silently slip through to the http server and produce
  // "options.port should be >= 0 and < 65536. Received NaN."
  // Resolve the env var separately so the default actually wins.
  const envPort = process.env.PYRIC_PORT ? Number(process.env.PYRIC_PORT) : undefined;
  const port = opts.port ?? (Number.isFinite(envPort) ? envPort : undefined) ?? DEFAULT_BRIDGE_PORT;
  const project =
    opts.project ?? process.env.PYRIC_PROJECT ?? (mode === 'sandbox' ? 'sandbox' : undefined);
  const logger =
    opts.logger ?? (opts.silent ? createSilentLogger() : createConsoleLogger());
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

  if (mode === 'prod' && !project) {
    throw new Error(
      'pyric bridge: --mode prod requires a project id (--project or PYRIC_PROJECT).',
    );
  }

  // ── Prod-mode confirmation handler ──────────────────────────────
  const confirmHandler = buildConfirmHandler({
    mode,
    nonInteractive: opts.nonInteractive ?? false,
    autoApprove: opts.autoApproveTools ?? [],
    requireConfirm: opts.requireConfirmTools ?? [],
    requireConfirmAll: opts.requireConfirmAll ?? false,
    confirmTimeoutMs: opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    override: opts.confirmHandler,
    logger,
  });

  // Set up audit log writer (best-effort).
  const auditWriter = opts.disableAuditLog
    ? null
    : opts.auditWriter ?? createAuditWriter(project!);

  const bridge = createBridge({
    mode,
    project: project!,
    version: BRIDGE_VERSION,
    confirmHandler: confirmHandler ?? undefined,
    onToolEvent: (event: BridgeToolEvent) => {
      auditWriter?.write(event);
      logger.verbose(
        `tool ${event.tool} → ${event.result.ok ? 'ok' : 'fail'} (${event.durationMs}ms) [${event.mode}]`,
      );
    },
  });

  // Build the MCP server. In sandbox mode, forward sandbox tools to
  // the bridge and run rules tools in-process. In prod mode, run all
  // tools in-process (caller supplies them via `prodTools`).
  const forwarded = mode === 'sandbox' ? getSandboxToolMetadata() : [];
  const rulesTools = mode === 'sandbox' ? getRulesToolHandlers() : [];
  const inProcess: ToolHandler[] = [
    ...rulesTools,
    ...(opts.prodTools ?? []),
  ];

  // Build the policy map ONCE up-front, factoring in any per-tool
  // overrides the caller supplied. Passed through to buildMcpServer
  // so the in-process tool wrapper can consult it per call.
  const policies = buildPolicyMap(
    mode === 'prod' ? DEFAULT_PROD_POLICIES : new Map<string, ConfirmPolicy>(),
    {
      autoApprove: opts.autoApproveTools,
      requireConfirm: opts.requireConfirmTools,
      requireConfirmAll: opts.requireConfirmAll,
    },
  );

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
    const server = buildMcpServer(bridge, { forwarded, inProcess, policies });
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

  const url = `http://127.0.0.1:${port}`;

  logger.info(
    `bridge ${BRIDGE_VERSION} listening on ${url} — mode: ${mode}, project: ${project}`,
  );
  if (mode === 'prod') {
    if (opts.nonInteractive) {
      logger.info(
        `prod-mode NON-INTERACTIVE — auto-approved tools: ${(opts.autoApproveTools ?? []).join(', ') || '(none)'}`,
      );
    } else {
      logger.info(
        `prod-mode interactive — confirmation prompts appear in this terminal (timeout ${
          opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
        }ms → DENY)`,
      );
    }
  }

  return {
    bridge,
    port,
    url,
    auditLogPath: auditWriter?.path ?? null,
    confirmHandler: confirmHandler ?? null,
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
      if (confirmHandler) confirmHandler.close();
      logger.info('bridge stopped');
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

interface BuildConfirmHandlerOptions {
  mode: BridgeMode;
  nonInteractive: boolean;
  autoApprove: string[];
  requireConfirm: string[];
  requireConfirmAll: boolean;
  confirmTimeoutMs: number;
  override?: ConfirmHandler;
  logger: BridgeLogger;
}

function buildConfirmHandler(opts: BuildConfirmHandlerOptions): ConfirmHandler | null {
  if (opts.mode === 'sandbox') return null;

  // Tests / callers can provide their own handler directly.
  if (opts.override) return opts.override;

  if (opts.nonInteractive) {
    // CI-mode: explicit allow list; deny everything else.
    return createPolicyHandler({
      allow: new Set(opts.autoApprove),
      default: 'deny',
    });
  }

  if (!hasInteractiveTTY()) {
    throw new Error(
      'pyric bridge: prod mode requires either an interactive terminal or `nonInteractive: true` (CLI: --non-interactive). Refusing to start without a way to confirm tool calls.',
    );
  }

  const policies = buildPolicyMap(DEFAULT_PROD_POLICIES, {
    autoApprove: opts.autoApprove,
    requireConfirm: opts.requireConfirm,
    requireConfirmAll: opts.requireConfirmAll,
  });

  return createInteractiveConfirmHandler({
    policies,
    timeoutMs: opts.confirmTimeoutMs,
    logger: opts.logger,
  });
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
