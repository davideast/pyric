import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  basesForPort,
  discoverPointerOnce,
  discoverServe,
  healthyBase,
  pointerHostAnswers,
  selectExplicitHost,
} from '../../src/serve/discovery.js';
import { TargetRouter } from '../../src/bridge/server/target-router.js';

interface BoundHost {
  server: Server;
  host: string;
  port: number;
  url: string;
  instanceId: string;
}

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function startLoopbackHost(host: string, instanceId: string): Promise<BoundHost> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/__pyric/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'sandbox', instanceId }));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error(`Expected TCP address for ${host}`);
  }
  return {
    server,
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    instanceId,
  };
}

function projectWithPointer(pointer: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-loopback-disc-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.pyric'), { recursive: true });
  writeFileSync(join(dir, '.pyric', 'serve.json'), JSON.stringify(pointer));
  return realpathSync(dir);
}

describe('non-.1 loopback host discovery (127.0.0.0/8)', () => {
  it('computes probe bases honoring explicit loopback hosts while keeping localhost dual-stack', () => {
    expect(basesForPort(41234)).toEqual(['http://127.0.0.1:41234', 'http://[::1]:41234']);
    expect(basesForPort(41234, 'http://localhost:41234')).toEqual([
      'http://127.0.0.1:41234',
      'http://[::1]:41234',
    ]);
    expect(basesForPort(41234, 'http://0.0.0.0:41234')).toEqual([
      'http://127.0.0.1:41234',
      'http://[::1]:41234',
    ]);
    expect(basesForPort(41234, 'http://[::1]:41234')).toEqual([
      'http://[::1]:41234',
      'http://127.0.0.1:41234',
    ]);
    expect(basesForPort(41234, 'http://127.0.0.2:41234')).toEqual([
      'http://127.0.0.2:41234',
    ]);
    expect(basesForPort(41234, 'http://127.0.0.2:41234/__pyric/mcp')).toEqual([
      'http://127.0.0.2:41234',
    ]);
  });

  it('discovers a host bound exclusively to 127.0.0.2 immediately without stalling', async () => {
    const host = await startLoopbackHost('127.0.0.2', 'loopback-2-instance');
    const pointer = {
      url: host.url,
      mcpUrl: `${host.url}/__pyric/mcp`,
      port: host.port,
      pid: process.pid,
      instanceId: host.instanceId,
    };
    const cwd = projectWithPointer(pointer);

    const started = Date.now();
    const discovered = await discoverServe(cwd, undefined, []);
    const elapsedMs = Date.now() - started;

    expect(discovered).not.toBeNull();
    expect(discovered?.base).toBe(host.url);
    expect(discovered?.url).toBe(host.url);
    expect(discovered?.mcpUrl).toBe(`${host.url}/__pyric/mcp`);
    expect(discovered?.instanceId).toBe(host.instanceId);
    expect(elapsedMs).toBeLessThan(2_000);

    const once = await discoverPointerOnce(cwd);
    expect(once?.base).toBe(host.url);

    expect(await pointerHostAnswers(pointer)).toBe(true);
    expect(await pointerHostAnswers({ ...pointer, instanceId: 'wrong-instance' })).toBe(false);

    const hit = await healthyBase(host.port, host.instanceId, host.url);
    expect(hit).toEqual({ base: host.url, instanceId: host.instanceId });

    const explicit = await selectExplicitHost({ url: host.url, cwd });
    expect(explicit).toEqual({ kind: 'explicit', serveUrl: host.url, base: host.url });
  });

  it('resolves a 127.0.0.2 pointer dynamically in TargetRouter without dropping back to in-process', async () => {
    const host = await startLoopbackHost('127.0.0.2', 'router-loopback-2');
    const cwd = projectWithPointer({
      url: host.url,
      mcpUrl: `${host.url}/__pyric/mcp`,
      port: host.port,
      pid: process.pid,
      instanceId: host.instanceId,
    });

    const router = new TargetRouter({ projectDir: cwd, cacheTtlMs: 0 });
    const resolved = await router.resolveHost();
    expect(resolved).not.toBeNull();
    expect(resolved?.base).toBe(host.url);
    expect(resolved?.url).toBe(host.url);
    expect(resolved?.instanceId).toBe(host.instanceId);
  });
});
