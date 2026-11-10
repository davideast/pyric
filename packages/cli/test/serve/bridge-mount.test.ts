/** `--bridge` mount (plan steps 2.2/2.3) — real HTTP/WS against startServe. */
import { afterAll, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { createLiveHostState } from '../../src/serve/live-host-state.js';
import { silentServeLogger } from '../../src/serve/server.js';
import { BRIDGE_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';
import { createMemoryBackend } from 'pyric/sandbox';
import { openStorageBackend } from '../../../pyric/src/storage/persistence.js';
import { closedPort } from '../closed-port.js';

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-bridge-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

async function serve(bridge: boolean): Promise<ServeRuntime> {
  const cwd = fixtureProject();
  const runtime = await startServe({
    cwd,
    port: 0,
    cacheRoot: join(cwd, '.cache'),
    logger: silentServeLogger(),
    bridge,
    disableAuditLog: true,
  });
  stops.push(runtime);
  return runtime;
}

describe('a client on another machine', () => {
  const BRIDGE_ROUTES = ['/__pyric/health', '/__pyric/mcp', '/__pyric/hosted/method', '/__pyric/hosted/repro', '/__pyric/storage/v0/b/x/o/y'];

  function peerCall(handler: ReturnType<typeof createBridgeMount>['handler'], path: string, remoteAddress: string) {
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; return res; },
      end() { return res; },
    };
    const req = { method: 'POST', headers: { host: 'localhost' }, socket: { remoteAddress, localPort: 5000 }, on() { return req; } };
    return handler(req as never, res as never, new URL(`http://localhost${path}`)).then(() => status);
  }

  it('is refused at every bridge route, even when all hosts are allowed', async () => {
    const mount = createBridgeMount({ upgradeGuard: { boundHost: '0.0.0.0', allowedHosts: true }, disableAuditLog: true });
    for (const path of BRIDGE_ROUTES) {
      expect(await peerCall(mount.handler, path, '10.0.0.5')).toBe(403);
    }
  });
});

describe('the health route on a loopback socket', () => {
  function healthCall(handler: ReturnType<typeof createBridgeMount>['handler'], host: string) {
    let status = 0;
    let body: unknown;
    const res = {
      writeHead(code: number) { status = code; return res; },
      end(chunk?: unknown) { body = chunk; return res; },
    };
    const req = { method: 'GET', headers: { host }, socket: { remoteAddress: '127.0.0.1', localPort: 5173 }, on() { return req; } };
    return handler(req as never, res as never, new URL('http://localhost/__pyric/health')).then(() => ({ status, body }));
  }

  // A Vite server with `allowedHosts: true` skips its own Host check, so a
  // page whose name rebinds to 127.0.0.1 reaches the mount directly.
  const mount = createBridgeMount({ upgradeGuard: { boundHost: 'localhost', allowedHosts: true }, disableAuditLog: true });

  it('refuses a Host that names another site, with no body', async () => {
    const answer = await healthCall(mount.handler, 'evil.example:5173');
    expect(answer.status).toBe(403);
    expect(answer.body).toBeUndefined();
  });

  it('answers a loopback Host on any port', async () => {
    for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173', 'localhost']) {
      expect((await healthCall(mount.handler, host)).status).toBe(200);
    }
  });
});

describe('pyric dev --bridge', () => {
  it('mounts health + advertises the ws URL in the init payload', async () => {
    const r = await serve(true);
    const health = await fetch(r.handle.url + '/__pyric/health');
    expect(health.status).toBe(200);
    const body = (await health.json()) as { mode: string; sandboxConnected?: boolean };
    expect(body.mode).toBe('sandbox');

    // runtime.mcpUrl is clean (no ?token= query parameter; token lives in 0o600 .pyric/serve.json)
    expect(r.mcpUrl).toBe(r.handle.url + '/__pyric/mcp');

    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json', {
      headers: { 'x-pyric-session-token': r.sessionToken },
    })).json()) as { bridgeUrl: string };
    expect(payload.bridgeUrl).toBe(`ws://localhost:${r.handle.port}/__pyric/sandbox`);
  });

  it('answers a real MCP handshake over HTTP: initialize THEN tools/list', async () => {
    // The mount is STATEFUL: initialize issues an `Mcp-Session-Id` and later
    // requests must carry it (the stateless build returned no id, so a client
    // dropped + 404'd on reconnect). The SECOND request (tools/list) is the
    // regression guard, and it must thread the session id + send the
    // `notifications/initialized` the protocol requires before tool calls.
    const r = await serve(true);
    let sessionId: string | undefined;
    const mcp = async (id: number | null, method: string, params: Record<string, unknown> = {}) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const res = await fetch(r.mcpUrl!, {
        method: 'POST',
        headers,
        body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      const text = await res.text();
      if (!text) return { status: res.status, json: null as unknown };
      // streamable HTTP replies as an SSE frame ("data: {json}") or bare json
      const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text;
      return { status: res.status, json: JSON.parse(line.replace(/^data:\s*/, '')) };
    };

    const init = await mcp(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
    });
    expect(init.status).toBe(200);
    expect((init.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('pyric');
    expect(sessionId).toBeTruthy(); // stateful: a session id is issued

    await mcp(null, 'notifications/initialized'); // confirm init before tool calls

    const list = await mcp(2, 'tools/list');
    expect(list.status).toBe(200); // was 500 with the shared transport
    const names = ((list.json as { result: { tools: Array<{ name: string }> } }).result.tools)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...BRIDGE_TOOL_NAMES].sort());
  });

  it('reclaims uninitialized transports and rejects stale session ids without exhausting the cap', async () => {
    const r = await serve(true);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = () => fetch(r.mcpUrl!, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cap-regression', version: '0' },
        },
      }),
    });

    for (let index = 0; index < 64; index += 1) {
      const response = await fetch(r.mcpUrl!, {
        method: 'POST',
        headers,
        body: '{}',
      });
      await response.text();
    }
    const afterInvalid = await initialize();
    expect(afterInvalid.status).toBe(200);
    await afterInvalid.text();

    for (let index = 0; index < 64; index += 1) {
      const response = await fetch(r.mcpUrl!, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': `stale-${index}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: index + 10, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(404);
      await response.text();
    }
    const afterStale = await initialize();
    expect(afterStale.status).toBe(200);
    await afterStale.text();
  });

  it('accepts a loopback WS sandbox peer without token on the serve origin and refuses foreign Origins', async () => {
    const r = await serve(true);
    const foreignWs = new WebSocket(`ws://localhost:${r.handle.port}/__pyric/sandbox`, {
      headers: { Origin: 'http://evil.example' },
    });
    const foreignOpened = await new Promise<boolean>((resolve) => {
      foreignWs.once('open', () => resolve(true));
      foreignWs.on('error', () => resolve(false));
      foreignWs.once('close', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    expect(foreignOpened).toBe(false);

    const ws = new WebSocket(`ws://localhost:${r.handle.port}/__pyric/sandbox`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    expect(opened).toBe(true);
    ws.close();
  });

  it('without --bridge: routes 404 and the payload carries no bridgeUrl', async () => {
    const r = await serve(false);
    expect((await fetch(r.handle.url + '/__pyric/health')).status).toBe(404);
    // POST falls past the (GET-only) sdk namespace into the static server's
    // method gate — 405, not 404. Either way: no bridge surface.
    expect((await fetch(r.handle.url + '/__pyric/mcp', { method: 'POST', body: '{}' })).status).toBe(405);
    const payload = (await (
      await fetch(r.handle.url + '/__pyric/init.json', {
        headers: { 'x-pyric-session-token': r.sessionToken },
      })
    ).json()) as { bridgeUrl: null };
    expect(payload.bridgeUrl).toBeNull();
  });

  it('sdk routes still work alongside the bridge tier', async () => {
    const r = await serve(true);
    expect((await fetch(r.handle.url + '/__pyric/sdk/auth.js')).status).toBe(200);
    expect((await fetch(r.handle.url + '/__pyric/init.json')).status).toBe(200);
  });
});

class FakeServer extends EventEmitter {
  listening = false;

  address(): { port: number } {
    return { port: 4321 };
  }
}

describe('hosted bridge lifecycle', () => {
  // A second server in the same project (a mistyped `pyric sandbox <method>`
  // starts one) must not replace the pointer of a host that is still running.
  function attachOver(existing: Record<string, unknown> | string): { pointer: string; warnings: string[]; close: () => Promise<void>; cleanup: () => void } {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-pointer-'));
    const pointer = join(projectDir, '.pyric', 'serve.json');
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, typeof existing === 'string' ? existing : JSON.stringify(existing));
    const server = new FakeServer();
    server.listening = true;
    const warnings: string[] = [];
    const mount = createBridgeMount({ disableAuditLog: true });
    mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4322 }),
      collision: { warn: (message) => warnings.push(message), fetchImpl: async () => new Response('', { status: 404 }) },
    });
    return {
      pointer,
      warnings,
      close: () => mount.close(),
      cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
    };
  }

  /** A loopback server that answers `/__pyric/health` as the sandbox `instanceId`. */
  async function answeringHost(instanceId: string): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ mode: 'sandbox', instanceId }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  /** Waits for the mount's verdict on a held pointer, which follows a health probe. */
  async function settled(warnings: string[]): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (warnings.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('leaves a running host\'s pointer in place, warns, and keeps it after closing', async () => {
    const host = await answeringHost('running-host');
    const live = { url: `http://localhost:${host.port}`, port: host.port, pid: process.ppid, instanceId: 'running-host' };
    const { pointer, warnings, close, cleanup } = attachOver(live);
    await settled(warnings);
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual(live);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`http://localhost:${host.port}`);
    expect(warnings[0]).toContain('http://localhost:4322');
    await close();
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual(live);
    await host.close();
    cleanup();
  });

  // An orphaned sandbox can keep running after it stops listening (#1641).
  it('replaces a running process\'s pointer when nothing answers on its port', async () => {
    const port = await closedPort();
    const orphan = { url: `http://localhost:${port}`, port, pid: process.ppid, instanceId: 'orphaned-host' };
    const { pointer, warnings, close, cleanup } = attachOver(orphan);
    await settled(warnings);
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toMatchObject({ url: 'http://localhost:4322', pid: process.pid });
    expect(warnings).toHaveLength(1);
    await close();
    expect(existsSync(pointer)).toBe(false);
    cleanup();
  });

  it('replaces a running process\'s pointer when another sandbox answers on its port', async () => {
    const host = await answeringHost('a-different-host');
    const named = { url: `http://localhost:${host.port}`, port: host.port, pid: process.ppid, instanceId: 'running-host' };
    const { pointer, warnings, close, cleanup } = attachOver(named);
    await settled(warnings);
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toMatchObject({ url: 'http://localhost:4322', pid: process.pid });
    await close();
    await host.close();
    cleanup();
  });

  for (const [name, existing] of [
    ['a pointer whose process has exited', { url: 'http://localhost:3473', pid: 2 ** 31 - 2, instanceId: 'gone' }],
    ['a pointer without a pid', { url: 'http://localhost:3473', instanceId: 'no-pid' }],
    ['a pointer this process wrote for an earlier mount', { url: 'http://localhost:3473', pid: process.pid, instanceId: 'earlier' }],
    ['a malformed pointer', '{not json'],
  ] as const) {
    it(`replaces ${name}`, async () => {
      const { pointer, warnings, close, cleanup } = attachOver(existing as Record<string, unknown> | string);
      expect(JSON.parse(readFileSync(pointer, 'utf8'))).toMatchObject({ url: 'http://localhost:4322', pid: process.pid });
      expect(warnings).toHaveLength(0);
      await close();
      cleanup();
    });
  }

  it('publishes one canonical identity and removes only its own discovery pointer', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-host-'));
    const pointer = join(projectDir, '.pyric', 'serve.json');
    const server = new FakeServer();
    const mount = createBridgeMount({ project: 'demo-project', disableAuditLog: true });

    const attachment = mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
    });

    expect(server.listenerCount('upgrade')).toBe(1);
    expect(server.listenerCount('listening')).toBe(1);
    server.listening = true;
    server.emit('listening');

    const published = JSON.parse(readFileSync(pointer, 'utf8')) as {
      instanceId: string;
      project: string;
      url: string;
      mcpUrl: string;
      token: string;
    };
    expect(published).toMatchObject({
      instanceId: mount.instanceId,
      project: mount.project,
      url: 'http://localhost:4321',
      mcpUrl: mount.mcpUrl({ host: 'localhost', port: 4321 }),
      token: mount.sessionToken,
    });

    writeFileSync(pointer, JSON.stringify({ ...published, instanceId: 'new-owner' }));
    await attachment.close();
    await attachment.close();

    expect(existsSync(pointer)).toBe(true);
    expect(server.listenerCount('upgrade')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
    expect(server.listenerCount('close')).toBe(0);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('closes all host attachments through an idempotent mount close', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-close-'));
    const pointer = join(projectDir, '.pyric', 'serve.json');
    const server = new FakeServer();
    server.listening = true;
    const mount = createBridgeMount({ disableAuditLog: true });

    mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
    });
    expect(existsSync(pointer)).toBe(true);

    await mount.close();
    await mount.close();

    expect(existsSync(pointer)).toBe(false);
    expect(server.listenerCount('upgrade')).toBe(0);
    expect(server.listenerCount('close')).toBe(0);
    rmSync(dirname(pointer), { recursive: true, force: true });
  });

  it('warns when the other loopback family answers with a foreign bridge', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-collision-'));
    const server = new FakeServer();
    server.listening = true;
    const warnings: string[] = [];
    const mount = createBridgeMount({ disableAuditLog: true });
    mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
      collision: {
        warn: (message) => warnings.push(message),
        fetchImpl: async () => new Response(JSON.stringify({
          mode: 'sandbox',
          instanceId: 'foreign-instance',
        }), { status: 200 }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('different loopback family');
    await mount.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('aborts and settles an in-flight collision probe before attachment close completes', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-collision-close-'));
    const server = new FakeServer();
    server.listening = true;
    const warnings: string[] = [];
    let probeSignal: AbortSignal | undefined;
    let releaseProbe!: () => void;
    let probeCalls = 0;
    const mount = createBridgeMount({ disableAuditLog: true });
    const attachment = mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
      collision: {
        warn: (message) => warnings.push(message),
        fetchImpl: async (_input, init) => {
          probeCalls += 1;
          probeSignal = init?.signal ?? undefined;
          await new Promise<void>((resolve) => { releaseProbe = resolve; });
          return new Response(JSON.stringify({
            mode: 'sandbox',
            instanceId: 'replacement-instance',
          }), { status: 200 });
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probeCalls).toBe(1);

    const closing = attachment.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probeSignal?.aborted).toBe(true);
    releaseProbe();
    await closing;

    expect(probeCalls).toBe(1);
    expect(warnings).toHaveLength(0);
    await mount.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('threads liveHost.sessionData into startHostedSandbox so observed live calls evaluate local rules (#2540)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-live-session-'));
    const liveHost = createLiveHostState({
      configProjectId: 'demo-project',
      configSource: 'option',
      optionName: '--project',
      warn: () => {},
      unobserved: () => [],
    });
    const mount = createBridgeMount({
      project: 'demo-project',
      projectKey: projectDir,
      liveHost,
      disableAuditLog: true,
    });
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-bridge-live-${Math.random()}`),
      checkpoints: {},
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    };

    try {
      await mount.startHostedSandbox(
        {
          rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /groups/{g}/posts/{p} {
      allow create: if request.auth != null
        && request.auth.uid in get(/databases/$(database)/documents/groups/$(g)).data.members;
    }
  }
}`,
          rulesHash: null,
          bridgeUrl: null,
          seed: null,
          capture: false,
          hosted: true,
          permissive: false,
          projectKey: projectDir,
          sessionToken: 'tok-bridge-live',
          appOptions: { projectId: 'demo-project' },
        },
        'http://127.0.0.1:4321',
        { persistence: persistence as never, record: false },
      );

      liveHost.sessionData.apply(
        { firestore: [{ kind: 'set', path: 'groups/g-1', data: { members: ['u-1'] } }] },
        'demo-project',
        'client',
      );
      expect(liveHost.sessionData.getFirestoreDoc('groups/g-1')).toEqual({
        status: 'complete',
        data: { members: ['u-1'] },
      });
    } finally {
      await mount.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('refuses inProcess write and identity-switch tools on /__pyric/mcp in Live Mode and stamps mode: live on envelopes and events.ndjson', async () => {
    const projectDir = fixtureProject();
    const uniqueProject = `live-audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const auditProjectDir = join(homedir(), '.pyric', 'projects', uniqueProject);
    const liveHost = createLiveHostState({
      configProjectId: uniqueProject,
      configSource: 'option',
      optionName: '--project',
      warn: () => {},
      unobserved: () => [],
    });
    const mount = createBridgeMount({
      project: uniqueProject,
      projectKey: projectDir,
      liveHost,
    });
    const httpServer: Server = createServer((req, res) => {
      void mount.handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const attachment = mount.attachHost({
      servers: [httpServer],
      projectDir,
      origin: () => ({ host: '127.0.0.1', port }),
    });
    const mcpUrl = mount.mcpUrl({ host: '127.0.0.1', port });
    let tabWs: WebSocket | null = null;

    async function callMcpTool(sessionId: string, id: number, name: string, args: Record<string, unknown>) {
      const response = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'x-pyric-session-token': mount.sessionToken,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const text = await response.text();
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
      const payload = JSON.parse(dataLine ? dataLine.slice(6) : text) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      const rawContent = payload.result.content[0]!.text;
      return {
        isError: payload.result.isError === true,
        envelope: JSON.parse(rawContent) as Record<string, unknown>,
      };
    }

    try {
      const initRes = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-pyric-session-token': mount.sessionToken,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'bridge-mount-test', version: '1.0.0' },
          },
        }),
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      expect(typeof sessionId).toBe('string');

      const captureFixture = JSON.stringify({
        schema: 'pyric.rate-capture.v1',
        createdAt: '2026-09-15T00:00:00Z',
        frame: {
          service: { service: 'rtdb', coverage: 'partial', observed: true, untrackedMethods: [], methods: [] },
          points: [{ second: 10, reads: 1, writes: 1, deletes: 0, deliveries: 0 }],
          to: 10,
          duration: 1,
          clockOffset: 1000,
          totals: { reads: 1, writes: 1, deletes: 0, deliveries: 0 },
          peaks: { reads: 1, writes: 1, deletes: 0, deliveries: 0 },
          from: 10,
        },
        thresholds: {},
      });
      const refusedTools: Array<[string, Record<string, unknown>]> = [
        ['auth_impersonate', { uid: 'u-1' }],
        ['auth_reset', {}],
        ['sandbox_save_capture', { capture: captureFixture }],
        ['sandbox_rename_capture', { id: 'cap-1', name: 'cap-2' }],
        ['sandbox_delete_capture', { id: 'cap-1', confirm: true }],
      ];
      let reqId = 2;
      for (const [toolName, toolArgs] of refusedTools) {
        const res = await callMcpTool(sessionId!, reqId++, toolName, toolArgs);
        expect(res.isError).toBe(true);
        expect(res.envelope.ok).toBe(false);
        expect((res.envelope.data as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');
        expect((res.envelope._pyric as { mode?: string })?.mode).toBe('live');
      }
      expect(existsSync(join(projectDir, '.pyric', 'captures'))).toBe(false);

      tabWs = new WebSocket(
        `ws://127.0.0.1:${port}/__pyric/sandbox`,
        {
          headers: { Origin: origin, 'x-pyric-session-token': mount.sessionToken },
        },
      );
      await new Promise<void>((resolve, reject) => {
        tabWs!.once('open', () => resolve());
        tabWs!.once('error', reject);
      });
      let resolveAck!: () => void;
      const ackPromise = new Promise<void>((resolve) => {
        resolveAck = resolve;
      });
      tabWs.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type?: string; id?: string; name?: string };
        if (msg.type === 'attach-ack') resolveAck();
        if (msg.type === 'tool-call' && msg.name === 'firestore_get_document') {
          tabWs!.send(
            JSON.stringify({
              type: 'tool-result',
              id: msg.id,
              ok: true,
              result: {
                ok: true,
                summary: 'Got users/ada',
                data: {
                  path: 'users/ada',
                  exists: true,
                  fields: {
                    email: 'ada@example.test',
                    role: 'admin',
                  },
                },
              },
            }),
          );
        }
      });
      tabWs.send(
        JSON.stringify({
          type: 'attach',
          protocol: 1,
          transport: 'worker-port',
          hostInstanceId: mount.instanceId,
          clientInfo: { platform: 'browser', deviceLabel: 'tab-live' },
        }),
      );
      await ackPromise;
      tabWs.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          sandboxId: 'tab-live',
          tools: ['firestore_get_document'],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const readRes = await callMcpTool(sessionId!, reqId++, 'firestore_get_document', {
        path: 'users/ada',
      });
      expect(readRes.isError).toBe(false);
      expect(readRes.envelope.ok).toBe(true);
      expect((readRes.envelope._pyric as { mode?: string })?.mode).toBe('live');

      const auditFile = join(auditProjectDir, 'events.ndjson');
      expect(existsSync(auditFile)).toBe(true);
      const auditLines = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(auditLines.every((entry) => entry.mode === 'live')).toBe(true);
      const readEvent = auditLines.find((entry) => entry.tool === 'firestore_get_document');
      expect(readEvent?.result).toEqual({
        ok: true,
        summary: 'Got users/ada',
        data: {
          path: 'users/ada',
          exists: true,
          fields: {
            email: 'ada@example.test',
            role: 'admin',
          },
        },
      });
    } finally {
      if (tabWs !== null) tabWs.close();
      await attachment.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await mount.close();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(auditProjectDir, { recursive: true, force: true });
    }
  });
});
