/**
 * Track T3 -- disk-backed Studio storage + serve routes.
 *
 * Round-trips `diskWorkspace` / `diskProjectStore` in a temp dir (read/write/
 * list/remove, path-traversal refusal, project CRUD) and smoke-tests the route
 * handler by importing it directly and driving it with mock req/res (no live
 * server).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
import type { WorkspaceBranch } from './store-types.js';
import { captureFullState, discard, fork, initializeSandbox } from 'pyric/sandbox';
import { branchDirectory, saveBranch } from 'pyric/sandbox/branches/store';
import { getInternalEnv, setInlineStorageLimitForTesting } from 'pyric/sandbox/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

let dir: string;
let restoreLimit: (() => void) | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pyric-studio-'));
});
afterEach(() => {
  restoreLimit?.();
  restoreLimit = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('diskWorkspace', () => {
  it('write -> read round-trips, creating parent dirs', async () => {
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
  it('create -> list -> open -> update -> remove round-trips', async () => {
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

// -- Route smoke tests (handler imported directly) -------------------------

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
  let resolveDone: (() => void) | undefined;
  state.done = new Promise<void>((r) => {
    resolveDone = r;
  });
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
      resolveDone?.();
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

  it('GET /__pyric/workspace/branches returns the branches the store holds', async () => {
    const ws = diskWorkspace(dir);
    const sandbox = initializeSandbox();
    getAdminStorageSandbox(sandbox, { dbName: 'pyric-studio-draft-storage' });
    getInternalEnv(sandbox).seed({ rules: '', documents: { 'notes/n1': { body: 'live' } } });
    const branch = await fork(await captureFullState(sandbox));
    await saveBranch(dir, 'draft', branch, { base: 'live' });
    discard(branch);
    sandbox.dispose();

    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });
    const res = mockRes();
    await routes(mockReq('GET'), res.res, new URL('http://localhost/__pyric/workspace/branches'));
    await res.done;

    const listed = JSON.parse(res.body) as WorkspaceBranch[];
    expect(listed).toHaveLength(1);
    const first = listed[0];
    if (first === undefined) throw new Error('expected branch entry');
    expect(first.name).toBe('draft');
    expect(first.base).toBe('live');
    expect(first.eventCount).toBe(0);
    expect(first.documents['notes/n1']).toEqual({ body: 'live' });
    expect(first.storage).toBeUndefined();
  });

  it('GET /__pyric/workspace/branches surfaces 500 MiB SHA-256 Storage references and hashes legacy inline entries without sending base64', async () => {
    const ws = diskWorkspace(dir);
    const sandbox = initializeSandbox();
    getInternalEnv(sandbox).seed({ rules: '', documents: { 'notes/n1': { body: 'ref' } } });
    const storage = getAdminStorageSandbox(sandbox, { dbName: 'pyric-studio-branch-storage' });
    await uploadBytes(storageRef(storage, 'small/inline.txt'), new Uint8Array([1, 2, 3, 4]));
    const baseState = await captureFullState(sandbox);
    sandbox.dispose();

    const largeSha = 'c'.repeat(64);
    baseState.storage.push({
      path: 'videos/large.mp4',
      sha256: largeSha,
      size: 524_288_000,
      contentType: 'video/mp4',
      customMetadata: { resolution: '4k' },
      blobType: 'video/mp4',
      metadata: {
        bucket: 'pyric-default',
        name: 'large.mp4',
        size: 524_288_000,
        timeCreated: '2026-10-07T00:00:00.000Z',
        updated: '2026-10-07T00:00:00.000Z',
        generation: '1',
        metageneration: '1',
      },
    });

    const refBranch = await fork(baseState);
    restoreLimit = setInlineStorageLimitForTesting(16);
    await saveBranch(dir, 'media', refBranch, { base: 'live' });
    discard(refBranch);

    // Also create a second branch whose storage.json is corrupted so we verify isolation.
    const brokenSandbox = initializeSandbox();
    const brokenBranch = await fork(await captureFullState(brokenSandbox));
    brokenSandbox.dispose();
    await saveBranch(dir, 'corrupt', brokenBranch, { base: 'live' });
    discard(brokenBranch);
    writeFileSync(join(branchDirectory(dir, 'corrupt'), 'state', 'storage.json'), '{not-json');

    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken: testSessionToken,
      boundHost: 'localhost',
    });
    const res = mockRes();
    await routes(mockReq('GET'), res.res, new URL('http://localhost/__pyric/workspace/branches'));
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('contentBase64');
    const listed = JSON.parse(res.body) as WorkspaceBranch[];
    expect(listed.map((entry) => entry.name)).toEqual(['corrupt', 'media']);

    const corrupt = listed[0];
    const media = listed[1];
    if (corrupt === undefined || media === undefined) {
      throw new Error('expected two branch entries');
    }
    expect(corrupt.documents).toEqual({});
    expect(corrupt.storage).toBeUndefined();
    expect(media.documents['notes/n1']).toEqual({ body: 'ref' });
    expect(media.storage).toEqual([
      {
        path: 'small/inline.txt',
        sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
        size: 4,
        contentType: 'application/octet-stream',
        customMetadata: {},
        blobType: '',
      },
      {
        path: 'videos/large.mp4',
        sha256: largeSha,
        size: 524_288_000,
        contentType: 'video/mp4',
        customMetadata: { resolution: '4k' },
        blobType: 'video/mp4',
      },
    ]);
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
