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
 *  - listTools returns the folded tool surface (forwarded + in-process).
 *  - firestore_simulator.create seeds the sandbox.
 *  - firestore_simulator.execute writes through.
 *  - firestore_simulator.undo reverses; redo re-applies.
 *  - An unknown op and invalid fields return the structured error.
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
  SANDBOX_OP_KEYS,
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
          tools: [...SANDBOX_OP_KEYS],
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
          const result = await dispatchSandboxTool(sandbox, msg.name, msg.op, msg.args ?? {});
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

  test('round-trip: create → execute → read → undo → redo', async () => {
    const peer = await connectFakePeer();
    const { client, close } = await makeMcpClient();
    try {
      // Seed
      const create = await callToolText(client, 'firestore_simulator', {
        op: 'create',
        rules: `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if true; } } }`,
        documents: { 'users/u1': { name: 'Alice' } },
      });
      expect(create.ok).toBe(true);
      expect(create.payload.ok).toBe(true);

      // Verify state in peer's env directly
      const beforeWrite = peer.env.getDocument('users/u1');
      expect(beforeWrite?.name).toBe('Alice');

      // Write
      const write = await callToolText(client, 'firestore_simulator', {
        op: 'execute',
        method: 'update',
        path: 'users/u1',
        auth: null,
        data: { name: 'Alice', age: 30 },
      });
      expect(write.ok).toBe(true);
      const writeData = write.payload.data as { allowed: boolean };
      expect(writeData.allowed).toBe(true);

      const afterWrite = peer.env.getDocument('users/u1');
      expect(afterWrite?.age).toBe(30);

      // Undo
      const undo = await callToolText(client, 'firestore_simulator', { op: 'undo' });
      expect(undo.ok).toBe(true);
      const undone = peer.env.getDocument('users/u1');
      expect(undone?.age).toBeUndefined();

      // Redo (the previously half-wired tool)
      const redo = await callToolText(client, 'firestore_simulator', { op: 'redo' });
      expect(redo.ok).toBe(true);
      const redone = peer.env.getDocument('users/u1');
      expect(redone?.age).toBe(30);
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
      const result = await callToolText(client, 'firestore_simulator', { op: 'undo' });
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
      const result = await callToolText(client, 'firestore_simulator', {
        op: 'create',
        rules: `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if true; } } }`,
        documents: { 'pings/p1': { ok: true } },
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

  test('rules in-process op executes without a peer (firestore_rules.lint)', async () => {
    // No peer needed — rules tools execute in Node.
    const { client, close } = await makeMcpClient();
    try {
      const result = await callToolText(client, 'firestore_rules', {
        op: 'lint',
        source: `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read; } } }`,
      });
      // The lint tool may report warnings or pass; assert it RAN to
      // completion (data payload present) rather than asserting
      // a specific outcome. The bridge round-trip is what's under test.
      expect(result.payload).toBeDefined();
      expect(typeof result.payload.summary).toBe('string');
    } finally {
      await close();
    }
  });

  test('an unknown op or invalid fields return the structured error, not a protocol error', async () => {
    const { client, close } = await makeMcpClient();
    try {
      const listed = await client.listTools();
      const rules = listed.tools.find((tool) => tool.name === 'firestore_rules')!;
      expect(rules.inputSchema.required).toEqual(['op']);
      expect((rules.inputSchema.properties as { op: { enum: string[] } }).op.enum).toEqual([
        'lint',
        'simulate',
        'resolve',
      ]);

      const unknown = await callToolText(client, 'firestore_rules', { op: 'validate', source: '' });
      expect(unknown.ok).toBe(false);
      expect(unknown.payload.ok).toBe(false);
      expect(unknown.payload.data).toMatchObject({
        error: 'unknown_op',
        tool: 'firestore_rules',
        op: 'validate',
        validOps: ['lint', 'simulate', 'resolve'],
      });

      const invalid = await callToolText(client, 'firestore_rules', { op: 'lint', testCases: [] });
      expect(invalid.ok).toBe(false);
      expect(invalid.payload.summary).toBe(
        "firestore_rules.lint: invalid fields: 'source' is required; 'testCases' is not a field of op 'lint'",
      );
      expect(invalid.payload.data).toMatchObject({
        error: 'invalid_fields',
        fields: [{ name: 'source', required: true, type: 'string' }],
      });
    } finally {
      await close();
    }
  });
});
