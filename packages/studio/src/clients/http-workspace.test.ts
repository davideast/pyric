import { afterEach, describe, expect, it } from 'bun:test';
import {
  httpWorkspace,
  resolveSessionToken,
  createAuthHeaders,
  resetSessionTokenCache,
} from './http-workspace.js';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop();
  resetSessionTokenCache();
});

describe('httpWorkspace client & token resolution', () => {
  it('resolves session capability token from /__pyric/init.json', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/__pyric/init.json') {
          return new Response(JSON.stringify({ sessionToken: 'valid-session-token-xyz' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);

    const token = await resolveSessionToken(`http://localhost:${server.port}`);
    expect(token).toBe('valid-session-token-xyz');
  });

  it('does not leak activityToken as fallback sessionToken in client resolver', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ activityToken: 'leaked-activity-token-123' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    servers.push(server);

    const resolved = await resolveSessionToken(`http://localhost:${server.port}`);
    expect(resolved).toBeNull();
  });

  it('retries sessionToken resolution after initial failure without permanently caching null', async () => {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts++;
        if (attempts === 1) {
          return new Response('internal error', { status: 500 });
        }
        return new Response(JSON.stringify({ sessionToken: 'retry-success-token' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    servers.push(server);

    const first = await resolveSessionToken(`http://localhost:${server.port}`);
    expect(first).toBeNull();

    // Second call must retry and succeed instead of returning cached null
    const second = await resolveSessionToken(`http://localhost:${server.port}`);
    expect(second).toBe('retry-success-token');
    expect(attempts).toBe(2);
  });

  it('createAuthHeaders attaches writer and token headers', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ sessionToken: 'auth-header-token' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    servers.push(server);

    const readHeaders = await createAuthHeaders(`http://localhost:${server.port}`, undefined, false);
    expect(readHeaders['x-pyric-session-token']).toBe('auth-header-token');
    expect(readHeaders['x-pyric-writer']).toBeUndefined();

    const writeHeaders = await createAuthHeaders(`http://localhost:${server.port}`, { writerId: 'tab-42' }, true);
    expect(writeHeaders['x-pyric-session-token']).toBe('auth-header-token');
    expect(writeHeaders['x-pyric-writer']).toBe('tab-42');
  });

  it('httpWorkspace operations attach tokens and writer lock', async () => {
    const files = new Map<string, string>();
    let receivedSessionToken: string | null = null;
    let receivedWriterHeader: string | null = null;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/__pyric/init.json') {
          return new Response(JSON.stringify({ sessionToken: 'workspace-test-token' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/__pyric/workspace') {
          receivedSessionToken = req.headers.get('x-pyric-session-token');
          receivedWriterHeader = req.headers.get('x-pyric-writer');
          const path = url.searchParams.get('path');
          if (!path) return new Response('missing path', { status: 400 });

          if (req.method === 'PUT') {
            const body = await req.text();
            files.set(path, body);
            return new Response(null, { status: 204 });
          }
          if (req.method === 'GET') {
            const content = files.get(path);
            if (content === undefined) return new Response(null, { status: 404 });
            return new Response(content, { headers: { 'content-type': 'text/plain' } });
          }
          if (req.method === 'DELETE') {
            files.delete(path);
            return new Response(null, { status: 204 });
          }
        }
        if (url.pathname === '/__pyric/workspace/list') {
          return new Response(JSON.stringify([{ path: 'doc.txt', kind: 'file' }]), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);

    const client = httpWorkspace(`http://localhost:${server.port}`);
    await client.write('doc.txt', 'hello workspace');
    expect(receivedSessionToken as string | null).toBe('workspace-test-token');
    expect(receivedWriterHeader as string | null).toMatch(/^studio-writer-/);

    const read = await client.read('doc.txt');
    expect(read).toBe('hello workspace');

    const list = await client.list();
    expect(list).toEqual([{ path: 'doc.txt', kind: 'file' }]);

    await client.remove('doc.txt');
    expect(await client.read('doc.txt')).toBeNull();
  });

  it('watch() opens /__pyric/workspace/watch without ?token= query parameter (relying on session cookie)', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ sessionToken: 'watch-secret-token' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    servers.push(server);

    const openedUrls: string[] = [];
    const g = globalThis as Record<string, unknown>;
    const prevEventSource = g.EventSource;
    class FakeEventSource {
      constructor(public url: string) {
        openedUrls.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    g.EventSource = FakeEventSource;
    try {
      const base = `http://localhost:${server.port}`;
      const client = httpWorkspace(base);
      const stop = client.watch(() => {});
      await new Promise((r) => setTimeout(r, 25));
      stop();
      expect(openedUrls).toEqual([`${base}/__pyric/workspace/watch`]);
    } finally {
      g.EventSource = prevEventSource;
    }
  });

  it('resolves loopback sessionToken from in-process port registry when init.json omits sessionToken and exchanges explicit token before watch()', async () => {
    let initAuthHeader: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/__pyric/init.json') {
          initAuthHeader = req.headers.get('x-pyric-session-token');
          return new Response(
            JSON.stringify(initAuthHeader ? { sessionToken: initAuthHeader } : { rulesHash: null }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.pathname === '/__pyric/workspace/list') {
          if (req.headers.get('x-pyric-session-token') !== 'in-process-port-secret') {
            return new Response('unauthorized', { status: 401 });
          }
          return new Response(JSON.stringify([{ path: 'items.txt', kind: 'file' }]), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);

    const registryKey = Symbol.for('pyric.localSessionTokensByPort');
    const holder = globalThis as unknown as Record<symbol, Map<number, string> | undefined>;
    const map = holder[registryKey] ?? new Map<number, string>();
    holder[registryKey] = map;
    map.set(server.port!, 'in-process-port-secret');

    const g = globalThis as Record<string, unknown>;
    const prevEventSource = g.EventSource;
    const openedUrls: string[] = [];
    class FakeEventSource {
      constructor(public url: string) {
        openedUrls.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    g.EventSource = FakeEventSource;

    try {
      const base = `http://127.0.0.1:${server.port}`;
      const client = httpWorkspace(base);
      const entries = await client.list();
      expect(entries).toEqual([{ path: 'items.txt', kind: 'file' }]);

      initAuthHeader = null;
      const explicitClient = httpWorkspace(base, { token: 'explicit-watch-token' });
      const stop = explicitClient.watch(() => {});
      await new Promise((r) => setTimeout(r, 25));
      stop();
      expect(initAuthHeader as string | null).toBe('explicit-watch-token');
      expect(openedUrls).toEqual([`${base}/__pyric/workspace/watch`]);
    } finally {
      map.delete(server.port!);
      g.EventSource = prevEventSource;
    }
  });
});
