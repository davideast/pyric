import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskWorkspace, diskProjectStore, createStudioRoutes } from '../../../src/serve/studio/index.js';
import { createWriterLock } from '../../../src/serve/writer-lock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pyric-studio-routes-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createStudioRoutes guards and operations', () => {
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

    const req = new Request('http://localhost/__pyric/workspace?path=test.txt', {
      method: 'GET',
      headers: {
        origin: 'http://attacker-unapproved.example.com',
        'x-pyric-session-token': sessionToken,
      },
    });

    let statusCode = 200;
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

    const handled = await routes(
      req as any,
      mockRes,
      new URL('http://localhost/__pyric/workspace?path=test.txt'),
    );

    expect(handled).toBe(true);
    expect(statusCode).toBe(403);
    expect(body).toContain('Forbidden: origin mismatch');
  });

  it('rejects requests with unapproved host header with 403 Forbidden', async () => {
    const ws = diskWorkspace(dir);
    const writerLock = createWriterLock();
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      writerLock,
      boundHost,
      allowedHosts,
    });

    const req = new Request('http://attacker.example.com/__pyric/workspace/list', {
      method: 'GET',
      headers: {
        host: 'attacker.example.com',
        'x-pyric-session-token': sessionToken,
      },
    });

    let statusCode = 200;
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

    const handled = await routes(
      req as any,
      mockRes,
      new URL('http://attacker.example.com/__pyric/workspace/list'),
    );

    expect(handled).toBe(true);
    expect(statusCode).toBe(403);
    expect(body).toContain('Forbidden: host not allowed');
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

    // Missing token
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

    // Invalid token
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

  it('enforces origin and session capability token on workspace event stream (/__pyric/workspace/watch)', async () => {
    const ws = diskWorkspace(dir);
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      boundHost,
    });

    // 1. Rejected if unapproved Origin
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
      write(chunk?: string) {
        if (chunk) body += chunk;
        return true;
      },
      headersSent: false,
    } as any;

    const badOriginReq = new Request(`http://localhost/__pyric/workspace/watch?token=${sessionToken}`, {
      headers: { origin: 'http://malicious-site.example.com' },
    });
    await routes(badOriginReq as any, mockRes, new URL(`http://localhost/__pyric/workspace/watch?token=${sessionToken}`));
    expect(statusCode).toBe(403);
    expect(body).toContain('Forbidden: origin mismatch');

    // 2. Rejected if missing token
    const noTokenReq = new Request('http://localhost/__pyric/workspace/watch');
    await routes(noTokenReq as any, mockRes, new URL('http://localhost/__pyric/workspace/watch'));
    expect(statusCode).toBe(401);
    expect(body).toContain('Unauthorized: invalid session capability token');

    // 3. Rejected if invalid token
    const badTokenReq = new Request('http://localhost/__pyric/workspace/watch?token=wrong-token');
    await routes(badTokenReq as any, mockRes, new URL('http://localhost/__pyric/workspace/watch?token=wrong-token'));
    expect(statusCode).toBe(401);

    // 4. Allowed if valid token and origin
    body = '';
    const allowedReq = new Request(`http://localhost/__pyric/workspace/watch?token=${sessionToken}`);
    const unsubs: Array<() => void> = [];
    (allowedReq as any).on = (event: string, cb: () => void) => {
      if (event === 'close') unsubs.push(cb);
    };
    (mockRes as any).on = (event: string, cb: () => void) => {
      if (event === 'error') unsubs.push(cb);
    };

    await routes(allowedReq as any, mockRes, new URL(`http://localhost/__pyric/workspace/watch?token=${sessionToken}`));
    expect(statusCode).toBe(200);
    expect(body).toContain(': connected\n\n');
    for (const unsub of unsubs) unsub();
  });

  it('returns false when requested URL is not a studio route', async () => {
    const ws = diskWorkspace(dir);
    const routes = createStudioRoutes({
      workspace: ws,
      sessionToken,
      boundHost,
    });

    const req = new Request('http://localhost/__pyric/other-route');
    const mockRes = {} as any;
    const handled = await routes(req as any, mockRes, new URL('http://localhost/__pyric/other-route'));
    expect(handled).toBe(false);
  });

  it('enforces writer lock on projects mutation endpoint and allows authorized operations', async () => {
    const projects = diskProjectStore(join(dir, '.pyric', 'projects'));
    const writerLock = createWriterLock();
    const routes = createStudioRoutes({
      projects,
      sessionToken,
      writerLock,
      boundHost,
    });

    let statusCode = 0;
    let body = '';
    const mockRes = {
      writeHead(code: number, headers?: any) {
        statusCode = code;
        return mockRes;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        return mockRes;
      },
      headersSent: false,
    } as any;

    function createMockReq(method: string, headers: Record<string, string>, bodyStr = '') {
      const r = {
        method,
        headers,
        setEncoding() {},
        on(event: string, cb: any) {
          if (event === 'data' && bodyStr) cb(bodyStr);
          if (event === 'end') cb();
          return r;
        },
      };
      return r;
    }

    // 1. POST /__pyric/projects without writer lock -> 423
    const reqNoWriter = createMockReq(
      'POST',
      {
        'x-pyric-session-token': sessionToken,
        'content-type': 'application/json',
      },
      JSON.stringify({ title: 'New Project' }),
    );

    const handledNoWriter = await routes(reqNoWriter as any, mockRes, new URL('http://localhost/__pyric/projects'));
    expect(handledNoWriter).toBe(true);
    expect(statusCode).toBe(423);
    expect(body).toContain('Locked: missing active writer lock header');

    // 2. POST /__pyric/projects with token & writer lock -> 200
    body = '';
    const reqWithWriter = createMockReq(
      'POST',
      {
        'x-pyric-session-token': sessionToken,
        'x-pyric-writer': 'tab-author',
        'content-type': 'application/json',
      },
      JSON.stringify({ title: 'New Project' }),
    );

    const handledWithWriter = await routes(reqWithWriter as any, mockRes, new URL('http://localhost/__pyric/projects'));
    expect(handledWithWriter).toBe(true);
    expect(statusCode).toBe(200);
    const createdProject = JSON.parse(body);
    expect(createdProject.title).toBe('New Project');

    // 3. GET /__pyric/projects with token -> 200 (read doesn't require writer lock)
    body = '';
    const reqList = new Request('http://localhost/__pyric/projects', {
      method: 'GET',
      headers: {
        'x-pyric-session-token': sessionToken,
      },
    });

    const handledList = await routes(reqList as any, mockRes, new URL('http://localhost/__pyric/projects'));
    expect(handledList).toBe(true);
    expect(statusCode).toBe(200);
    const listedProjects = JSON.parse(body);
    expect(Array.isArray(listedProjects)).toBe(true);
    expect(listedProjects.some((p: any) => p.id === createdProject.id)).toBe(true);
  });

  it('fails closed with 401 on workspace and projects routes when sessionToken is omitted in options', async () => {
    const ws = diskWorkspace(dir);
    const projects = diskProjectStore(join(dir, '.pyric', 'projects'));
    const writerLock = createWriterLock();
    // Intentionally omit sessionToken in options
    const routes = createStudioRoutes({
      workspace: ws,
      projects,
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

    // 1. GET /__pyric/workspace/list
    const reqGetWs = new Request('http://localhost/__pyric/workspace/list', { method: 'GET' });
    const h1 = await routes(reqGetWs as any, mockRes, new URL('http://localhost/__pyric/workspace/list'));
    expect(h1).toBe(true);
    expect(statusCode).toBe(401);
    expect(body).toContain('Unauthorized: invalid session capability token');

    // 2. PUT /__pyric/workspace (even with writer lock)
    body = '';
    const reqPutWs = new Request('http://localhost/__pyric/workspace?path=secret.txt', {
      method: 'PUT',
      headers: { 'x-pyric-writer': 'tab-1' },
      body: 'secret data',
    });
    const h2 = await routes(reqPutWs as any, mockRes, new URL('http://localhost/__pyric/workspace?path=secret.txt'));
    expect(h2).toBe(true);
    expect(statusCode).toBe(401);

    // 3. GET /__pyric/projects
    body = '';
    const reqGetProj = new Request('http://localhost/__pyric/projects', { method: 'GET' });
    const h3 = await routes(reqGetProj as any, mockRes, new URL('http://localhost/__pyric/projects'));
    expect(h3).toBe(true);
    expect(statusCode).toBe(401);

    // 4. SSE /__pyric/workspace/watch
    body = '';
    const reqWatch = new Request('http://localhost/__pyric/workspace/watch');
    const h4 = await routes(reqWatch as any, mockRes, new URL('http://localhost/__pyric/workspace/watch'));
    expect(h4).toBe(true);
    expect(statusCode).toBe(401);
  });
});
