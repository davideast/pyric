/**
 * The surface adapter (`src/bridge/server/surface-server.ts`), driven the way a
 * real client drives it: an MCP client on one end of a linked in-memory pair
 * and a real `McpServer` carrying a rendered variant on the other.
 *
 * What a unit test of the adapter cannot see, and this does: the tool list the
 * SDK actually advertises for a variant, the resource templates a discriminator
 * variant registers, and the events a call records with the canonical operation
 * and action stamped on them. The tenant projection is checked end to end here
 * as well, because a call that goes through the SDK's argument validation is
 * the only proof that a nested `claims` object survives the round trip.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createLocalBridge } from '../../src/bridge/server/local-bridge.js';
import { registerRenderedSurface } from '../../src/bridge/server/surface-server.js';
import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { METHODS } from '../../src/bridge/surface/methods/registry.js';
import type { BridgeToolEvent } from '../../src/bridge/server/bridge.js';
import type {
  OperationResult,
  RenderedSurface,
  RenderedTool,
} from '../../src/bridge/surface/types.js';

const TENANT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{docId} {
      allow read, write: if request.auth.token.firebase.tenant == 'tenant-a';
    }
  }
}`;

interface Session {
  client: Client;
  events: BridgeToolEvent[];
  close(): Promise<void>;
}

/** Serve one variant over a linked in-memory pair, collecting every event. */
async function openSurface(variant: string, rules?: string): Promise<Session> {
  const sandbox = initializeSandbox();
  if (rules !== undefined) setRules(sandbox, rules);
  const events: BridgeToolEvent[] = [];
  const bridge = createLocalBridge(sandbox, { onToolEvent: (event) => events.push(event) });
  const server = new McpServer({ name: 'pyric', version: bridge.version });
  registerRenderedSurface(server, bridge, renderSurface(variant), createSurfaceContext(sandbox), {
    onCallRejected: (rejection) => {
      events.push({
        timestamp: new Date().toISOString(),
        mode: 'sandbox',
        project: bridge.project,
        tool: rejection.tool,
        args: rejection.args,
        result: { ok: false, summary: rejection.message },
        durationMs: rejection.durationMs,
        operation: null,
        action: null,
        schemaRejected: rejection.schemaRejected,
        isError: true,
      });
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'surface-server-test', version: '0' });
  await client.connect(clientTransport);
  return {
    client,
    events,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content?: unknown }): string {
  return JSON.stringify(result.content ?? []);
}

describe('a one-tool-per-method variant over a real MCP session', () => {
  it('advertises every method as its own tool', async () => {
    const session = await openSurface('verb-prefixed');
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.length).toBe(METHODS.length);
      expect(listed.tools.map((tool) => tool.name)).toContain('create_auth_user');
      expect(listed.tools.map((tool) => tool.name)).toContain('simulate_rules_request');
    } finally {
      await session.close();
    }
  });

  it('carries a tenant and claims from a create through to a rules simulation', async () => {
    const session = await openSurface('verb-prefixed', TENANT_RULES);
    try {
      const created = await session.client.callTool({
        name: 'create_auth_user',
        arguments: {
          uid: 'alice',
          email: 'alice@example.com',
          customClaims: { role: 'owner' },
          tenantId: 'tenant-a',
        },
      });
      expect(created.isError).toBeFalsy();

      const simulated = await session.client.callTool({
        name: 'simulate_rules_request',
        arguments: { service: 'firestore', operation: 'get', path: 'tenants/t1', uid: 'alice' },
      });
      expect(simulated.isError).toBeFalsy();
      expect(textOf(simulated)).toContain('get tenants/t1: ALLOW');

      expect(session.events.map((event) => event.operation)).toEqual([
        'create_auth_user',
        'simulate_firestore_rules',
      ]);
      expect(session.events.map((event) => event.action)).toEqual([null, null]);
      expect(session.events.map((event) => event.tool)).toEqual([
        'create_auth_user',
        'simulate_rules_request',
      ]);
      for (const event of session.events) {
        expect(event.isError).toBe(false);
        expect(event.schemaRejected).toBe(false);
        expect(typeof event.durationMs).toBe('number');
      }
    } finally {
      await session.close();
    }
  });

  it('records a call the SDK rejects on argument types', async () => {
    const session = await openSurface('verb-prefixed');
    try {
      const rejected = await session.client.callTool({
        name: 'get_firestore_document',
        arguments: { path: 42 },
      });
      expect(rejected.isError).toBe(true);
      expect(session.events.length).toBe(1);
      expect(session.events[0]!.schemaRejected).toBe(true);
      expect(session.events[0]!.tool).toBe('get_firestore_document');
    } finally {
      await session.close();
    }
  });
});

describe('the discriminator variant over a real MCP session', () => {
  it('advertises thirteen intent tools and seven resource templates', async () => {
    const session = await openSurface('discriminator');
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.length).toBe(13);
      const templates = await session.client.listResourceTemplates();
      expect(templates.resourceTemplates.length).toBe(7);
    } finally {
      await session.close();
    }
  });

  it('stamps the operation and the action a discriminated call resolves to', async () => {
    const session = await openSurface('discriminator');
    try {
      const created = await session.client.callTool({
        name: 'manage_auth_users',
        arguments: { action: 'create', uid: 'alice', email: 'alice@example.com' },
      });
      expect(created.isError).toBeFalsy();
      expect(session.events.length).toBe(1);
      expect(session.events[0]!.tool).toBe('manage_auth_users');
      expect(session.events[0]!.operation).toBe('create_auth_user');
      expect(session.events[0]!.action).toBe('create');
    } finally {
      await session.close();
    }
  });

  it('records a resource read under the resource name and its operation', async () => {
    const session = await openSurface('discriminator');
    try {
      const read = await session.client.readResource({ uri: 'pyric://sandbox/status' });
      expect(read.contents.length).toBe(1);
      expect(session.events.length).toBe(1);
      expect(session.events[0]!.tool).toBe('sandbox_status');
      expect(session.events[0]!.operation).toBe('inspect_sandbox');
      expect(session.events[0]!.action).toBe(null);
    } finally {
      await session.close();
    }
  });
});

/**
 * Verdict stamping is checked against a surface authored here rather than a
 * rendered variant, because the question is what the adapter does with a
 * result code and not which method produces one. A stub surface names the code
 * directly, so the test states the contract the two halves share.
 */
async function openStubSurface(results: Record<string, OperationResult>): Promise<Session> {
  const sandbox = initializeSandbox();
  const events: BridgeToolEvent[] = [];
  const bridge = createLocalBridge(sandbox, { onToolEvent: (event) => events.push(event) });
  const server = new McpServer({ name: 'pyric', version: bridge.version });
  const tools: RenderedTool[] = Object.keys(results).map((name) => ({
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => results[name] as OperationResult,
  }));
  const surface: RenderedSurface = {
    tools,
    resolve: (toolName) => ({ operation: toolName, action: null }),
  };
  registerRenderedSurface(server, bridge, surface, createSurfaceContext(sandbox), {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'surface-server-verdict-test', version: '0' });
  await client.connect(clientTransport);
  return {
    client,
    events,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('verdict stamping on a recorded call', () => {
  it('marks a rules denial and a lint run with findings as verdicts', async () => {
    const session = await openStubSurface({
      denied: { ok: false, summary: 'write denied', data: { code: 'denied_by_rules' } },
      linted: { ok: false, summary: '2 findings', data: { code: 'lint_findings' } },
    });
    try {
      await session.client.callTool({ name: 'denied', arguments: {} });
      await session.client.callTool({ name: 'linted', arguments: {} });
      expect(session.events.map((event) => event.verdict)).toEqual([true, true]);
      expect(session.events.map((event) => event.isError)).toEqual([true, true]);
      expect(session.events.map((event) => event.schemaRejected)).toEqual([false, false]);
    } finally {
      await session.close();
    }
  });

  it('leaves a failure that is not a verdict, and every success, unmarked', async () => {
    const session = await openStubSurface({
      broken: { ok: false, summary: 'no such path', data: { code: 'not_found' } },
      rejected: { ok: false, summary: 'bad arguments', data: { code: 'invalid_arguments' } },
      fine: { ok: true, summary: 'done' },
    });
    try {
      await session.client.callTool({ name: 'broken', arguments: {} });
      await session.client.callTool({ name: 'rejected', arguments: {} });
      await session.client.callTool({ name: 'fine', arguments: {} });
      expect(session.events.map((event) => event.verdict)).toEqual([false, false, false]);
      expect(session.events.map((event) => event.schemaRejected)).toEqual([false, true, false]);
    } finally {
      await session.close();
    }
  });
});
