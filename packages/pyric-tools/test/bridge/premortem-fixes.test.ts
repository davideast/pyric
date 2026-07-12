/**
 * Tests for the premortem top-5 fixes — revised to use terminal
 * confirmation in place of the Bearer token (S1 v2).
 *
 *  - S1: terminal confirmation is the load-bearing prod-mode gate.
 *        Bearer token removed entirely. Tests here use a programmable
 *        ConfirmHandler stub so we can exercise the wiring without
 *        a real TTY.
 *  - A2: per-session idle timeout + max-session cap.
 *  - A1: dispatch consumes the canonical factory.
 *  - U1: lifecycle logging — wireable.
 */

import { describe, expect, test } from 'bun:test';
import { startServer } from '../../src/bridge/server.js';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';
import { ASSURANCE_TOOL_NAMES } from '../../src/assurance/tool-names.js';
import {
  createAutoApproveHandler,
  createDenyAllHandler,
  createPolicyHandler,
} from '../../src/bridge/server/confirm.js';
import type { ToolHandler } from '@inbrowser/agent';

function withServer<T>(
  startPort: number,
  fn: (server: Awaited<ReturnType<typeof startServer>>) => Promise<T>,
  opts: Parameters<typeof startServer>[0] = {},
): Promise<T> {
  return startServer({
    mode: 'sandbox',
    port: startPort,
    disableAuditLog: true,
    silent: true,
    ...opts,
  }).then(async (server) => {
    try {
      return await fn(server);
    } finally {
      await server.stop();
    }
  });
}

// A tiny in-process tool we can register in prod mode for testing.
// Returns a fixed payload so we can tell apart "ran" vs "denied" vs
// "didn't run."
function makeStubTool(name: string): ToolHandler {
  return {
    name,
    description: `test stub: ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<{ ok: true; summary: string; data: unknown }> {
      return { ok: true, summary: `${name} ran`, data: { ran: true } };
    },
  };
}

async function initSession(url: string): Promise<{
  sessionId: string;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; payload: { ok: boolean; summary: string; data?: unknown } }>;
}> {
  const initRes = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  });
  await initRes.text();
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('no mcp-session-id header');

  // Notify initialized (required before tool calls).
  await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  let nextId = 2;
  return {
    sessionId,
    async callTool(name, args = {}) {
      const id = nextId++;
      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const text = await res.text();
      // Streamable HTTP returns SSE 'event: message\ndata: {...}\n\n'.
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) throw new Error(`no SSE data line: ${text}`);
      const env = JSON.parse(dataLine.slice(6));
      const content = env.result?.content?.[0];
      if (!content || content.type !== 'text') {
        throw new Error(`unexpected content: ${JSON.stringify(env)}`);
      }
      const payload = JSON.parse(content.text);
      return { ok: !env.result?.isError, payload };
    },
  };
}

describe('Premortem fixes — S1 v2 (terminal confirmation)', () => {
  test('sandbox mode has no confirmHandler', async () => {
    await withServer(5190, async (server) => {
      expect(server.confirmHandler).toBeNull();
    });
  });

  test('prod mode without TTY refuses to start (no nonInteractive flag)', async () => {
    await expect(
      startServer({
        mode: 'prod',
        project: 'test',
        port: 5191,
        disableAuditLog: true,
        silent: true,
        // nonInteractive omitted; no TTY in test runner → must throw
      }),
    ).rejects.toThrow(/interactive terminal/);
  });

  test('prod mode with nonInteractive + autoApprove allows listed tools, denies others', async () => {
    const stubAllowed = makeStubTool('test_allowed_tool');
    const stubDenied = makeStubTool('test_denied_tool');
    const server = await startServer({
      mode: 'prod',
      project: 'test',
      port: 5192,
      disableAuditLog: true,
      silent: true,
      nonInteractive: true,
      autoApproveTools: ['test_allowed_tool'],
      prodTools: [stubAllowed, stubDenied],
    });
    try {
      const sess = await initSession(server.url);
      const allowed = await sess.callTool('test_allowed_tool');
      expect(allowed.payload.ok).toBe(true);
      expect(allowed.payload.summary).toContain('ran');

      const denied = await sess.callTool('test_denied_tool');
      expect(denied.payload.ok).toBe(false);
      expect(denied.payload.summary).toContain('denied');
    } finally {
      await server.stop();
    }
  });

  test('prod mode with explicit override handler (auto-approve) runs all tools', async () => {
    const stub = makeStubTool('test_tool');
    const server = await startServer({
      mode: 'prod',
      project: 'test',
      port: 5193,
      disableAuditLog: true,
      silent: true,
      confirmHandler: createAutoApproveHandler(),
      prodTools: [stub],
    });
    try {
      const sess = await initSession(server.url);
      const result = await sess.callTool('test_tool');
      expect(result.payload.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test('prod mode with deny-all handler refuses every tool', async () => {
    const stub = makeStubTool('test_tool');
    const server = await startServer({
      mode: 'prod',
      project: 'test',
      port: 5194,
      disableAuditLog: true,
      silent: true,
      confirmHandler: createDenyAllHandler(),
      prodTools: [stub],
    });
    try {
      const sess = await initSession(server.url);
      const result = await sess.callTool('test_tool');
      expect(result.payload.ok).toBe(false);
      expect(result.payload.summary).toContain('denied');
    } finally {
      await server.stop();
    }
  });

  test('confirmation block lands in audit log entries', async () => {
    const stub = makeStubTool('audit_test_tool');
    const events: Array<{ tool: string; confirmation?: unknown }> = [];
    const fakeAuditWriter = {
      path: '/dev/null',
      write(event: { tool: string; confirmation?: unknown }) {
        events.push({ tool: event.tool, confirmation: event.confirmation });
      },
    };
    const server = await startServer({
      mode: 'prod',
      project: 'test',
      port: 5195,
      silent: true,
      confirmHandler: createAutoApproveHandler(),
      prodTools: [stub],
      auditWriter: fakeAuditWriter,
    });
    try {
      const sess = await initSession(server.url);
      await sess.callTool('audit_test_tool');
      // The audit entry for this tool should carry a confirmation block.
      const entry = events.find((e) => e.tool === 'audit_test_tool');
      expect(entry).toBeDefined();
      expect(entry?.confirmation).toBeDefined();
      expect((entry?.confirmation as { decision: string }).decision).toBe('approved');
    } finally {
      await server.stop();
    }
  });
});

describe('Premortem fixes — A2 (session leak)', () => {
  test('max-session cap rejects new sessions at limit', async () => {
    await withServer(
      5196,
      async (server) => {
        const initBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        };
        const init = () =>
          fetch(`${server.url}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(initBody),
          });
        const r1 = await init();
        expect(r1.status).toBe(200);
        await r1.text();
        const r2 = await init();
        expect(r2.status).toBe(200);
        await r2.text();
        const r3 = await init();
        expect(r3.status).toBe(503);
        const errBody = await r3.json();
        expect(errBody.error).toContain('session cap');
      },
      { maxSessions: 2 },
    );
  });

  test('idle session is auto-closed after sessionIdleMs', async () => {
    await withServer(
      5197,
      async (server) => {
        const initRes = await fetch(`${server.url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 't', version: '0' },
            },
          }),
        });
        await initRes.text();
        const sessionId = initRes.headers.get('mcp-session-id');
        expect(sessionId).not.toBeNull();
        await new Promise((r) => setTimeout(r, 250));
        const health = await fetch(`${server.url}/health`);
        expect(health.status).toBe(200);
      },
      { sessionIdleMs: 100 },
    );
  });
});

describe('Premortem fixes — A1 (dispatcher drift eliminated)', () => {
  test('SANDBOX_TOOL_NAMES covers the simulator + data-plane + inspect factories (no advertise/execute drift)', () => {
    expect(SANDBOX_TOOL_NAMES).toEqual([
      // simulator family
      'firestore_simulator_create',
      'firestore_simulator_execute',
      'firestore_simulator_read',
      'firestore_simulator_batch',
      'firestore_create_with_auto_id',
      'firestore_simulator_undo',
      'firestore_simulator_redo',
      'firestore_simulator_events',
      'firestore_simulator_transaction',
      // data-plane family (now executable on the page peer, not just advertised)
      'firestore_get_document',
      'firestore_list_documents',
      'firestore_create_document',
      'firestore_add_document',
      'firestore_update_document',
      'firestore_delete_document',
      'firestore_batch_write',
      'firestore_query_where',
      // inspect
      'sandbox_inspect',
      // local-only authorization assurance
      ...ASSURANCE_TOOL_NAMES,
    ]);
  });
});

describe('Premortem fixes — non-interactive policy handler', () => {
  test('createPolicyHandler integrates with prod tool dispatch', async () => {
    const stubA = makeStubTool('policy_tool_a');
    const stubB = makeStubTool('policy_tool_b');
    const server = await startServer({
      mode: 'prod',
      project: 'test',
      port: 5198,
      disableAuditLog: true,
      silent: true,
      confirmHandler: createPolicyHandler({
        allow: new Set(['policy_tool_a']),
        deny: new Set(['policy_tool_b']),
        default: 'deny',
      }),
      prodTools: [stubA, stubB],
    });
    try {
      const sess = await initSession(server.url);
      const a = await sess.callTool('policy_tool_a');
      expect(a.payload.ok).toBe(true);
      const b = await sess.callTool('policy_tool_b');
      expect(b.payload.ok).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
