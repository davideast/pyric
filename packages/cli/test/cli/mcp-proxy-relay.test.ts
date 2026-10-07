/**
 * The attach relay of `pyric mcp`, driven end to end against fake sandboxes
 * that speak the Streamable HTTP wire shape: which sandbox the relay targets,
 * and what it does after the sandbox it attached to stops answering.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { runMcpProxy } from '../../src/cli/mcp-proxy.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import type { Discovered } from '../../src/serve/discovery.js';

interface FakeSandbox {
  port: number;
  instanceId: string;
  projectDir: string;
  /** Tool names received by `tools/call`. */
  calls: string[];
  /** Project header values seen on requests. */
  projectHeaders: string[];
  stop(): Promise<void>;
}

const running: FakeSandbox[] = [];

async function fakeSandbox(instanceId: string, projectDir: string): Promise<FakeSandbox> {
  const sessions = new Set<string>();
  const calls: string[] = [];
  const projectHeaders: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(req.method === 'GET' ? 405 : 200).end();
        return;
      }
      const header = req.headers['x-pyric-project-dir'];
      if (typeof header === 'string') projectHeaders.push(decodeURIComponent(header));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
        res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(payload));
      if (body.method === 'initialize') {
        const id = `${instanceId}-${sessions.size}`;
        sessions.add(id);
        return reply(
          200,
          {
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: instanceId, version: '0' } },
          },
          { 'mcp-session-id': id },
        );
      }
      const session = req.headers['mcp-session-id'];
      if (typeof session !== 'string' || !sessions.has(session)) return reply(404, { error: 'MCP session not found' });
      if (body.id === undefined) return res.writeHead(202).end();
      if (body.method === 'tools/call') calls.push(body.params.name);
      return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: instanceId }] } });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const sandbox: FakeSandbox = {
    port: (server.address() as AddressInfo).port,
    instanceId,
    projectDir,
    calls,
    projectHeaders,
    stop: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
  running.push(sandbox);
  return sandbox;
}

function pointerTo(s: FakeSandbox): Discovered {
  return {
    pointerProjectDir: s.projectDir,
    mcpUrl: `http://127.0.0.1:${s.port}/__pyric/mcp`,
    url: `http://localhost:${s.port}`,
    base: `http://127.0.0.1:${s.port}`,
    instanceId: s.instanceId,
    source: `pointer ${s.projectDir}/.pyric/serve.json`,
  };
}

/** A stdio peer the test drives by hand. */
function fakeStdio() {
  const waiting = new Map<number, (m: any) => void>();
  const stdio = {
    onmessage: undefined as ((m: any) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    async start() {},
    async close() {},
    async send(m: any) {
      waiting.get(m.id)?.(m);
    },
  };
  let nextId = 1;
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      stdio.onmessage!({ jsonrpc: '2.0', id, method, params });
    });
  const notify = (method: string) => stdio.onmessage!({ jsonrpc: '2.0', method });
  return { stdio, request, notify };
}

async function startRelay(discover: () => Promise<Discovered | null>) {
  const peer = fakeStdio();
  const exit = runMcpProxy(parseArgs(['mcp', '--attach']), '/workspace', {
    discover,
    stdio: peer.stdio,
    inProcess: async () => {
      throw new Error('the relay must not fall back to an in-process sandbox');
    },
    env: {},
  });
  // The relay installs its handler once the SDK transports have loaded.
  while (peer.stdio.onmessage === undefined) await new Promise((r) => setTimeout(r, 5));
  const initialize = await peer.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  peer.notify('notifications/initialized');
  expect(initialize.result).toBeDefined();
  return {
    request: peer.request,
    close: async () => {
      peer.stdio.onclose?.();
      await exit;
    },
  };
}

const call = (relay: { request: (m: string, p?: unknown) => Promise<any> }, name: string) =>
  relay.request('tools/call', { name, arguments: {} });

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

describe('which sandbox the relay targets', () => {
  it('sends every call to the sandbox the workspace pointer names, never to another sandbox', async () => {
    const mine = await fakeSandbox('instance-mine', '/workspace/app');
    const other = await fakeSandbox('instance-other', '/elsewhere/app');
    const relay = await startRelay(async () => pointerTo(mine));

    const reply = await call(relay, 'sandbox_inspect');
    expect(reply.result.content[0].text).toBe('instance-mine');
    expect(mine.calls).toEqual(['sandbox_inspect']);
    expect(mine.projectHeaders.every((p) => p === '/workspace/app')).toBe(true);
    expect(other.calls).toEqual([]);
    await relay.close();
  });
});

describe('recovery after the sandbox stops answering', () => {
  it('reports the interrupted call as failed with an unknown outcome and does not replay it', async () => {
    const first = await fakeSandbox('instance-1', '/workspace/app');
    let current: FakeSandbox | null = first;
    const relay = await startRelay(async () => (current ? pointerTo(current) : null));
    expect((await call(relay, 'before')).result).toBeDefined();

    await first.stop();
    const second = await fakeSandbox('instance-2', '/workspace/app');
    current = second;

    const interrupted = await call(relay, 'interrupted');
    expect(interrupted.error.message).toContain('outcome is unknown');
    expect(second.calls).toEqual([]);

    const next = await call(relay, 'after');
    expect(next.result.content[0].text).toBe('instance-2');
    expect(second.calls).toEqual(['after']);
    await relay.close();
  });

  it('refuses a sandbox of another project that took over after the original stopped', async () => {
    const first = await fakeSandbox('instance-1', '/workspace/app');
    let current: FakeSandbox | null = first;
    const relay = await startRelay(async () => (current ? pointerTo(current) : null));
    await first.stop();
    await call(relay, 'probe');
    const squatter = await fakeSandbox('instance-other', '/elsewhere/app');
    current = squatter;

    const refused = await call(relay, 'after');
    expect(refused.error.message).toContain('not the sandbox this session attached to');
    expect(squatter.calls).toEqual([]);
    await relay.close();
  });

  it('says so when no sandbox answers, and recovers once one does', async () => {
    const first = await fakeSandbox('instance-1', '/workspace/app');
    let current: FakeSandbox | null = first;
    const relay = await startRelay(async () => (current ? pointerTo(current) : null));
    await first.stop();
    current = null;
    await call(relay, 'probe');

    const none = await call(relay, 'none');
    expect(none.error.message).toContain('no running sandbox for this project');

    current = await fakeSandbox('instance-2', '/workspace/app');
    expect((await call(relay, 'later')).result.content[0].text).toBe('instance-2');
    await relay.close();
  });
});
