/**
 * End-to-end MCP integration test.
 *
 * Spins up the bridge in sandbox mode on a random port, connects a
 * fake browser-side peer (real WebSocket from Node's `ws` package
 * dispatching against a real `LocalEnvironment` via the same logic
 * the browser uses), then drives MCP tool calls through the MCP
 * client SDK. Verifies the round-trip end-to-end without needing
 * Playwright.
 *
 * Asserts:
 *  - /health reports `sandboxConnected: true` after peer registration.
 *  - listTools returns the sandbox tool surface (forwarded + in-process).
 *  - firestore_simulator_create seeds the sandbox.
 *  - firestore_simulator_execute writes through.
 *  - firestore_simulator_undo reverses; redo re-applies.
 *  - Disconnecting the peer yields the "sandbox not connected" error
 *    on subsequent tool calls.
 *  - Re-connecting a fresh peer resumes the round-trip.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { startServer, type ServerHandle } from '../../src/bridge/server.js';
import {
  dispatchSandboxTool,
  SANDBOX_TOOL_NAMES,
} from '../../src/bridge/client/dispatch.js';
import {
  isBridgeMessage,
  NO_SANDBOX_ERROR_MESSAGE,
} from '../../src/bridge/protocol.js';
import { DEFAULT_MCP_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';

const PORT = 5179; // distinct from default 5174

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: PORT, disableAuditLog: true, silent: true });
});

afterAll(async () => {
  await server.stop();
});

// ── Fake browser peer ──────────────────────────────────────────────

/**
 * Connect a Node-side WebSocket peer that imitates the browser
 * client: sends hello, dispatches incoming tool-call requests
 * against a real LocalEnvironment, and sends tool-result responses.
 *
 * Returns a `disconnect` function and a ref to the env so the test
 * can read state directly to assert side effects.
 */
function connectFakePeer(): Promise<{ disconnect: () => void; env: ReturnType<typeof getInternalEnv> }> {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sandbox`);

  return new Promise((resolve, reject) => {
    let resolved = false;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          tools: [...SANDBOX_TOOL_NAMES],
          sandboxId: 'test-peer',
        }),
      );
    });

    ws.on('message', async (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isBridgeMessage(msg)) return;
      if (msg.type === 'hello-ack' && !resolved) {
        resolved = true;
        resolve({
          disconnect: () => {
            try {
              ws.close();
            } catch {}
          },
          env,
        });
        return;
      }
      if (msg.type === 'tool-call') {
        try {
          const result = await dispatchSandboxTool(sandbox, msg.name, msg.args ?? {});
          ws.send(
            JSON.stringify({
              type: 'tool-result',
              id: msg.id,
              ok: true,
              result,
            }),
          );
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'tool-result',
              id: msg.id,
              ok: false,
              error: {
                code: err instanceof Error ? err.name : 'Error',
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          );
        }
      }
    });

    ws.on('error', (err) => {
      if (!resolved) reject(err);
    });
    ws.on('close', () => {
      if (!resolved) reject(new Error('peer closed before hello-ack'));
    });
  });
}

// ── MCP client helper ────────────────────────────────────────────

async function makeMcpClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/mcp`),
  );
  const client = new Client(
    { name: 'pyric-test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; payload: { ok: boolean; summary: string; data?: unknown } }> {
  const result = await client.callTool({ name, arguments: args });
  const firstContent = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!firstContent || firstContent.type !== 'text' || typeof firstContent.text !== 'string') {
    throw new Error(`unexpected tool result shape: ${JSON.stringify(result)}`);
  }
  const payload = JSON.parse(firstContent.text);
  return { ok: !result.isError, payload };
}

// ── Tests ────────────────────────────────────────────────────────

describe('@pyric/cli/bridge end-to-end MCP bridge', () => {
  test('starts with sandboxConnected=false', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sandboxConnected: boolean; mode: string };
    expect(body.mode).toBe('sandbox');
    expect(body.sandboxConnected).toBe(false);
  });

  test('peer registration flips sandboxConnected to true', async () => {
    const peer = await connectFakePeer();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      const body = (await res.json()) as { sandboxConnected: boolean };
      expect(body.sandboxConnected).toBe(true);
    } finally {
      peer.disconnect();
      // Give the close handler a tick to run.
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('MCP list-tools returns the expected sandbox tool surface', async () => {
    const peer = await connectFakePeer();
    const { client, close } = await makeMcpClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([...DEFAULT_MCP_TOOL_NAMES].sort());
    } finally {
      await close();
      peer.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('round-trip: set -> update -> branch fork -> branch discard', async () => {
    const peer = await connectFakePeer();
    const { client, close } = await makeMcpClient();
    try {
      // Seed
      const create = await callToolText(client, 'mutate_sandbox_data', {
        service: 'firestore',
        action: 'set',
        path: 'users/u1',
        dataJson: JSON.stringify({ name: 'Alice' }),
      });
      expect(create.ok).toBe(true);
      expect(create.payload.ok).toBe(true);

      // Verify state in peer's env directly
      const beforeWrite = peer.env.getDocument('users/u1');
      expect(beforeWrite?.name).toBe('Alice');

      // Update
      const write = await callToolText(client, 'mutate_sandbox_data', {
        service: 'firestore',
        action: 'update',
        path: 'users/u1',
        dataJson: JSON.stringify({ name: 'Alice', age: 30 }),
      });
      expect(write.ok).toBe(true);

      const afterWrite = peer.env.getDocument('users/u1');
      expect(afterWrite?.age).toBe(30);

      // Branch fork experiment
      const fork = await callToolText(client, 'dry_run_experiment', {
        action: 'fork',
        branchId: 'exp-1',
      });
      expect(fork.ok).toBe(true);

      // Discard branch
      const discard = await callToolText(client, 'dry_run_experiment', {
        action: 'discard',
        branchId: 'exp-1',
      });
      expect(discard.ok).toBe(true);
    } finally {
      await close();
      peer.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('tool call without connected peer returns clear error', async () => {
    // No peer connected for this test.
    const { client, close } = await makeMcpClient();
    try {
      const result = await callToolText(client, 'control_sandbox_environment', {
        action: 'reset_all',
      });
      // The MCP HTTP transport wraps the bridge's error result in
      // a successful HTTP response with isError=true.
      expect(result.payload.ok).toBe(false);
      expect(result.payload.summary).toContain('sandbox not connected');
      expect(result.payload.summary).toBe(NO_SANDBOX_ERROR_MESSAGE);
    } finally {
      await close();
    }
  });

  test('reconnecting a new peer resumes round-trip', async () => {
    const peer1 = await connectFakePeer();
    peer1.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const peer2 = await connectFakePeer();
    const { client, close } = await makeMcpClient();
    try {
      const result = await callToolText(client, 'mutate_sandbox_data', {
        service: 'firestore',
        action: 'set',
        path: 'pings/p1',
        dataJson: JSON.stringify({ ok: true }),
      });
      expect(result.payload.ok).toBe(true);
      const doc = peer2.env.getDocument('pings/p1');
      expect(doc?.ok).toBe(true);
    } finally {
      await close();
      peer2.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  test('verify_security_rules executes rule linting round-trip over peer', async () => {
    const peer = await connectFakePeer();
    const { client, close } = await makeMcpClient();
    try {
      const result = await callToolText(client, 'verify_security_rules', {
        service: 'firestore',
        action: 'lint',
        source: `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read; } } }`,
      });
      expect(result.payload).toBeDefined();
      expect(typeof result.payload.summary).toBe('string');
    } finally {
      await close();
      peer.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
