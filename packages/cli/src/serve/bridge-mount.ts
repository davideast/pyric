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
 *   POST /__pyric/hosted/method  service CLI calls on the Node-owned sandbox
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
import { getBridgeToolSurface } from '../bridge/server/mcp-contract.js';
import { createAuditWriter } from '../bridge/server/audit.js';
import { attachPeer, collectBody, BODY_TOO_LARGE_CODE } from '../bridge/server/peer.js';
import { pyricVersion } from './standalone-assets.js';
import { isAllowedLoopbackRequest, isAllowedUpgrade } from './server.js';
import { MAX_BRIDGE_FRAME_BYTES, MAX_MOUNTED_MCP_SESSIONS, WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY } from '../bridge/protocol.js';
import type { InitPayload } from './init-payload.js';
import type { createHostedRuntime } from './hosted/runtime.js';
import { HOSTED_METHOD_PATH, HOSTED_METHOD_BODY_LIMIT, hostedMethodRequest } from './hosted/method-protocol.js';
import { MCP_PROJECT_HEADER, MCP_INSTANCE_HEADER, mcpProjectError } from './mcp-project.js';

const WS_PATH = '/__pyric/sandbox';
const MCP_PATH = '/__pyric/mcp';
const HEALTH_PATH = '/__pyric/health';
const BRIDGE_VERSION = pyricVersion();

export interface BridgeMountOptions {
  hosted?: boolean;
  project?: string;
  projectKey?: string;
  disableAuditLog?: boolean;
  /** WS-upgrade rebinding/origin guard config. The upgrade path bypasses the
   *  static server's request-time `isAllowedHost`, so the mount guards it here
   *  with the SAME allow rule (bound host + loopback + `--allowed-host`).
   *  `allowedHosts: true` = the caller (vite `server.allowedHosts: true`) opted
   *  into all hosts. Omit ⇒ loopback-only. */
  upgradeGuard?: { boundHost: string; allowedHosts?: string[] | true };
}

export interface BridgeMount {
  deployHostedRules(service: 'firestore' | 'database', source: string): void;
  startHostedSandbox(payload: InitPayload, baseUrl: string): Promise<void>;
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
  let hostedRuntime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let hostedStartup: Promise<void> | undefined;
  let disconnectHosted: (() => void) | undefined;
  let captureProjectDir = process.cwd();
  const project = opts.project ?? 'sandbox';
  const disablesAuditLog = Boolean(opts.disableAuditLog);
  const auditWriter = disablesAuditLog ? null : createAuditWriter(project);
  const recordsAudit = auditWriter !== null;

  const bridge = createBridge({
    project,
    projectKey: opts.projectKey,
    version: BRIDGE_VERSION,
    onToolEvent: recordsAudit ? (event: BridgeToolEvent) => auditWriter.write(event) : undefined,
  });

  // STATEFUL MCP: a per-session transport+server map, mirroring the standalone
  // bridge (`bridge/server/standalone.ts`). Each Streamable-HTTP client gets an
  // `Mcp-Session-Id` on initialize and resumes the SAME session on every later
  // request. The old per-request, `sessionIdGenerator: undefined` build returned
  // no session id, so clients (Claude Code, Cursor) dropped and 404'd on every
  // reconnect/dev-server restart. The long-lived `bridge` (peer + dispatch +
  // audit) is shared; each session owns its transport+server.
  const SESSION_IDLE_MS = 10 * 60_000;
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
    const idle = s.idle;
    const hasIdleTimer = idle !== null;
    if (hasIdleTimer) clearTimeout(idle);
    s.idle = setTimeout(() => {
      const sessionId = s.sessionId;
      const isRegistered = !!sessionId;
      if (isRegistered) sessions.delete(sessionId);
      pendingSessions.delete(s);
      void s.close();
    }, SESSION_IDLE_MS);
  };

  const newSession = async (): Promise<Session> => {
    if (closed) {
      throw Object.assign(new Error('pyric bridge: mount is closed'), { statusCode: 503 });
    }
    const isAtSessionCapacity = sessions.size + pendingSessions.size >= MAX_MOUNTED_MCP_SESSIONS;
    if (isAtSessionCapacity) {
      throw Object.assign(new Error(`pyric bridge: at session cap (${MAX_MOUNTED_MCP_SESSIONS})`), { statusCode: 503 });
    }
    const transport = new StreamableHTTPServerTransport({
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
    const session: Session = {
      transport,
      close: async () => {},
      idle: null,
      sessionId: null,
      closing: null,
    };
    session.transport.onclose = () => {
      const sessionId = session.sessionId;
      const isRegistered = !!sessionId;
      if (isRegistered) sessions.delete(sessionId);
      pendingSessions.delete(session);
    };
    const surface = getBridgeToolSurface({
      projectDir: captureProjectDir,
      consumers: bridge.consumers,
      callerIdentity: bridge.callerIdentity,
    });
    const server = buildMcpServer(bridge, {
      forwarded: surface.forwarded,
      inProcess: surface.inProcess,
    });
    session.close = () => {
      session.closing ??= (async () => {
        const idle = session.idle;
        const hasIdleTimer = idle !== null;
        if (hasIdleTimer) clearTimeout(idle);
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
    const sessionId = session.sessionId;
    const isRegistered = !!sessionId;
    if (isRegistered) sessions.delete(sessionId);
    pendingSessions.delete(session);
    await session.close();
  };

  const removeOwnedPointer = (pointer: string): void => {
    try {
      const isMissing = !existsSync(pointer);
      if (isMissing) return;
      const current = JSON.parse(readFileSync(pointer, 'utf8')) as { instanceId?: string };
      const ownsPointer = current.instanceId === bridge.instanceId;
      if (ownsPointer) rmSync(pointer);
    } catch {
      // Best effort. A malformed or concurrently replaced pointer is not ours.
    }
  };

  const mount: BridgeMount = {
    deployHostedRules(service, source) {
      const runtime = hostedRuntime;
      const isMissing = runtime === undefined;
      if (isMissing) throw new Error('The hosted sandbox is not running.');
      runtime.deployRules(service, source);
    },
    async startHostedSandbox(payload, baseUrl) {
      if (closed) throw new Error('pyric bridge: cannot start a closed mount');
      const alreadyStarted = hostedRuntime !== undefined || hostedStartup !== undefined;
      if (alreadyStarted) throw new Error('The Node sandbox is already running.');
      const starting = (async () => {
        const { createHostedRuntime } = await import('./hosted/runtime.js');
        hostedRuntime = await createHostedRuntime(payload, baseUrl, (message) => bridge.handleSandboxMessage(message), opts.projectKey ?? process.cwd());
        if (closed) return;
        disconnectHosted = bridge.registerSandboxPeer(
          hostedRuntime.receive,
          [...hostedRuntime.toolNames],
          hostedRuntime.instanceId,
          [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY],
        );
      })();
      hostedStartup = starting;
      try {
        await starting;
      } finally {
        hostedStartup = undefined;
      }
    },
    project,
    instanceId: bridge.instanceId,

    async handler(req, res, url) {
      const isHealthRequest = url.pathname === HEALTH_PATH;
      const isMcpRequest = url.pathname === MCP_PATH;
      const isHostedMethod = url.pathname === HOSTED_METHOD_PATH;
      const rejectsClosedRequest = closed && (isHealthRequest || isMcpRequest || isHostedMethod);
      if (rejectsClosedRequest) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'pyric bridge: mount is closed' }));
        return true;
      }
      if (isHealthRequest) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.health()));
        return true;
      }
      const requiresControlGuard = isMcpRequest || isHostedMethod;
      if (requiresControlGuard) {
        const guard = opts.upgradeGuard;
        const requiresRequestGuard = guard?.allowedHosts !== true;
        if (requiresRequestGuard) {
          const boundHost = guard?.boundHost ?? 'localhost';
          const allowedHosts = guard?.allowedHosts;
          const hasNamedHosts = Array.isArray(allowedHosts);
          const extra = hasNamedHosts ? allowedHosts : [];
          const isForbidden = !isAllowedLoopbackRequest(req, boundHost, extra);
          if (isForbidden) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden: invalid host or origin' }));
            return true;
          }
        }
      }
      if (isHostedMethod) {
        const runtime = hostedRuntime;
        const hasNoHostedRuntime = runtime === undefined;
        if (hasNoHostedRuntime) {
          res.writeHead(404).end();
          return true;
        }
        const rejectsHttpMethod = req.method !== 'POST';
        if (rejectsHttpMethod) {
          res.writeHead(405, { allow: 'POST' }).end();
          return true;
        }
        try {
          const call = hostedMethodRequest.parse(await collectBody(req, HOSTED_METHOD_BODY_LIMIT));
          const targetsAnotherInstance = call.instanceId !== bridge.instanceId;
          if (targetsAnotherInstance) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, summary: 'The discovered host instance has changed.' }));
            return true;
          }
          const result = await runtime.runMethod(call, req.socket);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        } catch (error) {
          const isError = error instanceof Error;
          const summary = isError ? error.message : String(error);
          const exceedsBodyLimit = isError && 'code' in error && error.code === BODY_TOO_LARGE_CODE;
          const status = exceedsBodyLimit ? 413 : 400;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, summary }));
        }
        return true;
      }
      if (isMcpRequest) {
        const selectedInstance = req.headers[MCP_INSTANCE_HEADER];
        const targetsAnotherInstance = selectedInstance !== undefined && selectedInstance !== bridge.instanceId;
        if (targetsAnotherInstance) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'The discovered host instance has changed.' }));
          return true;
        }
        const projectError = mcpProjectError(req.headers[MCP_PROJECT_HEADER], opts.projectKey ?? process.cwd());
        const targetsWrongProject = projectError !== null;
        if (targetsWrongProject) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: projectError }));
          return true;
        }
        try {
          const sessionId = (req.headers['mcp-session-id'] ?? req.headers['Mcp-Session-Id']) as string | undefined;
          let session: Session;
          let created = false;
          const resumesSession = !!sessionId;
          if (resumesSession) {
            const existing = sessions.get(sessionId);
            const isUnknownSession = existing === undefined;
            if (isUnknownSession) {
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

          const deletesSession = req.method === 'DELETE' && resumesSession;
          if (deletesSession) {
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
            const failedToInitialize = created && session.sessionId === null;
            if (failedToInitialize) await closeSession(session);
          }
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
          const canSendError = !res.headersSent;
          if (canSendError) {
            res.writeHead(statusCode, { 'content-type': 'application/json' });
            const isError = err instanceof Error;
            const message = isError ? err.message : String(err);
            res.end(JSON.stringify({ error: message }));
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
      captureProjectDir = projectDir;
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });
      const guard = opts.upgradeGuard;
      const pointer = join(projectDir, '.pyric', 'serve.json');
      const upgradedSockets = new Set<Duplex>();
      const collisionAbort = new AbortController();
      let collisionProbe: Promise<void> | null = null;
      let attachmentClosed = false;
      let attachmentClosePromise: Promise<void> | null = null;

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const isUnrelatedPath = (req.url ?? '') !== WS_PATH;
        if (isUnrelatedPath) return;
        // DNS-rebinding + cross-origin hijack guard. The static/dev server runs
        // isAllowedHost on the `request` event only; `upgrade` is a separate
        // listener that bypasses it, so re-check both Host and Origin here
        // before registering the peer (which last-wins the tool channel).
        // `allowedHosts: true` means the caller explicitly opted into all hosts.
        const requiresUpgradeGuard = guard !== undefined && guard.allowedHosts !== true;
        if (requiresUpgradeGuard) {
          const boundHost = guard.boundHost;
          const allowedHosts = guard.allowedHosts;
          const hasNamedHosts = Array.isArray(allowedHosts);
          const extra = hasNamedHosts ? allowedHosts : [];
          const isForbidden = !isAllowedUpgrade(req.headers, boundHost, extra);
          if (isForbidden) {
            socket.destroy();
            return;
          }
        }
        upgradedSockets.add(socket);
        socket.once('close', () => upgradedSockets.delete(socket));
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          const allowSandboxPeer = opts.hosted !== true;
          attachPeer(bridge, ws, allowSandboxPeer);
        });
      };

      const publish = (): void => {
        const currentOrigin = origin();
        const cannotPublish = !currentOrigin?.port || attachmentClosed;
        if (cannotPublish) return;
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
        const hasNoCollisionProbe = collision === undefined;
        if (hasNoCollisionProbe) return;
        const cannotProbe = !currentOrigin?.port || attachmentClosed;
        if (cannotProbe) return;
        for (const probe of [`http://127.0.0.1:${currentOrigin.port}`, `http://[::1]:${currentOrigin.port}`]) {
          try {
            const response = await (collision.fetchImpl ?? fetch)(`${probe}${HEALTH_PATH}`, {
              signal: AbortSignal.any([collisionAbort.signal, AbortSignal.timeout(1000)]),
            });
            if (attachmentClosed) return;
            const isUnavailable = response.status !== 200;
            if (isUnavailable) continue;
            const body = (await response.json()) as { mode?: string; instanceId?: string };
            if (attachmentClosed) return;
            const isSandbox = body.mode === 'sandbox';
            const isOtherInstance = !!body.instanceId && body.instanceId !== bridge.instanceId;
            const hasCollision = isSandbox && isOtherInstance;
            if (hasCollision) {
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
        const needsProbe = collisionProbe === null;
        if (needsProbe) {
          const current = probeCollision();
          collisionProbe = current;
          void current.finally(() => {
            const isCurrentProbe = collisionProbe === current;
            if (isCurrentProbe) collisionProbe = null;
          });
        }
      };
      const attachment: BridgeHostAttachment = {
        close(): Promise<void> {
          const closing = attachmentClosePromise;
          const isClosing = closing !== null;
          if (isClosing) return closing;
          attachmentClosePromise = (async () => {
            attachmentClosed = true;
            collisionAbort.abort();
            for (const server of servers) server.removeListener('upgrade', onUpgrade);
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

      for (const server of servers) server.on('upgrade', onUpgrade);
      if (closeOnServerClose) lifecycleServer?.once('close', onClose);
      const isListening = Boolean(lifecycleServer?.listening);
      if (isListening) announce();
      else lifecycleServer?.once('listening', announce);
      attachments.add(attachment);
      return attachment;
    },
    sandboxConnected: () => bridge.health().sandboxConnected === true,
    wsUrl: ({ host, port }) => `ws://${host}:${port}${WS_PATH}`,
    mcpUrl: ({ host, port }) => `http://${host}:${port}${MCP_PATH}`,
    close(): Promise<void> {
      const closing = closePromise;
      const isClosing = closing !== null;
      if (isClosing) return closing;
      closePromise = (async () => {
        closed = true;
        await Promise.all([...attachments].map((attachment) => attachment.close()));
        // Startup reports its own failure; shutdown still owns any runtime it creates.
        await hostedStartup?.catch(() => {});
        bridge.workerSessions.close();
        disconnectHosted?.();
        await hostedRuntime?.close();
        await Promise.all([...new Set([...sessions.values(), ...pendingSessions])].map(closeSession));
      })();
      return closePromise;
    },
  };
  return mount;
}
