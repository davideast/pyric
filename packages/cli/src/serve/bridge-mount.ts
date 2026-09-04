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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBridge, type BridgeToolEvent } from '../bridge/server/bridge.js';
import { buildMcpServer } from '../bridge/server/mcp.js';
import { getDefaultMcpToolSurface } from '../bridge/server/mcp-contract.js';
import { createAuditWriter } from '../bridge/server/audit.js';
import { attachPeer } from '../bridge/server/peer.js';
import { pyricVersion } from './standalone-assets.js';
import { isAllowedLoopbackRequest, isAllowedUpgrade } from './server.js';

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
  /** Canonical project identity used by health, audit, URLs, and discovery. */
  readonly project: string;
  /** Namespace-handler tier: returns true when the request was handled. */
  handler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Attach all bridge-owned host resources and return their explicit owner. */
  attachHost(options: BridgeHostOptions): BridgeHostAttachment;
  /** Close every attachment, peer, and MCP session. Idempotent. */
  close(): Promise<void>;
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

export interface BridgeHostOptions {
  /** Every server accepting upgrades (static serve may bind both IP families). */
  servers: Server[];
  /** Server whose listen/close lifecycle owns discovery publication. */
  lifecycleServer?: Server;
  projectDir: string;
  /** Returns null until a stable, externally reachable origin is known. */
  origin(): { host: string; port: number } | null;
  /** Defaults true. A host with a broader ordered shutdown can opt out and
   *  explicitly close the returned attachment from its own close listener. */
  closeOnServerClose?: boolean;
  /** Vite cannot dual-bind, so its adapter enables the cross-family probe. */
  collision?: {
    warn(message: string, options?: { timestamp?: boolean }): void;
    /** Internal deterministic test seam. */
    fetchImpl?: typeof fetch;
  };
}

export interface BridgeHostAttachment {
  close(): Promise<void>;
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
    closing: Promise<void> | null;
  };
  const sessions = new Map<string, Session>();
  const pendingSessions = new Set<Session>();
  const attachments = new Set<BridgeHostAttachment>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const bumpIdle = (s: Session): void => {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      if (s.sessionId) sessions.delete(s.sessionId);
      pendingSessions.delete(s);
      void s.close();
    }, SESSION_IDLE_MS);
  };

  const newSession = async (): Promise<Session> => {
    if (closed) {
      const error = new Error('pyric bridge: mount is closed');
      (error as { statusCode?: number }).statusCode = 503;
      throw error;
    }
    if (sessions.size + pendingSessions.size >= MAX_SESSIONS) {
      const e = new Error(`pyric bridge: at session cap (${MAX_SESSIONS})`);
      (e as { statusCode?: number }).statusCode = 503;
      throw e;
    }
    const session: Session = {
      transport: null as unknown as StreamableHTTPServerTransport,
      close: async () => {},
      idle: null,
      sessionId: null,
      closing: null,
    };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (closed) {
          pendingSessions.delete(session);
          void session.close();
          return;
        }
        session.sessionId = id;
        sessions.set(id, session);
        pendingSessions.delete(session);
        bumpIdle(session);
      },
    });
    session.transport.onclose = () => {
      if (session.sessionId) sessions.delete(session.sessionId);
      pendingSessions.delete(session);
    };
    const surface = getDefaultMcpToolSurface();
    const server = buildMcpServer(bridge, {
      forwarded: surface.forwarded,
      inProcess: surface.inProcess,
    });
    session.close = () => {
      session.closing ??= (async () => {
        if (session.idle) clearTimeout(session.idle);
        session.idle = null;
        await server.close().catch(() => {});
        await session.transport.close().catch(() => {});
      })();
      return session.closing;
    };
    pendingSessions.add(session);
    try {
      await server.connect(session.transport);
    } catch (error) {
      pendingSessions.delete(session);
      await session.close();
      throw error;
    }
    return session;
  };

  const closeSession = async (session: Session): Promise<void> => {
    if (session.sessionId) sessions.delete(session.sessionId);
    pendingSessions.delete(session);
    await session.close();
  };

  const removeOwnedPointer = (pointer: string): void => {
    try {
      if (!existsSync(pointer)) return;
      const current = JSON.parse(readFileSync(pointer, 'utf8')) as { instanceId?: string };
      if (current.instanceId === bridge.instanceId) rmSync(pointer);
    } catch {
      // Best effort. A malformed or concurrently replaced pointer is not ours.
    }
  };

  const mount: BridgeMount = {
    project,
    instanceId: bridge.instanceId,

    async handler(req, res, url) {
      if (closed && (url.pathname === HEALTH_PATH || url.pathname === MCP_PATH)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'pyric bridge: mount is closed' }));
        return true;
      }
      if (url.pathname === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.health()));
        return true;
      }
      if (url.pathname === MCP_PATH) {
        const guard = opts.upgradeGuard;
        if (guard?.allowedHosts !== true) {
          const boundHost = guard?.boundHost ?? 'localhost';
          const extra = Array.isArray(guard?.allowedHosts) ? guard.allowedHosts : [];
          if (!isAllowedLoopbackRequest(req, boundHost, extra)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden: invalid host or origin' }));
            return true;
          }
        }
        try {
          const sessionId = (req.headers['mcp-session-id'] ?? req.headers['Mcp-Session-Id']) as string | undefined;
          let session: Session;
          let created = false;
          if (sessionId) {
            const existing = sessions.get(sessionId);
            if (!existing) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'pyric bridge: MCP session not found' }));
              return true;
            }
            session = existing;
            bumpIdle(session);
          } else {
            session = await newSession();
            created = true;
          }

          if (req.method === 'DELETE' && sessionId) {
            await closeSession(session);
            res.writeHead(204).end();
            return true;
          }
          // The transport reads the raw request stream itself. Do NOT pre-parse
          // the body (the old `collectBody` path); a double read hangs the
          // initialize POST.
          try {
            await session.transport.handleRequest(req, res);
          } finally {
            // A request without a session id is allowed to allocate only while
            // it attempts initialization. Invalid/non-initialize traffic must
            // not strand an uninitialized transport against the session cap.
            if (created && session.sessionId === null) await closeSession(session);
          }
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
    attachHost({
      servers,
      lifecycleServer = servers[0],
      projectDir,
      origin,
      collision,
      closeOnServerClose = true,
    }) {
      if (closed) throw new Error('pyric bridge: cannot attach a closed mount');
      const wss = new WebSocketServer({ noServer: true });
      const guard = opts.upgradeGuard;
      const pointer = join(projectDir, '.pyric', 'serve.json');
      const upgradedSockets = new Set<Duplex>();
      const collisionAbort = new AbortController();
      let collisionProbe: Promise<void> | null = null;
      let attachmentClosed = false;
      let attachmentClosePromise: Promise<void> | null = null;

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
        upgradedSockets.add(socket);
        socket.once('close', () => upgradedSockets.delete(socket));
        wss.handleUpgrade(req, socket as never, head, (ws: WebSocket) => {
          attachPeer(bridge, ws);
        });
      };

      const publish = (): void => {
        const currentOrigin = origin();
        if (!currentOrigin?.port || attachmentClosed) return;
        try {
          mkdirSync(dirname(pointer), { recursive: true });
          writeFileSync(pointer, JSON.stringify({
            url: `http://${currentOrigin.host}:${currentOrigin.port}`,
            mcpUrl: mount.mcpUrl(currentOrigin),
            port: currentOrigin.port,
            pid: process.pid,
            instanceId: bridge.instanceId,
            project,
          }, null, 2) + '\n');
        } catch {
          // Discovery falls back to a port scan.
        }
      };

      const probeCollision = async (): Promise<void> => {
        const currentOrigin = origin();
        if (!collision || !currentOrigin?.port || attachmentClosed) return;
        for (const probe of [`http://127.0.0.1:${currentOrigin.port}`, `http://[::1]:${currentOrigin.port}`]) {
          try {
            const response = await (collision.fetchImpl ?? fetch)(`${probe}${HEALTH_PATH}`, {
              signal: AbortSignal.any([collisionAbort.signal, AbortSignal.timeout(1000)]),
            });
            if (attachmentClosed) return;
            if (response.status !== 200) continue;
            const body = (await response.json()) as { mode?: string; instanceId?: string };
            if (attachmentClosed) return;
            if (body.mode === 'sandbox' && body.instanceId && body.instanceId !== bridge.instanceId) {
              collision.warn(
                `\n⚠  pyric: another sandbox already serves port ${currentOrigin.port} on a different loopback ` +
                  `family (${probe}). Two dev servers are colliding across IPv4/IPv6 — your MCP ` +
                  `agent and browser can land on DIFFERENT sandboxes (writes seem to vanish). ` +
                  `Stop the other server, or give this app a unique \`server.port\` so the two ` +
                  `don't share one (pinning server.host to a family the squatter holds would ` +
                  `just EADDRINUSE).\n`,
                { timestamp: true },
              );
              return;
            }
          } catch {
            if (attachmentClosed) return;
            // The other loopback family is silent.
          }
        }
      };

      const announce = (): void => {
        publish();
        if (!collisionProbe) {
          const current = probeCollision();
          collisionProbe = current;
          void current.finally(() => {
            if (collisionProbe === current) collisionProbe = null;
          });
        }
      };
      const attachment: BridgeHostAttachment = {
        close(): Promise<void> {
          if (attachmentClosePromise) return attachmentClosePromise;
          attachmentClosePromise = (async () => {
            attachmentClosed = true;
            collisionAbort.abort();
            for (const server of servers) server.removeListener('upgrade', onUpgrade as never);
            lifecycleServer?.removeListener('listening', announce);
            lifecycleServer?.removeListener('close', onClose);
            await collisionProbe;
            removeOwnedPointer(pointer);
            for (const client of wss.clients) client.terminate();
            for (const socket of upgradedSockets) socket.destroy();
            upgradedSockets.clear();
            await new Promise<void>((resolve) => {
              let settled = false;
              const done = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(fallback);
                resolve();
              };
              // `noServer` owns no listener socket. Once upgrades are detached
              // and clients are terminated, a missing ws `close` callback must
              // not deadlock the host's ordered shutdown.
              const fallback = setTimeout(done, 500);
              fallback.unref();
              try {
                wss.close(done);
              } catch {
                done();
              }
            });
            attachments.delete(attachment);
          })();
          return attachmentClosePromise;
        },
      };
      const onClose = (): void => { void attachment.close(); };

      for (const server of servers) server.on('upgrade', onUpgrade as never);
      if (closeOnServerClose) lifecycleServer?.once('close', onClose);
      if ((lifecycleServer as unknown as { listening?: boolean } | undefined)?.listening) announce();
      else lifecycleServer?.once('listening', announce);
      attachments.add(attachment);
      return attachment;
    },
    sandboxConnected: () => bridge.health().sandboxConnected === true,
    wsUrl: ({ host, port }) => `ws://${host}:${port}${WS_PATH}`,
    mcpUrl: ({ host, port }) => `http://${host}:${port}${MCP_PATH}`,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        await Promise.all([...attachments].map((attachment) => attachment.close()));
        await Promise.all([...new Set([...sessions.values(), ...pendingSessions])].map(closeSession));
      })();
      return closePromise;
    },
  };
  return mount;
}
