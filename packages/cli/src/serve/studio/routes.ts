/**
 * Studio storage routes -- the HTTP surface for `@pyric/studio` in `local` mode.
 * Mounted inside the `/__pyric/` namespace; the browser-side `httpWorkspace`
 * / `httpProjectStore` clients in `packages/studio/src/clients` speak exactly
 * these endpoints.
 *
 *   WORKSPACE (a single project's file tree)
 *     GET    /__pyric/workspace?path=src/app.tsx  -> file body (200) | 404
 *     PUT    /__pyric/workspace?path=...          -> write body (204)
 *     DELETE /__pyric/workspace?path=...          -> remove (204)
 *     GET    /__pyric/workspace/list?dir=src      -> WorkspaceEntry[] (200)
 *     GET    /__pyric/workspace/watch             -> SSE stream of WorkspaceChange
 *
 *   PROJECTS (sessions/projects)
 *     GET    /__pyric/projects                     -> ProjectMeta[] (200)
 *     POST   /__pyric/projects   {title?}          -> ProjectMeta (created) (200)
 *     GET    /__pyric/projects/<id>                -> ProjectMeta (200) | 404
 *     PATCH  /__pyric/projects/<id>  {title?,...}  -> (204)
 *     DELETE /__pyric/projects/<id>                -> (204)
 *
 * The `watch` stream reuses the SSE pattern already used for `/__pyric/events`
 * (the hot-reload hub): one `text/event-stream` response per subscriber, frames
 * are `event: change\ndata: <json>\n\n`, and the subscription is torn down on
 * `req.close`.
 */
import { IncomingMessage, type ServerResponse } from 'node:http';

import { isBodyTooLarge } from '../../bridge/server/peer.js';
import { readBoundedUtf8Body, sendPayloadTooLarge, sendTextRefusal } from '../bounded-body.js';
import { WorkspaceDeniedPathError, WorkspacePathError } from './disk-workspace.js';
import { ProjectIdError } from './disk-project-store.js';
import type {
  ProjectMeta,
  ProjectStore,
  WorkspaceChange,
  WorkspaceStore,
} from './store-types.js';
import {
  createGuardPolicy,
  evaluateGuard,
  type GuardDecision,
  type GuardRequest,
  type RemoteAccessOptions,
} from '../guard-policy.js';
import { getHeader } from '../loopback-guard.js';
import { REMOTE_PEER_HEADER } from '../peer.js';
import type { AppPorts } from '../app-ports.js';
import type { WriterLock } from '../writer-lock.js';

/** Maximum UTF-8 byte length accepted by `PUT /__pyric/workspace`. */
export const STUDIO_WORKSPACE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/** Maximum UTF-8 byte length accepted by `POST` / `PATCH /__pyric/projects`. */
export const STUDIO_PROJECT_BODY_LIMIT_BYTES = 64 * 1024;

export interface StudioRouteOptions {
  /** The single-project file tree served at `/__pyric/workspace`. */
  workspace?: WorkspaceStore;
  /** The project list served at `/__pyric/projects`. */
  projects?: ProjectStore;
  /** Per-boot session capability token required on workspace & project endpoints. */
  sessionToken?: string;
  /** Single-writer lock validator for file mutation & deletion endpoints. */
  writerLock?: WriterLock;
  /** Bound host for DNS rebinding guard. */
  boundHost?: string;
  /** Extra hostnames allowed for DNS rebinding/origin guard. */
  allowedHosts?: string[];
  /** Accepted app ports under proxied dev servers. */
  appPorts?: AppPorts;
  /** Optional remote-access policy for peer admission and trusted reverse-proxy headers. */
  remoteAccess?: RemoteAccessOptions;
}

/** Collect + parse the request body as JSON (null on empty/invalid). */
async function readJson<T>(req: IncomingMessage, limitBytes: number): Promise<T | null> {
  const raw = await readBoundedUtf8Body(req, limitBytes);
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function errorStatus(e: unknown): number {
  if (e instanceof WorkspaceDeniedPathError) return 403;
  const isBadPath = e instanceof WorkspacePathError || e instanceof ProjectIdError;
  return isBadPath ? 400 : 500;
}

function sendError(res: ServerResponse, e: unknown): void {
  const status = errorStatus(e);
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(e instanceof Error ? e.message : String(e));
}

function mergeStudioAllowedHosts(opts: StudioRouteOptions): string[] {
  const merged: string[] = [];
  for (const host of opts.allowedHosts ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  for (const host of opts.remoteAccess?.allowedHosts ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  return merged;
}

function studioExtraAppPorts(req: IncomingMessage, opts: StudioRouteOptions): readonly number[] | undefined {
  const learned = opts.appPorts?.forRequest(req);
  if (learned !== undefined && learned.length > 0) return learned;
  const localPort = req.socket?.localPort;
  if (localPort !== undefined && localPort > 0) return [localPort];
  return undefined;
}

/**
 * Adapt a request for `evaluateGuard`. Real `IncomingMessage` requests (and any
 * mock carrying socket peer state, `destroyed`, `socket: null`, or
 * `x-pyric-remote-peer`) pass through unmodified so missing/destroyed sockets
 * always fail closed. Only synthetic in-process test stubs without socket peer
 * metadata default `remoteAddress` to loopback.
 */
function toStudioGuardRequest(req: GuardRequest): GuardRequest {
  if (req instanceof IncomingMessage) return req;
  if (req.socket === null) return req;
  if (req.socket?.remoteAddress !== undefined) return req;
  const socketLike = req.socket as { destroyed?: unknown; localPort?: number; encrypted?: boolean } | undefined;
  if (typeof socketLike?.destroyed === 'boolean') return req;
  if (getHeader(req, REMOTE_PEER_HEADER) !== undefined) return req;
  return {
    method: req.method,
    headers: req.headers,
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: socketLike?.localPort,
      encrypted: socketLike?.encrypted,
    },
  };
}

function formatStudioGuardRejection(decision: Extract<GuardDecision, { ok: false }>): string {
  switch (decision.reason) {
    case 'remote-peer':
    case 'live-remote-peer-refused':
      return `Forbidden: this route answers admitted peers only (${decision.message})`;
    case 'disallowed-host':
      return `Forbidden: host not allowed (${decision.message})`;
    case 'origin-mismatch':
    case 'scheme-mismatch':
      return `Forbidden: origin mismatch (${decision.message})`;
    case 'cross-site-fetch':
      return `Forbidden: cross-site request rejected (${decision.message})`;
    case 'missing-session-token':
    case 'invalid-session-token':
      return `Unauthorized: invalid session capability token (${decision.message})`;
  }
}

async function handleWorkspace(
  ws: WorkspaceStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  // -- SSE watch --------------------------------------------------------
  if (url.pathname === '/__pyric/workspace/watch') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsub = ws.watch((change: WorkspaceChange) => {
      // The write can race the socket teardown (page reload while a
      // workspace change fires) -- a throw here would escape into the
      // fs.watch callback and kill the serve process.
      try {
        res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
      } catch {
        unsub();
      }
    });
    req.on('close', () => unsub());
    res.on('error', () => unsub());
    return;
  }

  // -- list -------------------------------------------------------------
  if (url.pathname === '/__pyric/workspace/list') {
    if (req.method !== 'GET') {
      sendTextRefusal(req, res, 405, { allow: 'GET' }, 'method not allowed');
      return;
    }
    const dir = url.searchParams.get('dir') ?? undefined;
    sendJson(res, 200, await ws.list(dir));
    return;
  }

  // -- branches ---------------------------------------------------------
  if (url.pathname === '/__pyric/workspace/branches') {
    if (req.method !== 'GET') {
      sendTextRefusal(req, res, 405, { allow: 'GET' }, 'method not allowed');
      return;
    }
    sendJson(res, 200, await ws.branches());
    return;
  }

  // -- read / write / remove a single path ------------------------------
  const path = url.searchParams.get('path');
  if (path === null) {
    sendTextRefusal(req, res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'missing ?path');
    return;
  }
  if (req.method === 'GET') {
    const content = await ws.read(path);
    if (content === null) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(content);
    return;
  }
  if (req.method === 'PUT') {
    const body = await readBoundedUtf8Body(req, STUDIO_WORKSPACE_BODY_LIMIT_BYTES);
    await ws.write(path, body);
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'DELETE') {
    await ws.remove(path);
    res.writeHead(204).end();
    return;
  }
  sendTextRefusal(req, res, 405, { allow: 'GET, PUT, DELETE' }, 'method not allowed');
}

async function handleProjects(
  store: ProjectStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  // /__pyric/projects/<id> | /__pyric/projects
  const rest = url.pathname.slice('/__pyric/projects'.length);
  const id = rest.replace(/^\//, '');

  if (id === '') {
    if (req.method === 'GET') {
      sendJson(res, 200, await store.list());
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson<{ title?: string }>(req, STUDIO_PROJECT_BODY_LIMIT_BYTES);
      const meta = await store.create({ title: body?.title });
      sendJson(res, 200, meta);
      return;
    }
    sendTextRefusal(req, res, 405, { allow: 'GET, POST' }, 'method not allowed');
    return;
  }

  // single project by id
  if (req.method === 'GET') {
    try {
      const handle = await store.open(decodeURIComponent(id));
      sendJson(res, 200, handle.meta);
    } catch {
      res.writeHead(404).end('not found');
    }
    return;
  }
  if (req.method === 'PATCH') {
    const body = await readJson<Record<string, unknown>>(req, STUDIO_PROJECT_BODY_LIMIT_BYTES);
    // Only forward known, mutable ProjectMeta fields -- never `id`.
    const patch: Partial<Omit<ProjectMeta, 'id'>> = {};
    if (body && typeof body.title === 'string') patch.title = body.title;
    if (body && typeof body.createdAt === 'number') patch.createdAt = body.createdAt;
    if (body && typeof body.updatedAt === 'number') patch.updatedAt = body.updatedAt;
    await store.update(decodeURIComponent(id), patch);
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'DELETE') {
    await store.remove(decodeURIComponent(id));
    res.writeHead(204).end();
    return;
  }
  sendTextRefusal(req, res, 405, { allow: 'GET, PATCH, DELETE' }, 'method not allowed');
}

function isWorkspaceMutation(method?: string): boolean {
  return method === 'PUT' || method === 'POST' || method === 'PATCH' || method === 'DELETE';
}

/**
 * Build a namespace fragment for the Studio storage routes. Returns a handler
 * shaped like the other `/__pyric/*` fragments: it resolves `true` when it
 * owned the request, `false` otherwise (so the caller can fall through).
 */
export function createStudioRoutes(opts: StudioRouteOptions) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    try {
      const workspace = opts.workspace;
      const projects = opts.projects;
      const isWorkspaceRoute = workspace !== undefined && url.pathname.startsWith('/__pyric/workspace');
      const isProjectsRoute = projects !== undefined && url.pathname.startsWith('/__pyric/projects');

      if (isWorkspaceRoute || isProjectsRoute) {
        const policy = createGuardPolicy({
          boundHost: opts.boundHost ?? 'localhost',
          allowedHosts: mergeStudioAllowedHosts(opts),
          allowPeers: opts.remoteAccess?.allowPeers,
          trustProxy: opts.remoteAccess?.trustProxy,
          browserUnlock: opts.remoteAccess?.browserUnlock,
          remoteAccessEnabled: opts.remoteAccess !== undefined,
          sessionToken: opts.sessionToken,
          requireSessionToken: true,
        });
        const decision = evaluateGuard(toStudioGuardRequest(req), policy, 'studio-api', {
          url,
          extraAppPorts: studioExtraAppPorts(req, opts),
        });
        if (!decision.ok) {
          sendTextRefusal(
            req,
            res,
            decision.status,
            { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
            formatStudioGuardRejection(decision),
          );
          return true;
        }

        // Single-writer lock guard for mutation endpoints
        if (opts.writerLock && isWorkspaceMutation(req.method)) {
          const writerId = getHeader(req, 'x-pyric-writer');
          if (!writerId) {
            sendTextRefusal(
              req,
              res,
              423,
              { 'content-type': 'text/plain; charset=utf-8' },
              'Locked: missing active writer lock header',
            );
            return true;
          }
          if (!opts.writerLock.claim(writerId, Date.now())) {
            sendTextRefusal(
              req,
              res,
              423,
              { 'content-type': 'text/plain; charset=utf-8' },
              'Locked: another tab holds the writer lock',
            );
            return true;
          }
        }

        if (isWorkspaceRoute) {
          await handleWorkspace(workspace, req, res, url);
          return true;
        }
        if (isProjectsRoute) {
          await handleProjects(projects, req, res, url);
          return true;
        }
      }
    } catch (e) {
      if (isBodyTooLarge(e)) {
        sendPayloadTooLarge(req, res, 'Payload Too Large');
        return true;
      }
      if (!res.headersSent) sendError(res, e);
      else res.end();
      return true;
    }
    return false;
  };
}
