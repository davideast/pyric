/** `--bridge` mount (plan steps 2.2/2.3) — real HTTP/WS against startServe. */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';

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

describe('pyric serve --bridge', () => {
  it('mounts health + advertises the ws URL in the init payload', async () => {
    const r = await serve(true);
    const health = await fetch(r.handle.url + '/__pyric/health');
    expect(health.status).toBe(200);
    const body = (await health.json()) as { mode: string; sandboxConnected?: boolean };
    expect(body.mode).toBe('sandbox');

    // runtime.mcpUrl carries the BOUND port (the serve --json contract)
    expect(r.mcpUrl).toBe(r.handle.url + '/__pyric/mcp');

    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { bridgeUrl: string };
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
    const names = ((list.json as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.includes('inspect'))).toBe(true); // sandbox_inspect forwarded
  });

  it('accepts a WS sandbox peer on the serve origin', async () => {
    const r = await serve(true);
    const ws = new WebSocket(`ws://localhost:${r.handle.port}/__pyric/sandbox`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
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
    const payload = (await (await fetch(r.handle.url + '/__pyric/init.json')).json()) as { bridgeUrl: null };
    expect(payload.bridgeUrl).toBeNull();
  });

  it('sdk routes still work alongside the bridge tier', async () => {
    const r = await serve(true);
    expect((await fetch(r.handle.url + '/__pyric/sdk/auth.js')).status).toBe(200);
    expect((await fetch(r.handle.url + '/__pyric/init.json')).status).toBe(200);
  });
});
