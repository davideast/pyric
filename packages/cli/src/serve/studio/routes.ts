/**
 * Studio storage routes — the HTTP surface for `@pyric/studio` in `local` mode.
 * Mounted inside the `/__pyric/` namespace; the browser-side `httpWorkspace`
 * / `httpProjectStore` clients in `packages/studio/src/clients` speak exactly
 * these endpoints.
 *
 *   WORKSPACE (a single project's file tree)
 *     GET    /__pyric/workspace?path=src/app.tsx  → file body (200) | 404
 *     PUT    /__pyric/workspace?path=...          → write body (204)
 *     DELETE /__pyric/workspace?path=...          → remove (204)
 *     GET    /__pyric/workspace/list?dir=src      → WorkspaceEntry[] (200)
 *     GET    /__pyric/workspace/watch             → SSE stream of WorkspaceChange
 *
 *   PROJECTS (sessions/projects)
 *     GET    /__pyric/projects                     → ProjectMeta[] (200)
 *     POST   /__pyric/projects   {title?}          → ProjectMeta (created) (200)
 *     GET    /__pyric/projects/<id>                → ProjectMeta (200) | 404
 *     PATCH  /__pyric/projects/<id>  {title?,...}  → (204)
 *     DELETE /__pyric/projects/<id>                → (204)
 *
 * The `watch` stream reuses the SSE pattern already used for `/__pyric/events`
 * (the hot-reload hub): one `text/event-stream` response per subscriber, frames
 * are `event: change\ndata: <json>\n\n`, and the subscription is torn down on
 * `req.close`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { WorkspacePathError } from './disk-workspace.js';
import { ProjectIdError } from './disk-project-store.js';
import type {
  ProjectMeta,
  ProjectStore,
  WorkspaceChange,
  WorkspaceStore,
} from './store-types.js';
import { isAllowedHost, isAllowedOrigin, getHeader } from '../server.js';
import type { WriterLock } from '../writer-lock.js';

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
}

/** Collect the raw request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** Collect + parse the request body as JSON (null on empty/invalid). */
async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const raw = await readBody(req);
  const isRawEmpty = raw.trim() === '';
  if (isRawEmpty) return null;
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

function sendError(res: ServerResponse, e: unknown): void {
  const isPathError = e instanceof WorkspacePathError;
  const isProjectIdError = e instanceof ProjectIdError;
  const isKnownError = isPathError || isProjectIdError;
  const status = isKnownError ? 400 : 500;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  const isErrorInstance = e instanceof Error;
  res.end(isErrorInstance ? e.message : String(e));
}

async function handleWorkspace(
  ws: WorkspaceStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  // ── SSE watch ────────────────────────────────────────────────────────
  const isWatchRoute = url.pathname === '/__pyric/workspace/watch';
  if (isWatchRoute) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsub = ws.watch((change: WorkspaceChange) => {
      // The write can race the socket teardown (page reload while a
      // workspace change fires) — a throw here would escape into the
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

  // ── list ─────────────────────────────────────────────────────────────
  const isListRoute = url.pathname === '/__pyric/workspace/list';
  if (isListRoute) {
    const isGetMethod = req.method === 'GET';
    if (!isGetMethod) {
      res.writeHead(405, { allow: 'GET' }).end('method not allowed');
      return;
    }
    const dir = url.searchParams.get('dir') ?? undefined;
    sendJson(res, 200, await ws.list(dir));
    return;
  }

  // ── read / write / remove a single path ──────────────────────────────
  const path = url.searchParams.get('path');
  const isPathMissing = path === null;
  if (isPathMissing) {
    res.writeHead(400).end('missing ?path');
    return;
  }
  const isGetRequest = req.method === 'GET';
  if (isGetRequest) {
    const content = await ws.read(path);
    const isContentMissing = content === null;
    if (isContentMissing) {
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
  const isPutRequest = req.method === 'PUT';
  if (isPutRequest) {
    const body = await readBody(req);
    await ws.write(path, body);
    res.writeHead(204).end();
    return;
  }
  const isDeleteRequest = req.method === 'DELETE';
  if (isDeleteRequest) {
    await ws.remove(path);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(405, { allow: 'GET, PUT, DELETE' }).end('method not allowed');
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

  const isRootProjectsRoute = id === '';
  if (isRootProjectsRoute) {
    const isGetMethod = req.method === 'GET';
    if (isGetMethod) {
      sendJson(res, 200, await store.list());
      return;
    }
    const isPostMethod = req.method === 'POST';
    if (isPostMethod) {
      const body = await readJson<{ title?: string }>(req);
      const meta = await store.create({ title: body?.title });
      sendJson(res, 200, meta);
      return;
    }
    res.writeHead(405, { allow: 'GET, POST' }).end('method not allowed');
    return;
  }

  // single project by id
  const isGetMethod = req.method === 'GET';
  if (isGetMethod) {
    try {
      const handle = await store.open(decodeURIComponent(id));
      sendJson(res, 200, handle.meta);
    } catch {
      res.writeHead(404).end('not found');
    }
    return;
  }
  const isPatchMethod = req.method === 'PATCH';
  if (isPatchMethod) {
    const body = await readJson<Record<string, unknown>>(req);
    // Only forward known, mutable ProjectMeta fields — never `id`.
    const patch: Partial<Omit<ProjectMeta, 'id'>> = {};
    const hasTitle = Boolean(body) && typeof body!.title === 'string';
    if (hasTitle) patch.title = body!.title as string;
    const hasCreatedAt = Boolean(body) && typeof body!.createdAt === 'number';
    if (hasCreatedAt) patch.createdAt = body!.createdAt as number;
    const hasUpdatedAt = Boolean(body) && typeof body!.updatedAt === 'number';
    if (hasUpdatedAt) patch.updatedAt = body!.updatedAt as number;
    await store.update(decodeURIComponent(id), patch);
    res.writeHead(204).end();
    return;
  }
  const isDeleteMethod = req.method === 'DELETE';
  if (isDeleteMethod) {
    await store.remove(decodeURIComponent(id));
    res.writeHead(204).end();
    return;
  }
  res
    .writeHead(405, { allow: 'GET, PATCH, DELETE' })
    .end('method not allowed');
}

function isWorkspaceMutation(method?: string): boolean {
  const isPutMethod = method === 'PUT';
  const isPostMethod = method === 'POST';
  const isPatchMethod = method === 'PATCH';
  const isDeleteMethod = method === 'DELETE';
  return isPutMethod || isPostMethod || isPatchMethod || isDeleteMethod;
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
      const hasWorkspaceStore = Boolean(opts.workspace);
      const isWorkspacePath = url.pathname.startsWith('/__pyric/workspace');
      const isWorkspaceRoute = hasWorkspaceStore && isWorkspacePath;

      const hasProjectsStore = Boolean(opts.projects);
      const isProjectsPath = url.pathname.startsWith('/__pyric/projects');
      const isProjectsRoute = hasProjectsStore && isProjectsPath;

      const isStudioRoute = isWorkspaceRoute || isProjectsRoute;

      if (isStudioRoute) {
        const hostHeader = getHeader(req, 'host');
        const originHeader = getHeader(req, 'origin');

        // 1. Host and Origin guard (Requirement 1)
        const isHostAllowed = isAllowedHost(hostHeader, opts.boundHost ?? 'localhost', opts.allowedHosts);
        if (!isHostAllowed) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: host not allowed');
          return true;
        }

        const hasOriginHeader = Boolean(originHeader);
        const isOriginAllowed = isAllowedOrigin(originHeader, opts.boundHost ?? 'localhost', opts.allowedHosts);
        const isOriginInvalid = hasOriginHeader && !isOriginAllowed;
        if (isOriginInvalid) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: origin mismatch');
          return true;
        }

        // 2. Per-boot session capability token guard (Requirement 2)
        const hasSessionTokenConfig = Boolean(opts.sessionToken);
        if (hasSessionTokenConfig) {
          const reqToken =
            getHeader(req, 'x-pyric-session-token') ??
            url.searchParams.get('token');
          const hasReqToken = Boolean(reqToken);
          const isTokenMatching = reqToken === opts.sessionToken;
          const isTokenValid = hasReqToken && isTokenMatching;
          if (!isTokenValid) {
            res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
            return true;
          }
        }

        // 3. Single-writer lock guard for mutation endpoints (Requirement 4)
        const hasWriterLockConfig = Boolean(opts.writerLock);
        const isMutation = isWorkspaceMutation(req.method);
        const shouldEnforceWriterLock = hasWriterLockConfig && isMutation;
        if (shouldEnforceWriterLock) {
          const writerId = getHeader(req, 'x-pyric-writer');
          const hasWriterId = Boolean(writerId);
          if (!hasWriterId) {
            res.writeHead(423, { 'content-type': 'text/plain' }).end('Locked: missing active writer lock header');
            return true;
          }
          const isWriterLockClaimed = opts.writerLock!.claim(writerId!, Date.now());
          if (!isWriterLockClaimed) {
            res.writeHead(423, { 'content-type': 'text/plain' }).end('Locked: another tab holds the writer lock');
            return true;
          }
        }

        if (isWorkspaceRoute) {
          await handleWorkspace(opts.workspace!, req, res, url);
          return true;
        }
        if (isProjectsRoute) {
          await handleProjects(opts.projects!, req, res, url);
          return true;
        }
      }
    } catch (e) {
      const areHeadersSent = res.headersSent;
      if (!areHeadersSent) sendError(res, e);
      else res.end();
      return true;
    }
    return false;
  };
}

