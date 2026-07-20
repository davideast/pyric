/**
 * `--bridge` for `pyric dev` — mounts the MCP bridge on the SAME origin
 * the app is served from, so one URL carries the app, the sandbox SDK, AND
 * the agent endpoint (the retrofit story end-to-end: `pyric dev --bridge`,
 * point an MCP client at `http://localhost:3473/__pyric/mcp`, and the agent
 * drives the sandbox living in the served page).
 *
 * REUSES the bridge internals (`createBridge`, `buildMcpServer`,
 * `attachPeer`, `collectBody`) directly — the shared transport helpers live in
 * `../bridge/server/peer.ts`; this module composes the bridge into the serve /
 * Vite-plugin origin, it is not a fork of the bridge.
 *
 * Routes (composed into the `/__pyric/` namespace handler):
 *   POST /__pyric/mcp       MCP over streamable HTTP
 *   GET  /__pyric/health    bridge health JSON
 *   WS   /__pyric/sandbox   the in-page sandbox peer (server `upgrade`)
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBridge, type BridgeToolEvent } from '../bridge/server/bridge.js';
import { buildMcpServer } from '../bridge/server/mcp.js';
import { getDefaultMcpToolSurface } from '../bridge/server/mcp-contract.js';
import { createAuditWriter } from '../bridge/server/audit.js';
import { attachPeer } from '../bridge/server/peer.js';
import { pyricVersion } from './standalone-assets.js';
import { isAllowedUpgrade } from './server.js';

const WS_PATH = '/__pyric/sandbox';
const MCP_PATH = '/__pyric/mcp';
const HEALTH_PATH = '/__pyric/health';
const BRIDGE_VERSION = pyricVersion();

export interface BridgeMountOptions {
  project?: string;
  disableAuditLog?: boolean;
  /** WS-upgrade rebinding/origin guard config. The upgrade path bypasses the
   *  static server's request-time `isAllowedHost`, so the mount guards it here
   *  with the SAME allow rule (bound host + loopback + `--allowed-host`).
   *  `allowedHosts: true` = the caller (vite `server.allowedHosts: true`) opted
   *  into all hosts. Omit ⇒ loopback-only. */
  upgradeGuard?: { boundHost: string; allowedHosts?: string[] | true };
}

export interface BridgeMount {
  /** Stable per-process identity (mirrors `/__pyric/health`'s instanceId).
   *  The pointer writer records this so the proxy can verify it reached this
   *  exact server across a cross-family port collision. */
  readonly instanceId: string;
  /** Namespace-handler tier: returns true when the request was handled. */
  handler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Attach the WS upgrade listener to the serve server. */
  attachUpgrade(server: Server): void;
  /** Whether a sandbox peer (a browser tab / SharedWorker relay) is currently
   *  connected. In-process callers (the Vite plugin's Functions start) poll
   *  this instead of self-fetching `/__pyric/health`, which avoids a loopback
   *  fetch on the same event loop. Mirrors `health().sandboxConnected`. */
  sandboxConnected(): boolean;
  /** The browser-side WS URL for the init payload (`bridgeUrl`). */
  wsUrl(origin: { host: string; port: number }): string;
  /** The MCP endpoint for the banner. */
  mcpUrl(origin: { host: string; port: number }): string;
}

export function createBridgeMount(opts: BridgeMountOptions = {}): BridgeMount {
  const project = opts.project ?? 'sandbox';
  const auditWriter = opts.disableAuditLog ? null : createAuditWriter(project);

  const bridge = createBridge({
    project,
    version: BRIDGE_VERSION,
    onToolEvent: auditWriter ? (event: BridgeToolEvent) => auditWriter.write(event) : undefined,
  });

  // STATEFUL MCP: a per-session transport+server map, mirroring the standalone
  // bridge (`bridge/server/standalone.ts`). Each Streamable-HTTP client gets an
  // `Mcp-Session-Id` on initialize and resumes the SAME session on every later
  // request. The old per-request, `sessionIdGenerator: undefined` build returned
  // no session id, so clients (Claude Code, Cursor) dropped and 404'd on every
  // reconnect/dev-server restart. The long-lived `bridge` (peer + dispatch +
  // audit) is shared; each session owns its transport+server.
  const SESSION_IDLE_MS = 10 * 60_000;
  const MAX_SESSIONS = 64;
  type Session = {
    transport: StreamableHTTPServerTransport;
    close: () => Promise<void>;
    idle: ReturnType<typeof setTimeout> | null;
    sessionId: string | null;
  };
  const sessions = new Map<string, Session>();

  const bumpIdle = (s: Session): void => {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      if (s.sessionId) sessions.delete(s.sessionId);
      void s.close();
    }, SESSION_IDLE_MS);
  };

  const newSession = async (): Promise<Session> => {
    if (sessions.size >= MAX_SESSIONS) {
      const e = new Error(`pyric bridge: at session cap (${MAX_SESSIONS})`);
      (e as { statusCode?: number }).statusCode = 503;
      throw e;
    }
    const session: Session = {
      transport: null as unknown as StreamableHTTPServerTransport,
      close: async () => {},
      idle: null,
      sessionId: null,
    };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.sessionId = id;
        sessions.set(id, session);
        bumpIdle(session);
      },
    });
    session.transport.onclose = () => {
      if (session.sessionId) sessions.delete(session.sessionId);
    };
    const surface = getDefaultMcpToolSurface();
    const server = buildMcpServer(bridge, {
      forwarded: surface.forwarded,
      inProcess: surface.inProcess,
    });
    session.close = async () => {
      if (session.idle) clearTimeout(session.idle);
      await server.close().catch(() => {});
      await session.transport.close().catch(() => {});
    };
    await server.connect(session.transport);
    return session;
  };

  return {
    async handler(req, res, url) {
      if (url.pathname === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.health()));
        return true;
      }
      if (url.pathname === MCP_PATH) {
        try {
          const sessionId = (req.headers['mcp-session-id'] ?? req.headers['Mcp-Session-Id']) as string | undefined;
          let session = sessionId ? sessions.get(sessionId) : undefined;
          if (session) bumpIdle(session);
          else session = await newSession();

          if (req.method === 'DELETE' && sessionId) {
            await session.close();
            sessions.delete(sessionId);
            res.writeHead(204).end();
            return true;
          }
          // The transport reads the raw request stream itself. Do NOT pre-parse
          // the body (the old `collectBody` path); a double read hangs the
          // initialize POST.
          await session.transport.handleRequest(req, res);
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
          if (!res.headersSent) {
            res.writeHead(statusCode, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        }
        return true;
      }
      return false;
    },
    attachUpgrade(server) {
      const wss = new WebSocketServer({ noServer: true });
      const guard = opts.upgradeGuard;
      server.on('upgrade', (req, socket, head) => {
        if ((req.url ?? '') !== WS_PATH) return;
        // DNS-rebinding + cross-origin hijack guard. The static/dev server runs
        // isAllowedHost on the `request` event only; `upgrade` is a separate
        // listener that bypasses it, so re-check both Host and Origin here
        // before registering the peer (which last-wins the tool channel).
        // `allowedHosts: true` means the caller explicitly opted into all hosts.
        if (guard && guard.allowedHosts !== true) {
          const boundHost = guard.boundHost;
          const extra = Array.isArray(guard.allowedHosts) ? guard.allowedHosts : [];
          if (!isAllowedUpgrade(req.headers, boundHost, extra)) {
            socket.destroy();
            return;
          }
        }
        wss.handleUpgrade(req, socket as never, head, (ws: WebSocket) => {
          attachPeer(bridge, ws);
        });
      });
    },
    sandboxConnected: () => bridge.health().sandboxConnected === true,
    instanceId: bridge.instanceId,
    wsUrl: ({ host, port }) => `ws://${host}:${port}${WS_PATH}`,
    mcpUrl: ({ host, port }) => `http://${host}:${port}${MCP_PATH}`,
  };
}
