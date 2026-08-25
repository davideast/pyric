import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskWorkspace, diskProjectStore, createStudioRoutes } from '../../src/serve/studio/index.js';
import { createWriterLock } from '../../src/serve/writer-lock.js';
import { startStaticServer } from '../../src/serve/server.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { httpWorkspace } from '../../../studio/src/clients/http-workspace.js';
import { httpProjectStore } from '../../../studio/src/clients/http-project-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pyric-auth-guard-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Defense-in-Depth Authorization & Mutation Guard', () => {
  const sessionToken = 'test-boot-session-token-12345';
  const boundHost = 'localhost';
  const allowedHosts: string[] = [];

  it('rejects cross-origin requests from unapproved origins with 403 Forbidden', async () => {
    const ws = diskWorkspace(dir);
    const writerLock = createWriterLock();
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      writerLock,
      boundHost,
      allowedHosts,
    });

    // Valid token & writer header, but invalid cross-origin Origin header
    const req = new Request('http://localhost/__pyric/workspace?path=test.txt', {
      method: 'GET',
      headers: {
        origin: 'http://attacker-unapproved.example.com',
        'x-pyric-session-token': sessionToken,
      },
    });

    const resHeaders: Record<string, string> = {};
    let statusCode = 200;
    let body = '';
    const mockRes = {
      writeHead(code: number, headers?: Record<string, string>) {
        statusCode = code;
        if (headers) Object.assign(resHeaders, headers);
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
      headersSent: false,
    } as any;

    const handled = await routes(
      req as any,
      mockRes,
      new URL('http://localhost/__pyric/workspace?path=test.txt'),
    );

    expect(handled).toBe(true);
    expect(statusCode).toBe(403);
    expect(body).toContain('Forbidden: origin mismatch');
  });

  it('rejects requests lacking or with invalid session capability token with 401 Unauthorized', async () => {
    const ws = diskWorkspace(dir);
    const writerLock = createWriterLock();
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      writerLock,
      boundHost,
    });

    // Request missing token
    let statusCode = 0;
    let body = '';
    const mockRes = {
      writeHead(code: number) {
        statusCode = code;
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
      headersSent: false,
    } as any;

    const reqMissingToken = new Request('http://localhost/__pyric/workspace/list', {
      method: 'GET',
    });

    await routes(reqMissingToken as any, mockRes, new URL('http://localhost/__pyric/workspace/list'));
    expect(statusCode).toBe(401);
    expect(body).toContain('Unauthorized: invalid session capability token');

    // Request with invalid token
    body = '';
    const reqWrongToken = new Request('http://localhost/__pyric/workspace/list', {
      method: 'GET',
      headers: { 'x-pyric-session-token': 'wrong-token' },
    });

    await routes(reqWrongToken as any, mockRes, new URL('http://localhost/__pyric/workspace/list'));
    expect(statusCode).toBe(401);
    expect(body).toContain('Unauthorized: invalid session capability token');
  });

  it('rejects file write and delete operations without active writer lock header with 423 Locked', async () => {
    const ws = diskWorkspace(dir);
    const writerLock = createWriterLock();
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      writerLock,
      boundHost,
    });

    let statusCode = 0;
    let body = '';
    const mockRes = {
      writeHead(code: number) {
        statusCode = code;
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
      headersSent: false,
    } as any;

    // PUT write without x-pyric-writer header
    const reqNoWriter = new Request('http://localhost/__pyric/workspace?path=note.txt', {
      method: 'PUT',
      headers: {
        'x-pyric-session-token': sessionToken,
      },
    });

    await routes(reqNoWriter as any, mockRes, new URL('http://localhost/__pyric/workspace?path=note.txt'));
    expect(statusCode).toBe(423);
    expect(body).toContain('Locked: missing active writer lock header');

    // DELETE remove without x-pyric-writer header
    body = '';
    const reqDeleteNoWriter = new Request('http://localhost/__pyric/workspace?path=note.txt', {
      method: 'DELETE',
      headers: {
        'x-pyric-session-token': sessionToken,
      },
    });

    await routes(reqDeleteNoWriter as any, mockRes, new URL('http://localhost/__pyric/workspace?path=note.txt'));
    expect(statusCode).toBe(423);
    expect(body).toContain('Locked: missing active writer lock header');
  });

  it('rejects file write when another tab holds the writer lock with 423 Locked', async () => {
    const ws = diskWorkspace(dir);
    const writerLock = createWriterLock();
    writerLock.claim('tab-A', Date.now());

    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      writerLock,
      boundHost,
    });

    let statusCode = 0;
    let body = '';
    const mockRes = {
      writeHead(code: number) {
        statusCode = code;
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
      headersSent: false,
    } as any;

    // tab-B attempts write while tab-A holds lock
    const reqTabB = new Request('http://localhost/__pyric/workspace?path=note.txt', {
      method: 'PUT',
      headers: {
        'x-pyric-session-token': sessionToken,
        'x-pyric-writer': 'tab-B',
      },
    });

    await routes(reqTabB as any, mockRes, new URL('http://localhost/__pyric/workspace?path=note.txt'));
    expect(statusCode).toBe(423);
    expect(body).toContain('Locked: another tab holds the writer lock');
  });

  it('allows multiple active reader tabs without requiring writer lock', async () => {
    const ws = diskWorkspace(dir);
    await ws.write('readable.txt', 'hello world');

    const writerLock = createWriterLock();
    writerLock.claim('tab-A', Date.now());

    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      writerLock,
      boundHost,
    });

    let statusCode = 0;
    let body = '';
    const mockRes = {
      writeHead(code: number) {
        statusCode = code;
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
      headersSent: false,
    } as any;

    // tab-B reads readable.txt without a writer lock
    const reqRead = new Request('http://localhost/__pyric/workspace?path=readable.txt', {
      method: 'GET',
      headers: {
        'x-pyric-session-token': sessionToken,
      },
    });

    await routes(reqRead as any, mockRes, new URL('http://localhost/__pyric/workspace?path=readable.txt'));
    expect(statusCode).toBe(200);
    expect(body).toBe('hello world');
  });

  it('Studio browser clients auto-acquire session capability token and attach writer lock for end-to-end workflows', async () => {
    const ws = diskWorkspace(dir);
    const projects = diskProjectStore(join(dir, '.pyric', 'projects'));

    const namespace = createPyricNamespace({
      sdkDir: dir,
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
      }),
      studio: {
        workspace: ws,
        projects,
      },
    });

    const serverHandle = await startStaticServer({
      publicDir: dir,
      port: 0,
      namespaceHandler: namespace,
    });

    try {
      // 1. Fetch /__pyric/init.json to verify sessionToken is served
      const initRes = await fetch(`${serverHandle.url}/__pyric/init.json`);
      expect(initRes.status).toBe(200);
      const initPayload = await initRes.json();
      expect(typeof initPayload.sessionToken).toBe('string');
      expect(initPayload.sessionToken.length).toBeGreaterThan(10);

      // 2. Use httpWorkspace client without explicit token -> auto-acquires from /__pyric/init.json
      const clientWs = httpWorkspace(serverHandle.url);

      // Write file (auto-acquires token & attaches x-pyric-writer header)
      await clientWs.write('auto-acquired.txt', 'client content');

      // Read file (auto-acquires token)
      const readContent = await clientWs.read('auto-acquired.txt');
      expect(readContent).toBe('client content');

      // List directory
      const listEntries = await clientWs.list();
      expect(listEntries).toEqual([{ path: 'auto-acquired.txt', kind: 'file' }]);

      // Remove file
      await clientWs.remove('auto-acquired.txt');
      expect(await clientWs.read('auto-acquired.txt')).toBeNull();

      // 3. Use httpProjectStore client -> auto-acquires token & attaches writer lock
      const clientProjects = httpProjectStore(serverHandle.url);
      const projectMeta = await clientProjects.create({ title: 'Test Project' });
      expect(projectMeta.title).toBe('Test Project');

      const projectList = await clientProjects.list();
      expect(projectList.some((p) => p.id === projectMeta.id)).toBe(true);

      await clientProjects.remove(projectMeta.id);
    } finally {
      await serverHandle.stop();
    }
  });
});
