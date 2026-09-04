/**
 * Track T3 — disk-backed Studio storage + serve routes.
 *
 * Round-trips `diskWorkspace` / `diskProjectStore` in a temp dir (read/write/
 * list/remove, path-traversal refusal, project CRUD) and smoke-tests the route
 * handler by importing it directly and driving it with mock req/res (no live
 * server).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  diskWorkspace,
  WorkspacePathError,
} from './disk-workspace.js';
import {
  diskProjectStore,
  slugifyProjectId,
  ProjectIdError,
} from './disk-project-store.js';
import { createStudioRoutes } from './routes.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pyric-studio-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('diskWorkspace', () => {
  it('write → read round-trips, creating parent dirs', async () => {
    const ws = diskWorkspace(dir);
    await ws.write('src/app.tsx', 'export const x = 1;');
    expect(await ws.read('src/app.tsx')).toBe('export const x = 1;');
    expect(existsSync(join(dir, 'src', 'app.tsx'))).toBe(true);
  });

  it('read of a missing file is null', async () => {
    const ws = diskWorkspace(dir);
    expect(await ws.read('nope.txt')).toBeNull();
  });

  it('list returns sorted file/dir entries (project-relative POSIX)', async () => {
    const ws = diskWorkspace(dir);
    await ws.write('b.txt', '2');
    await ws.write('a.txt', '1');
    await ws.write('sub/c.txt', '3');
    const root = await ws.list();
    expect(root).toEqual([
      { path: 'a.txt', kind: 'file' },
      { path: 'b.txt', kind: 'file' },
      { path: 'sub', kind: 'dir' },
    ]);
    const sub = await ws.list('sub');
    expect(sub).toEqual([{ path: 'sub/c.txt', kind: 'file' }]);
  });

  it('remove deletes a file and is idempotent', async () => {
    const ws = diskWorkspace(dir);
    await ws.write('gone.txt', 'x');
    await ws.remove('gone.txt');
    expect(await ws.read('gone.txt')).toBeNull();
    await ws.remove('gone.txt'); // no throw
  });

  it('refuses path traversal outside the root', async () => {
    const ws = diskWorkspace(dir);
    await expect(ws.read('../escape.txt')).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(ws.write('../../x', 'y')).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it('refuses removing the root itself', async () => {
    const ws = diskWorkspace(dir);
    await expect(ws.remove('')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('watch fires on a write and unsubscribes cleanly', async () => {
    const ws = diskWorkspace(dir);
    const seen: string[] = [];
    const unsub = ws.watch((c) => seen.push(`${c.type}:${c.path}`));
    // Let the recursive watcher attach before mutating.
    await new Promise((r) => setTimeout(r, 50));
    await ws.write('watched.txt', 'hi');
    // fs.watch is async; give it a tick.
    await new Promise((r) => setTimeout(r, 250));
    unsub();
    // At least one change for the file should have surfaced (event coalescing
    // varies by platform, so assert membership not exact count).
    expect(seen.some((s) => s.includes('watched.txt'))).toBe(true);
  });
});

describe('diskProjectStore', () => {
  it('create → list → open → update → remove round-trips', async () => {
    const store = diskProjectStore(dir);
    expect(await store.list()).toEqual([]);

    const meta = await store.create({ title: 'My App' });
    expect(meta.id).toBe('my-app');
    expect(meta.title).toBe('My App');
    expect(meta.createdAt).toBeGreaterThan(0);

    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual(['my-app']);

    const handle = await store.open('my-app');
    expect(handle.meta.title).toBe('My App');
    await handle.workspace.write('index.html', '<h1>hi</h1>');
    expect(await handle.workspace.read('index.html')).toBe('<h1>hi</h1>');

    await store.update('my-app', { title: 'Renamed' });
    expect((await store.open('my-app')).meta.title).toBe('Renamed');

    await store.remove('my-app');
    expect(await store.list()).toEqual([]);
  });

  it('disambiguates ids when titles collide', async () => {
    const store = diskProjectStore(dir);
    const a = await store.create({ title: 'Dup' });
    const b = await store.create({ title: 'Dup' });
    expect(a.id).toBe('dup');
    expect(b.id).toBe('dup-2');
  });

  it('open of a missing project rejects', async () => {
    const store = diskProjectStore(dir);
    await expect(store.open('ghost')).rejects.toThrow(/not found/);
  });

  it('rejects unsafe ids', async () => {
    const store = diskProjectStore(dir);
    await expect(store.open('../evil')).rejects.toBeInstanceOf(ProjectIdError);
  });

  it('slugifyProjectId is filesystem-safe', () => {
    expect(slugifyProjectId('Hello, World!')).toBe('hello-world');
    expect(slugifyProjectId('  spaced  out  ')).toBe('spaced-out');
  });
});

// ── Route smoke tests (handler imported directly) ─────────────────────────

interface MockRes {
  res: ServerResponse;
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  done: Promise<void>;
}

const testSessionToken = 'test-studio-storage-token';

function mockReq(method: string): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as unknown as { method: string; headers: Record<string, string> }).method = method;
  (req as unknown as { method: string; headers: Record<string, string> }).headers = {
    host: 'localhost',
    'x-pyric-session-token': testSessionToken,
  };
  return req;
}

function mockRes(): MockRes {
  const state: MockRes = {
    res: undefined as unknown as ServerResponse,
    statusCode: 0,
    body: '',
    headers: {},
    done: undefined as unknown as Promise<void>,
  };
  let resolveDone!: () => void;
  state.done = new Promise<void>((r) => (resolveDone = r));
  const res = {
    headersSent: false,
    writeHead(code: number, headers?: Record<string, unknown>) {
      state.statusCode = code;
      if (headers) state.headers = headers;
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    write(chunk: string) {
      state.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) state.body += chunk;
      resolveDone();
      return res;
    },
  } as unknown as ServerResponse;
  state.res = res;
  return state;
}

describe('createStudioRoutes', () => {
  it('GET /__pyric/projects lists, POST creates', async () => {
    const routes = createStudioRoutes({
      projects: diskProjectStore(dir),
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });

    const listRes = mockRes();
    const handled = await routes(
      mockReq('GET'),
      listRes.res,
      new URL('http://localhost/__pyric/projects'),
    );
    await listRes.done;
    expect(handled).toBe(true);
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body)).toEqual([]);

    const postReq = mockReq('POST');
    const postRes = mockRes();
    const p = routes(postReq, postRes.res, new URL('http://localhost/__pyric/projects'));
    postReq.emit('data', JSON.stringify({ title: 'Via Route' }));
    postReq.emit('end');
    await p;
    await postRes.done;
    expect(postRes.statusCode).toBe(200);
    expect(JSON.parse(postRes.body).title).toBe('Via Route');
  });

  it('PUT then GET /__pyric/workspace round-trips a file', async () => {
    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });

    const putReq = mockReq('PUT');
    const putRes = mockRes();
    const p = routes(
      putReq,
      putRes.res,
      new URL('http://localhost/__pyric/workspace?path=note.txt'),
    );
    putReq.emit('data', 'hello');
    putReq.emit('end');
    await p;
    await putRes.done;
    expect(putRes.statusCode).toBe(204);
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('hello');

    const getRes = mockRes();
    await routes(
      mockReq('GET'),
      getRes.res,
      new URL('http://localhost/__pyric/workspace?path=note.txt'),
    );
    await getRes.done;
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toBe('hello');
  });

  it('GET /__pyric/workspace/list returns entries', async () => {
    const ws = diskWorkspace(dir);
    await ws.write('a.txt', '1');
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });
    const res = mockRes();
    await routes(
      mockReq('GET'),
      res.res,
      new URL('http://localhost/__pyric/workspace/list'),
    );
    await res.done;
    expect(JSON.parse(res.body)).toEqual([{ path: 'a.txt', kind: 'file' }]);
  });

  it('returns 400 on path traversal', async () => {
    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });
    const res = mockRes();
    await routes(
      mockReq('GET'),
      res.res,
      new URL('http://localhost/__pyric/workspace?path=../escape'),
    );
    await res.done;
    expect(res.statusCode).toBe(400);
  });

  it('returns false for unrelated /__pyric/* paths', async () => {
    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });
    const handled = await routes(
      mockReq('GET'),
      mockRes().res,
      new URL('http://localhost/__pyric/init.json'),
    );
    expect(handled).toBe(false);
  });
});
