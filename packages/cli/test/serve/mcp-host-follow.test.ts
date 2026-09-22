import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeSandbox } from 'pyric/sandbox';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInProcessMcpServer } from '../../src/bridge/server/in-process.js';
import { HOST_STARTED_NOTICE, HOST_STOPPED_NOTICE } from '../../src/bridge/server/target-router.js';

interface TestHost {
  instanceId: string;
  server: Server;
  base: string;
  close(): Promise<void>;
}

async function startTestHost(
  projectDir: string,
  options: { sharedWorker?: boolean } = {},
): Promise<TestHost> {
  const instanceId = 'test-host-instance-' + Math.random().toString(36).slice(2);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/__pyric/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ mode: 'sandbox', instanceId }));
      return;
    }
    if (
      !options.sharedWorker &&
      url.pathname === '/__pyric/hosted/method' &&
      request.method === 'POST'
    ) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          summary: 'Document read from host',
          data: { hostReceived: parsed },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Failed to bind server');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    instanceId,
    server,
    base,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('ADR 0016: MCP session follows the Node host', () => {
  it('switches targets dynamically and announces transitions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mcp-follow-'));
    const projectDir = realpathSync(tempDir);
    mkdirSync(join(projectDir, '.pyric'), { recursive: true });

    const sandbox = initializeSandbox();
    const server = buildInProcessMcpServer(sandbox, { projectDir, cacheTtlMs: 0 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    let host: TestHost | null = null;
    try {
      // 1. Initial call: in-process, no host
      const res1 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body1 = JSON.parse((res1.content as Array<{ text: string }>)[0].text);
      expect(body1._pyric).toBeDefined();
      expect(body1._pyric.target).toBe('in-process');
      expect(body1.summary).not.toContain(HOST_STARTED_NOTICE);
      expect(body1.summary).not.toContain(HOST_STOPPED_NOTICE);

      // 2. Start the Node host and write .pyric/serve.json
      host = await startTestHost(projectDir);
      const pointerPath = join(projectDir, '.pyric', 'serve.json');
      const address = host.server.address() as { port: number };
      writeFileSync(
        pointerPath,
        JSON.stringify({
          url: host.base,
          mcpUrl: `${host.base}/__pyric/mcp`,
          port: address.port,
          instanceId: host.instanceId,
          project: 'sandbox',
        }),
      );

      // 3. Call tool again: should switch to host and include notice
      const res2 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body2 = JSON.parse((res2.content as Array<{ text: string }>)[0].text);
      expect(body2._pyric.target).toBe('host');
      expect(body2.summary).toContain(HOST_STARTED_NOTICE);

      // 4. Subsequent call on host: stays on host, no switch notice
      const res3 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body3 = JSON.parse((res3.content as Array<{ text: string }>)[0].text);
      expect(body3._pyric.target).toBe('host');
      expect(body3.summary).not.toContain(HOST_STARTED_NOTICE);

      // 5. Stop host (and remove serve.json)
      await host.close();
      host = null;
      rmSync(pointerPath, { force: true });

      // 6. Call tool: reverts to in-process and announces host stopped
      const res4 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body4 = JSON.parse((res4.content as Array<{ text: string }>)[0].text);
      expect(body4._pyric.target).toBe('in-process');
      expect(body4.summary).toContain(HOST_STOPPED_NOTICE);

      // 7. Subsequent in-process call: stays in-process, no notice
      const res5 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body5 = JSON.parse((res5.content as Array<{ text: string }>)[0].text);
      expect(body5._pyric.target).toBe('in-process');
      expect(body5.summary).not.toContain(HOST_STOPPED_NOTICE);
    } finally {
      if (host) await host.close();
      await client.close();
      await server.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('--in-process (inProcessOnly: true) suppresses host following', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mcp-no-follow-'));
    const projectDir = realpathSync(tempDir);
    mkdirSync(join(projectDir, '.pyric'), { recursive: true });

    const host = await startTestHost(projectDir);
    const pointerPath = join(projectDir, '.pyric', 'serve.json');
    const address = host.server.address() as { port: number };
    writeFileSync(
      pointerPath,
      JSON.stringify({
        url: host.base,
        mcpUrl: `${host.base}/__pyric/mcp`,
        port: address.port,
        instanceId: host.instanceId,
        project: 'sandbox',
      }),
    );

    const sandbox = initializeSandbox();
    const server = buildInProcessMcpServer(sandbox, { projectDir, inProcessOnly: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const res = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body._pyric.target).toBe('in-process');
      expect(body.summary).not.toContain(HOST_STARTED_NOTICE);
    } finally {
      await host.close();
      await client.close();
      await server.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('stale pointer failure falls back to local on the NEXT call, not the current one', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mcp-stale-'));
    const projectDir = realpathSync(tempDir);
    mkdirSync(join(projectDir, '.pyric'), { recursive: true });

    const host = await startTestHost(projectDir);
    const pointerPath = join(projectDir, '.pyric', 'serve.json');
    const address = host.server.address() as { port: number };
    writeFileSync(
      pointerPath,
      JSON.stringify({
        url: host.base,
        mcpUrl: `${host.base}/__pyric/mcp`,
        port: address.port,
        instanceId: host.instanceId,
        project: 'sandbox',
      }),
    );

    const sandbox = initializeSandbox();
    const server = buildInProcessMcpServer(sandbox, { projectDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      // 1. Initial call runs on host
      const res1 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body1 = JSON.parse((res1.content as Array<{ text: string }>)[0].text);
      expect(body1._pyric.target).toBe('host');

      // 2. Host dies abruptly while pointer remains on disk
      await host.close();

      // 3. Current call fails on host target (doesn't silently swallow/redirect mid-call)
      const res2 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body2 = JSON.parse((res2.content as Array<{ text: string }>)[0].text);
      expect(body2.ok).toBe(false);
      expect(body2._pyric.target).toBe('host');

      // 4. NEXT call falls back to in-process and announces host stopped
      const res3 = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body3 = JSON.parse((res3.content as Array<{ text: string }>)[0].text);
      expect(body3._pyric.target).toBe('in-process');
      expect(body3.summary).toContain(HOST_STOPPED_NOTICE);
    } finally {
      await client.close();
      await server.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('SharedWorker host (404 on hosted method) stays in-process', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mcp-sharedworker-'));
    const projectDir = realpathSync(tempDir);
    mkdirSync(join(projectDir, '.pyric'), { recursive: true });

    // Host reports healthy but 404s on /__pyric/hosted/method (SharedWorker mode)
    const host = await startTestHost(projectDir, { sharedWorker: true });
    const pointerPath = join(projectDir, '.pyric', 'serve.json');
    const address = host.server.address() as { port: number };
    writeFileSync(
      pointerPath,
      JSON.stringify({
        url: host.base,
        mcpUrl: `${host.base}/__pyric/mcp`,
        port: address.port,
        instanceId: host.instanceId,
        project: 'sandbox',
      }),
    );

    const sandbox = initializeSandbox();
    const server = buildInProcessMcpServer(sandbox, { projectDir, cacheTtlMs: 0 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const res = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body._pyric.target).toBe('in-process');
      expect(body.summary).not.toContain(HOST_STARTED_NOTICE);
    } finally {
      await host.close();
      await client.close();
      await server.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('ignores a pointer belonging to another project directory', async () => {
    const tempDir1 = mkdtempSync(join(tmpdir(), 'pyric-mcp-proj1-'));
    const tempDir2 = mkdtempSync(join(tmpdir(), 'pyric-mcp-proj2-'));
    const projectDir1 = realpathSync(tempDir1);
    const projectDir2 = realpathSync(tempDir2);
    mkdirSync(join(projectDir1, '.pyric'), { recursive: true });

    // Host is started for projectDir2
    const host = await startTestHost(projectDir2);
    const address = host.server.address() as { port: number };

    const sandbox = initializeSandbox();
    // Injected discover returns pointer belonging to projectDir2
    const server = buildInProcessMcpServer(sandbox, {
      projectDir: projectDir1,
      cacheTtlMs: 0,
      discover: async () => ({
        url: host.base,
        base: host.base,
        mcpUrl: `${host.base}/__pyric/mcp`,
        instanceId: host.instanceId,
        pointerProjectDir: projectDir2,
        source: 'pointer .pyric/serve.json',
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const res = await client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'users/alice' } },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body._pyric.target).toBe('in-process');
      expect(body.summary).not.toContain(HOST_STARTED_NOTICE);
    } finally {
      await host.close();
      await client.close();
      await server.close();
      rmSync(projectDir1, { recursive: true, force: true });
      rmSync(projectDir2, { recursive: true, force: true });
    }
  });

  it('1-second pointer cache avoids repeated probe lookups', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-mcp-cache-'));
    const projectDir = realpathSync(tempDir);
    mkdirSync(join(projectDir, '.pyric'), { recursive: true });

    let discoverCount = 0;
    const host = await startTestHost(projectDir);

    const sandbox = initializeSandbox();
    const server = buildInProcessMcpServer(sandbox, {
      projectDir,
      cacheTtlMs: 1000,
      discover: async () => {
        discoverCount++;
        return {
          url: host.base,
          base: host.base,
          mcpUrl: `${host.base}/__pyric/mcp`,
          instanceId: host.instanceId,
          pointerProjectDir: projectDir,
          source: 'pointer .pyric/serve.json',
        };
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      // 3 rapid calls in under 1 second
      await client.callTool({ name: 'firestore', arguments: { method: 'getDoc', args: { path: 'users/alice' } } });
      await client.callTool({ name: 'firestore', arguments: { method: 'getDoc', args: { path: 'users/alice' } } });
      await client.callTool({ name: 'firestore', arguments: { method: 'getDoc', args: { path: 'users/alice' } } });

      // Because of the 1-second cache, discover was only called once!
      expect(discoverCount).toBe(1);
    } finally {
      await host.close();
      await client.close();
      await server.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
