/** Real Vite/peer/MCP integration, enabled with PYRIC_BRIDGE_E2E=1.
 * Vite runs in a Node child; Bun drives the public HTTP and WebSocket interfaces.
 * Startup and shutdown are bounded, and teardown failure fails the suite.
 * Build the CLI first. PYRIC_TEST_NODE optionally selects the Node executable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path, { join } from 'node:path';
import { homedir } from 'node:os';
import { initializeSandbox } from 'pyric/sandbox';
import { connectBridge, type ConnectedBridge } from '../../src/bridge/client/bridge.js';
import { BRIDGE_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';
import { defaultSdkEntries, bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
import { startViteNodeHost, type ViteNodeHost } from './vite-node-host.js';
import { z } from 'zod';
import { InitializeResultSchema, JSONRPCResponseSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

const GATED = !process.env.PYRIC_BRIDGE_E2E;
const entries = defaultSdkEntries();

// Race any promise against a rejecting timer so nothing awaits forever.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[e2e] timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), guard]);
}

// A fetch that CANNOT hang: AbortController tears the socket down at `ms`, so a
// refused/half-open loopback connection rejects fast instead of blocking forever.
async function fetchSafe(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}


describe.skipIf(GATED)('e2e — bridge through a real vite dev server (GATED: PYRIC_BRIDGE_E2E)', () => {
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let server: ViteNodeHost | null = null;
  let peer: ConnectedBridge | null = null;
  let port = 0;

  beforeAll(async () => {
    // Warm the worker bundle FIRST (local esbuild — slow on a cold cache but not a
    // hang risk), so the watchdog window only covers the dangerous network phase.
    await withTimeout(
      bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) }),
      180_000,
      'bundleWorker (cold cache)',
    );

    // The ultimate "can't run for 6 hours" backstop: even if every per-op timeout
    // below somehow fails to fire, force-exit the process at 90s. .unref() so the
    // timer never keeps the loop alive on its own (a clean run clears it in afterAll).
    watchdog = setTimeout(() => {
      console.error('[e2e] WATCHDOG: hard bail at 90s — forcing process.exit(1)');
      process.exit(1);
    }, 90_000);
    watchdog.unref?.();

    server = await startViteNodeHost(path.dirname(entries.init));
    port = server.port;

    // A cold Vite dev server isn't ready to serve the instant listen() resolves
    // (first-request warmup) — the first MCP fetch would get an empty body and the
    // WS peer would race a half-ready server. Poll the serve readiness contract
    // (GET /__pyric/init.json) until it answers. Bounded, so it can't hang.
    await withTimeout(waitReady(), 12_000, 'waitReady');
  }, 200_000);

  async function waitReady(deadlineMs = 10_000): Promise<void> {
    const start = Date.now();
    let lastErr: unknown = 'no attempt';
    let hasTimeRemaining = true;
    while (hasTimeRemaining) {
      try {
        const res = await fetchSafe(base() + '/__pyric/init.json', {}, 2000);
        const isReady = res.status === 200;
        if (isReady) { await res.text(); return; }
        lastErr = `status ${res.status}`;
      } catch (error) {
        const isError = error instanceof Error;
        lastErr = isError ? error.message : String(error);
      }
      await new Promise((r) => setTimeout(r, 200));
      hasTimeRemaining = Date.now() - start < deadlineMs;
    }
    throw new Error(`[e2e] dev server not ready within ${deadlineMs}ms: ${lastErr}`);
  }

  afterAll(async () => {
    try {
      peer?.disconnect();
    } finally {
      try {
        await server?.close();
      } finally {
        const activeWatchdog = watchdog;
        const hasWatchdog = activeWatchdog !== null;
        if (hasWatchdog) clearTimeout(activeWatchdog);
      }
    }
  }, 15_000);

  const base = (): string => `http://localhost:${port}`;
  const createMcpSession = () => {
    let sessionId: string | null = null;
    const request = async (
      id: number | null,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      const activeSessionId = sessionId;
      const hasSession = activeSessionId !== null;
      if (hasSession) headers['mcp-session-id'] = activeSessionId;
      const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
      const isRequest = id !== null;
      if (isRequest) body.id = id;
      const res = await fetchSafe(base() + '/__pyric/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      sessionId = res.headers.get('mcp-session-id') ?? sessionId;
      const text = await res.text();
      const hasNoBody = text.length === 0;
      if (hasNoBody) return { status: res.status, json: null };
      const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
      const json = JSONRPCResponseSchema.parse(JSON.parse(line.replace(/^data:\s*/, '')));
      const hasError = 'error' in json;
      if (hasError) throw new Error(json.error.message);
      return { status: res.status, json };
    };
    const initialize = async () => {
      const response = await request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      });
      await request(null, 'notifications/initialized');
      return response;
    };
    return { initialize, request };
  };

  it('serves health + an absolute bridgeUrl carrying the bound port', async () => {
    const health = z.object({ mode: z.string(), status: z.string() }).parse(
      await (await fetchSafe(base() + '/__pyric/health')).json(),
    );
    expect(health.mode).toBe('sandbox');
    expect(health.status).toBe('ok');
    const payload = z.object({ bridgeUrl: z.string() }).parse(
      await (await fetchSafe(base() + '/__pyric/init.json')).json(),
    );
    expect(payload.bridgeUrl).toBe(`ws://localhost:${port}/__pyric/sandbox`);
  }, 30_000);

  it('answers a real MCP handshake over HTTP: initialize THEN tools/list', async () => {
    const mcp = createMcpSession();
    const init = await mcp.initialize();
    expect(init.status).toBe(200);
    expect(InitializeResultSchema.parse(init.json?.result).serverInfo.name).toBe('pyric');
    const list = await mcp.request(2, 'tools/list');
    expect(list.status).toBe(200);
    expect(
      ListToolsResultSchema.parse(list.json?.result).tools.map(tool => tool.name).sort(),
    ).toEqual([...BRIDGE_TOOL_NAMES].sort());
  }, 30_000);

  it('round-trips a tool call MCP → bridge → real connectBridge sandbox peer → back', async () => {
    // The genuinely end-to-end assertion: a real browser-side sandbox peer connects
    // over the WS the plugin's attachUpgrade mounted, and a forwarded tool call
    // actually executes against it (rather than erroring "sandbox not connected").
    const sandbox = initializeSandbox();
    const connected = new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('[e2e] peer never reached "connected"')), 8000);
      peer = connectBridge(sandbox, {
        url: `ws://localhost:${port}/__pyric/sandbox`,
        noReconnect: true, // no infinite reconnect loop — bail-friendly
        onStateChange: (state) => {
          const isConnected = state.kind === 'connected';
          if (isConnected) { clearTimeout(to); resolve(); }
        },
      });
    });
    await withTimeout(connected, 9000, 'peer connect');

    // Pick a forwarded sandbox tool from the live list (name may be prefixed).
    const mcp = createMcpSession();
    await mcp.initialize();
    const list = await mcp.request(10, 'tools/list');
    const inspect = ListToolsResultSchema.parse(list.json?.result).tools.find(tool => tool.name.includes('inspect'));
    const hasNoInspectTool = inspect === undefined;
    if (hasNoInspectTool) throw new Error('MCP did not advertise an inspect tool');

    const call = await mcp.request(11, 'tools/call', { name: inspect.name, arguments: {} });
    expect(call.status).toBe(200);
    // The request helper rejects JSON-RPC error responses.
    expect(call.json?.result).toBeTruthy();
  }, 30_000);
});
