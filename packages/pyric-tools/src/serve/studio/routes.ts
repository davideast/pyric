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

export interface StudioRouteOptions {
  /** The single-project file tree served at `/__pyric/workspace`. */
  workspace?: WorkspaceStore;
  /** The project list served at `/__pyric/projects`. */
  projects?: ProjectStore;
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

function sendError(res: ServerResponse, e: unknown): void {
  const status =
    e instanceof WorkspacePathError || e instanceof ProjectIdError ? 400 : 500;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(e instanceof Error ? e.message : String(e));
}

async function handleWorkspace(
  ws: WorkspaceStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  // ── SSE watch ────────────────────────────────────────────────────────
  if (url.pathname === '/__pyric/workspace/watch') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsub = ws.watch((change: WorkspaceChange) => {
      res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    });
    req.on('close', () => unsub());
    return;
  }

  // ── list ─────────────────────────────────────────────────────────────
  if (url.pathname === '/__pyric/workspace/list') {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end('method not allowed');
      return;
    }
    const dir = url.searchParams.get('dir') ?? undefined;
    sendJson(res, 200, await ws.list(dir));
    return;
  }

  // ── read / write / remove a single path ──────────────────────────────
  const path = url.searchParams.get('path');
  if (path === null) {
    res.writeHead(400).end('missing ?path');
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
    const body = await readBody(req);
    await ws.write(path, body);
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'DELETE') {
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

  if (id === '') {
    if (req.method === 'GET') {
      sendJson(res, 200, await store.list());
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson<{ title?: string }>(req);
      const meta = await store.create({ title: body?.title });
      sendJson(res, 200, meta);
      return;
    }
    res.writeHead(405, { allow: 'GET, POST' }).end('method not allowed');
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
    const body = await readJson<Record<string, unknown>>(req);
    // Only forward known, mutable ProjectMeta fields — never `id`.
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
  res
    .writeHead(405, { allow: 'GET, PATCH, DELETE' })
    .end('method not allowed');
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
      if (opts.workspace && url.pathname.startsWith('/__pyric/workspace')) {
        await handleWorkspace(opts.workspace, req, res, url);
        return true;
      }
      if (opts.projects && url.pathname.startsWith('/__pyric/projects')) {
        await handleProjects(opts.projects, req, res, url);
        return true;
      }
    } catch (e) {
      if (!res.headersSent) sendError(res, e);
      else res.end();
      return true;
    }
    return false;
  };
}
