import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IN_PROCESS_STATE_RELATIVE,
  runInProcessMcp,
} from '../../src/bridge/server/in-process.js';
import { STORAGE_SIDECAR_RELATIVE } from '../../src/bridge/server/storage-sidecar.js';
import { HOST_STOPPED_NOTICE } from '../../src/bridge/server/target-router.js';
import { claimProjectState } from '../../src/serve/hosted/project-ownership.js';
import type { Discovered } from '../../src/serve/discovery.js';

interface MockHost {
  discovered: Discovered;
  stop(): Promise<void>;
}

const tempDirs: string[] = [];
const hosts: MockHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-mcp-fallback-')));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
  );
  writeFileSync(
    join(dir, 'firestore.rules'),
    "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /items/{id} { allow read, write: if true; } } }",
  );
  return dir;
}

async function startMockHost(projectDir: string): Promise<MockHost> {
  const instanceId = `mock-host-${Math.random().toString(36).slice(2)}`;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__pyric/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'sandbox', instanceId }));
      return;
    }
    if (url.pathname === '/__pyric/hosted/method' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const parsed = JSON.parse(body) as { key?: string; args?: Record<string, unknown> };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          summary: `Host handled ${parsed.key ?? 'unknown'}`,
          data: { handledOnHost: true, key: parsed.key },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('Expected TCP address for mock host');
  }
  const base = `http://127.0.0.1:${address.port}`;
  const pointerPath = join(projectDir, '.pyric', 'serve.json');
  mkdirSync(join(projectDir, '.pyric'), { recursive: true });
  writeFileSync(
    pointerPath,
    JSON.stringify({
      url: base,
      mcpUrl: `${base}/__pyric/mcp`,
      port: address.port,
      pid: process.pid,
      instanceId,
    }),
  );
  let stopped = false;
  const handle: MockHost = {
    discovered: {
      pointerProjectDir: projectDir,
      mcpUrl: `${base}/__pyric/mcp`,
      url: base,
      base,
      instanceId,
      source: `pointer ${pointerPath}`,
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      rmSync(pointerPath, { force: true });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  hosts.push(handle);
  return handle;
}

async function openSession(
  projectDir: string,
  options: { initialHost?: Discovered; inProcessOnly?: boolean } = {},
): Promise<{
  client: Client;
  close(): Promise<number>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const exitPromise = runInProcessMcp(projectDir, {
    projectDir,
    transport: serverTransport,
    initialHost: options.initialHost,
    inProcessOnly: options.inProcessOnly,
  });
  const client = new Client({ name: 'fallback-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await clientTransport.close();
      return await exitPromise;
    },
  };
}

function parseToolBody(result: Awaited<ReturnType<Client['callTool']>>): {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  _pyric?: { target?: string };
} {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0]?.text ?? '{}') as {
    ok: boolean;
    summary: string;
    data?: Record<string, unknown>;
    _pyric?: { target?: string };
  };
}

describe('MCP host-stop fallback persistence', () => {
  it('hydrates prior in-process state, acquires the lock, and persists Firestore and Storage writes after host stop', async () => {
    const projectDir = createProject();

    // Seed pre-existing in-process state before the host session starts.
    const seedSession = await openSession(projectDir, { inProcessOnly: true });
    const seedWrite = parseToolBody(
      await seedSession.client.callTool({
        name: 'firestore',
        arguments: { method: 'setDoc', args: { path: 'items/prior', data: { phase: 'before-host' } } },
      }),
    );
    expect(seedWrite.ok).toBe(true);
    expect(await seedSession.close()).toBe(0);
    expect(existsSync(join(projectDir, IN_PROCESS_STATE_RELATIVE))).toBe(true);

    // Start host and start MCP attached to initialHost.
    const host = await startMockHost(projectDir);
    const session = await openSession(projectDir, { initialHost: host.discovered });

    const onHost = parseToolBody(
      await session.client.callTool({
        name: 'firestore',
        arguments: { method: 'setDoc', args: { path: 'items/on-host', data: { phase: 'host' } } },
      }),
    );
    expect(onHost.ok).toBe(true);
    expect(onHost._pyric?.target).toBe('host');

    // Stop host mid-session.
    await host.stop();

    // First call after stop reports host failure; next call falls back to local in-process.
    const failedHostCall = parseToolBody(
      await session.client.callTool({
        name: 'firestore',
        arguments: { method: 'setDoc', args: { path: 'items/during-stop', data: { phase: 'fail' } } },
      }),
    );
    expect(failedHostCall.ok).toBe(false);
    expect(failedHostCall._pyric?.target).toBe('host');

    const fallbackWrite = parseToolBody(
      await session.client.callTool({
        name: 'firestore',
        arguments: { method: 'setDoc', args: { path: 'items/after-stop', data: { phase: 'fallback' } } },
      }),
    );
    expect(fallbackWrite.ok).toBe(true);
    expect(fallbackWrite._pyric?.target).toBe('in-process');
    expect(fallbackWrite.summary).toContain(HOST_STOPPED_NOTICE);

    // Pre-existing in-process document must be hydrated rather than clobbered.
    const priorRead = parseToolBody(
      await session.client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'items/prior' } },
      }),
    );
    expect(priorRead.data?.exists).toBe(true);

    // Storage writes after fallback must also persist to the sidecar on exit.
    const storageWrite = parseToolBody(
      await session.client.callTool({
        name: 'storage',
        arguments: {
          method: 'uploadBytes',
          args: {
            path: 'notes/fallback.txt',
            contentBase64: Buffer.from('persisted-after-stop', 'utf8').toString('base64'),
          },
        },
      }),
    );
    expect(storageWrite.ok).toBe(true);

    expect(await session.close()).toBe(0);
    expect(existsSync(join(projectDir, IN_PROCESS_STATE_RELATIVE))).toBe(true);
    expect(existsSync(join(projectDir, STORAGE_SIDECAR_RELATIVE))).toBe(true);

    // Next session reads back both prior and post-fallback writes plus storage sidecar.
    const nextSession = await openSession(projectDir, { inProcessOnly: true });
    const afterRead = parseToolBody(
      await nextSession.client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'items/after-stop' } },
      }),
    );
    expect(afterRead.data?.exists).toBe(true);
    const priorReadNext = parseToolBody(
      await nextSession.client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'items/prior' } },
      }),
    );
    expect(priorReadNext.data?.exists).toBe(true);
    const storageReadNext = parseToolBody(
      await nextSession.client.callTool({
        name: 'storage',
        arguments: { method: 'getBytes', args: { path: 'notes/fallback.txt' } },
      }),
    );
    expect(storageReadNext.ok).toBe(true);
    expect(await nextSession.close()).toBe(0);
  });

  it('discloses ephemeral fallback mode without crashing when another writer holds the in-process lock', async () => {
    const projectDir = createProject();
    const externalOwner = await claimProjectState(projectDir, 'in-process');
    try {
      const host = await startMockHost(projectDir);
      const session = await openSession(projectDir, { initialHost: host.discovered });

      const onHost = parseToolBody(
        await session.client.callTool({
          name: 'firestore',
          arguments: { method: 'getDoc', args: { path: 'items/probe' } },
        }),
      );
      expect(onHost._pyric?.target).toBe('host');

      await host.stop();

      // Call 1 detects host failure.
      await session.client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'items/probe' } },
      });

      // Call 2 falls back locally, sees busy lock, and explicitly discloses ephemeral state.
      const fallback = parseToolBody(
        await session.client.callTool({
          name: 'firestore',
          arguments: { method: 'setDoc', args: { path: 'items/ephemeral', data: { temp: true } } },
        }),
      );
      expect(fallback.ok).toBe(true);
      expect(fallback._pyric?.target).toBe('in-process');
      expect(fallback.summary).toContain(HOST_STOPPED_NOTICE);
      expect(fallback.summary).toMatch(/ephemeral/i);
      expect(fallback.summary).toMatch(/not be saved|not persisted/i);

      expect(await session.close()).toBe(0);
      expect(existsSync(join(projectDir, IN_PROCESS_STATE_RELATIVE))).toBe(false);
    } finally {
      externalOwner.close();
    }
  });

  it('does not claim in-process.lock or write in-process.json when host stays running until exit', async () => {
    const projectDir = createProject();
    const host = await startMockHost(projectDir);
    const session = await openSession(projectDir, { initialHost: host.discovered });

    const onHost = parseToolBody(
      await session.client.callTool({
        name: 'firestore',
        arguments: { method: 'getDoc', args: { path: 'items/stay-host' } },
      }),
    );
    expect(onHost._pyric?.target).toBe('host');
    expect(await session.close()).toBe(0);

    expect(existsSync(join(projectDir, '.pyric', 'state', 'in-process.lock'))).toBe(false);
    expect(existsSync(join(projectDir, IN_PROCESS_STATE_RELATIVE))).toBe(false);
  });
});
