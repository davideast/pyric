/**
 * The standalone `pyric bridge` has no browser socket (#1468). A page that
 * opens its `/sandbox` socket is closed with a reason that names
 * `pyric sandbox --bridge`, never registered as the sandbox peer, and the
 * real `connectBridge` client stops there instead of reconnecting. The MCP
 * route keeps the tools that run in the bridge process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import WebSocket from 'ws';
import type { LocalSandbox } from 'pyric/sandbox';
import { startServer, type ServerHandle } from '../../src/bridge/server.js';
import { connectBridge, type ConnectedBridgeState } from '../../src/bridge/client/bridge.js';
import {
  NO_BROWSER_PEER_CLOSE_CODE,
  NO_BROWSER_PEER_CLOSE_REASON,
} from '../../src/bridge/protocol.js';
import { BRIDGE_IN_PROCESS_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: 0, disableAuditLog: true, silent: true });
});

afterAll(async () => {
  await server.stop();
});

function sandboxUrl(): string {
  return `ws://127.0.0.1:${server.port}/sandbox`;
}

interface Closed {
  code: number;
  reason: string;
  messages: string[];
}

/** Open the socket as a page on another local port would, say hello, and wait for the close. */
function helloFromPage(): Promise<Closed> {
  const ws = new WebSocket(sandboxUrl(), { headers: { origin: 'http://127.0.0.1:5173' } });
  const messages: string[] = [];
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, tools: [...SANDBOX_TOOL_NAMES], sandboxId: 'page' }));
    });
    ws.on('message', (raw) => messages.push(raw.toString()));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), messages }));
    ws.on('error', reject);
  });
}

async function health(): Promise<{ sandboxConnected: boolean }> {
  const res = await fetch(`${server.url}/health`);
  return (await res.json()) as { sandboxConnected: boolean };
}

describe('pyric bridge has no browser socket', () => {
  it('closes a page that opens /sandbox with a reason naming pyric sandbox --bridge', async () => {
    const closed = await helloFromPage();
    expect(closed.code).toBe(NO_BROWSER_PEER_CLOSE_CODE);
    expect(closed.reason).toBe(NO_BROWSER_PEER_CLOSE_REASON);
    expect(closed.reason).toContain('pyric sandbox --bridge');
    expect(closed.messages).toEqual([]);
    expect((await health()).sandboxConnected).toBe(false);
  });

  it('keeps the close reason inside the 123 bytes a close frame carries', () => {
    expect(new TextEncoder().encode(NO_BROWSER_PEER_CLOSE_REASON).byteLength).toBeLessThanOrEqual(123);
  });

  it('connectBridge stops with that reason and does not reconnect', async () => {
    const states: ConnectedBridgeState[] = [];
    const sandbox = {} as LocalSandbox;
    let bridge: ReturnType<typeof connectBridge> | undefined;
    const settled = new Promise<void>((resolve) => {
      bridge = connectBridge(sandbox, {
        url: sandboxUrl(),
        initialReconnectDelayMs: 10,
        onStateChange: (state) => {
          states.push(state);
          if (state.kind === 'disconnected') resolve();
        },
      });
    });
    const errors: unknown[] = [];
    let finalState: ConnectedBridgeState | undefined;
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      await settled;
      await new Promise((r) => setTimeout(r, 100));
      finalState = bridge?.state();
    } finally {
      console.error = originalError;
      bridge?.disconnect();
    }
    expect(finalState).toEqual({ kind: 'disconnected', reason: NO_BROWSER_PEER_CLOSE_REASON });
    expect(states.some((state) => state.kind === 'connected')).toBe(false);
    expect(states.some((state) => state.kind === 'reconnecting')).toBe(false);
    expect(errors.join('\n')).toContain('pyric sandbox --bridge');
  });

  it('lists only the tools that run in the bridge process on /mcp', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    await init.text();
    const session = { ...headers, 'mcp-session-id': sessionId };
    await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: session,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }).then((res) => res.text());
    const list = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: session,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const text = await list.text();
    const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
    const body = JSON.parse(line.replace(/^data:\s*/, '')) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...BRIDGE_IN_PROCESS_TOOL_NAMES].sort());
  });
});
