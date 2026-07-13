/** Full real-process e2e for the M3 bridge fold — GATED OFF the default CI lane.
 *
 * Runs a REAL Vite dev server (listens on a port), a REAL browser-side
 * `connectBridge` sandbox peer, and a REAL MCP-over-HTTP client, then asserts a
 * tool call round-trips MCP → bridge → sandbox peer → back. This is the one path
 * the handler-based suite can't cover: the WS upgrade, the port-derived
 * `bridgeUrl`, and a live MCP round-trip through the actual plugin in one process.
 *
 * ⚠ WHY GATED + HEAVILY GUARDED: this uses the exact `listen()` + loopback
 * `fetch()` pattern that HUNG CI for 6 HOURS on M2 (bun 1.3.11 Linux — a broken
 * loopback connection blocks, and bun's per-test timeout does NOT interrupt it).
 * So it can NEVER wall-clock CI:
 *   1. The whole suite is SKIPPED unless `PYRIC_BRIDGE_E2E=1` — it never runs in CI.
 *   2. A hard process-level WATCHDOG force-exits at 90s no matter what (armed once
 *      the server phase begins; a clean run clears it in afterAll in a few seconds).
 *   3. Every await — createServer / listen / fetch / peer-connect / teardown — has
 *      its own `withTimeout`, and every fetch uses AbortController so a stuck
 *      socket is actively torn down rather than left blocking.
 *
 * Run locally (macOS):
 *   PYRIC_BRIDGE_E2E=1 bun test test/serve/vite-plugin-bridge-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path, { join } from 'node:path';
import { homedir } from 'node:os';
import { initializeSandbox } from 'pyric/sandbox';
import { connectBridge, type ConnectedBridge } from '../../src/bridge/client/bridge.js';
import { DEFAULT_MCP_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';
import { defaultSdkEntries, bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
import { pyricSandbox } from '../../src/serve/vite-plugin.js';

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

interface DevServer {
  httpServer: { address(): { port: number } | string | null } | null;
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

describe.skipIf(GATED)('e2e — bridge through a real vite dev server (GATED: PYRIC_BRIDGE_E2E)', () => {
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let server: DevServer | null = null;
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
      // eslint-disable-next-line no-console
      console.error('[e2e] WATCHDOG: hard bail at 90s — forcing process.exit(1)');
      process.exit(1);
    }, 90_000);
    watchdog.unref?.();

    const { createServer } = await import('vite');
    server = (await withTimeout(
      createServer({
        configFile: false,
        logLevel: 'silent',
        root: path.dirname(entries.init),
        plugins: [pyricSandbox({ bridge: { disableAuditLog: true } })],
        server: { port: 0, host: 'localhost' },
        optimizeDeps: { noDiscovery: true },
      }),
      30_000,
      'createServer',
    )) as unknown as DevServer;
    await withTimeout(server.listen(), 15_000, 'server.listen');
    const addr = server.httpServer?.address();
    port = addr && typeof addr === 'object' ? addr.port : 0;
    if (!port) throw new Error('[e2e] dev server did not bind a port');

    // A cold Vite dev server isn't ready to serve the instant listen() resolves
    // (first-request warmup) — the first MCP fetch would get an empty body and the
    // WS peer would race a half-ready server. Poll the serve readiness contract
    // (GET /__pyric/init.json) until it answers. Bounded, so it can't hang.
    await withTimeout(waitReady(), 12_000, 'waitReady');
  }, 200_000);

  async function waitReady(deadlineMs = 10_000): Promise<void> {
    const start = Date.now();
    let lastErr: unknown = 'no attempt';
    while (Date.now() - start < deadlineMs) {
      try {
        const res = await fetchSafe(base() + '/__pyric/init.json', {}, 2000);
        if (res.status === 200) { await res.text(); return; }
        lastErr = `status ${res.status}`;
      } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`[e2e] dev server not ready within ${deadlineMs}ms: ${lastErr}`);
  }

  afterAll(async () => {
    try { peer?.disconnect(); } catch { /* best-effort */ }
    if (server) {
      // A hanging close must not wall-clock either — bound it, then move on.
      try { await withTimeout(server.close(), 10_000, 'server.close'); }
      catch (e) { console.error('[e2e]', e instanceof Error ? e.message : e); }
    }
    if (watchdog) clearTimeout(watchdog);
  });

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
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const res = await fetchSafe(base() + '/__pyric/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify(
          id === null
            ? { jsonrpc: '2.0', method, params }
            : { jsonrpc: '2.0', id, method, params },
        ),
      });
      sessionId = res.headers.get('mcp-session-id') ?? sessionId;
      const text = await res.text();
      if (!text) return { status: res.status, json: null as Record<string, any> | null };
      const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
      return {
        status: res.status,
        json: JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, any>,
      };
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
    const health = (await (await fetchSafe(base() + '/__pyric/health')).json()) as { mode: string; status: string };
    expect(health.mode).toBe('sandbox');
    expect(health.status).toBe('ok');
    const payload = (await (await fetchSafe(base() + '/__pyric/init.json')).json()) as { bridgeUrl: string };
    expect(payload.bridgeUrl).toBe(`ws://localhost:${port}/__pyric/sandbox`);
  }, 30_000);

  it('answers a real MCP handshake over HTTP: initialize THEN tools/list', async () => {
    const mcp = createMcpSession();
    const init = await mcp.initialize();
    expect(init.status).toBe(200);
    expect(init.json?.result.serverInfo.name).toBe('pyric');
    const list = await mcp.request(2, 'tools/list');
    expect(list.status).toBe(200);
    expect(
      (list.json?.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort(),
    ).toEqual([...DEFAULT_MCP_TOOL_NAMES].sort());
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
        onStateChange: (s) => { if (s.kind === 'connected') { clearTimeout(to); resolve(); } },
      });
    });
    await withTimeout(connected, 9000, 'peer connect');

    // Pick a forwarded sandbox tool from the live list (name may be prefixed).
    const mcp = createMcpSession();
    await mcp.initialize();
    const list = await mcp.request(10, 'tools/list');
    const inspect = (list.json?.result.tools as Array<{ name: string }>).find((t) => t.name.includes('inspect'));
    expect(inspect).toBeTruthy();

    const call = await mcp.request(11, 'tools/call', { name: inspect!.name, arguments: {} });
    expect(call.status).toBe(200);
    expect(call.json?.error).toBeUndefined(); // forwarded + executed, not "not connected"
    expect(call.json?.result).toBeTruthy();
  }, 30_000);
});
