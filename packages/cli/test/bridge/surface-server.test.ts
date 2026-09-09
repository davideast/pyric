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
  it('advertises twelve intent tools and seven resource templates', async () => {
    const session = await openSurface('discriminator');
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.length).toBe(12);
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
