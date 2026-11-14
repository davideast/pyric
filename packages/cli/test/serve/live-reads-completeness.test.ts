/**
 * Standing completeness check for live data-read refusal across `/__pyric/mcp`
 * (`tool-family-records/*`) and all five `pyric mcp` surface variants
 * (`sdk-service`, `verb-prefixed`, `noun-prefixed`, `verb-suffixed`, and
 * `discriminator` tools + resources).
 *
 * Every data-plane read across Firestore, Realtime Database, Cloud Storage,
 * Auth, Messaging, AI Logic, and `sandbox.inspect` must route through
 * `live-reads.ts` and refuse with `PYRIC_LIVE_REFUSED` when no tab answers,
 * never leaking empty local sandbox state.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeSandbox } from 'pyric/sandbox';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { buildInProcessMcpServer } from '../../src/bridge/server/in-process.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { buildMcpServer } from '../../src/bridge/server/mcp.js';
import { BRIDGE_FORWARDED_TOOL_NAMES, getBridgeToolSurface } from '../../src/bridge/server/mcp-contract.js';
import { TargetRouter } from '../../src/bridge/server/target-router.js';
import { METHODS, SURFACE_VARIANT_IDS } from '../../src/bridge/surface/index.js';
import { toolFamilies } from '../../src/bridge/tool-families.js';
import { runHostedMethod, tabCallRoute } from '../../src/serve/hosted/live-reads.js';

/**
 * Explicit allowlist of `/__pyric/mcp` read tools that operate purely on local
 * Security Rules source, local conformance tables, local `.pyric/captures`
 * files, or the host's local recorded event stream (requiring zero production
 * data or credentials). Any newly added read tool outside this set MUST be
 * covered by `live-reads.ts`.
 */
const PURE_LOCAL_BRIDGE_READ_TOOLS: ReadonlySet<string> = new Set([
  'firestore_simulate_rules',
  'firestore_rules_stdlib_list',
  'firestore_rules_stdlib_get',
  'firestore_lint_rules',
  'firestore_resolve_modules',
  'rules_stdlib_list',
  'rules_stdlib_get',
  'rules_resolve_modules',
  'rtdb_simulate_access',
  'firestore_simulator_events',
  'pyric_can_i_use',
  'sandbox_list_captures',
  'sandbox_open_capture',
]);

/**
 * Explicit allowlist of read methods on `firestore`, `database`, `storage`,
 * `auth`, and `messaging` that inspect local TypeScript/JavaScript source files
 * rather than project data.
 */
const PURE_LOCAL_DATA_SERVICE_METHODS: ReadonlySet<string> = new Set([
  'firestore.extractIndexes',
  'database.extractIndexes',
]);

const DATA_SERVICE_TOOLS: ReadonlySet<string> = new Set([
  'firestore',
  'database',
  'storage',
  'auth',
  'messaging',
]);

const SAMPLE_BRIDGE_READ_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  firestore_get_document: { path: 'items/item-1' },
  firestore_list_documents: { collection: 'items' },
  firestore_query_where: { collection: 'items', where: [] },
  firestore_simulator_read: { path: 'items/item-1' },
  rtdb_crawl_structure: { path: '/' },
  auth_get_user: { uid: 'u-1' },
  auth_list_users: {},
  auth_custom_token: { uid: 'u-1' },
  auth_whoami: {},
  auth_sessions: {},
  sandbox_inspect: {},
  messaging_deliveries: {},
};

function createLiveBridge() {
  const bridge = createBridge({
    mode: 'live',
    version: 'test',
    logger: createSilentLogger(),
    tabRoute: tabCallRoute,
  });
  bridge.registerSandboxPeer(
    (frame: BridgeMessage) => {
      if (frame.type !== 'tool-call') return;
      queueMicrotask(() =>
        bridge.handleSandboxMessage({
          type: 'tool-result',
          id: frame.id,
          ok: true,
          result: { ok: true, summary: 'LEAKED_SANDBOX_PEER_DATA' },
        }),
      );
    },
    [...BRIDGE_FORWARDED_TOOL_NAMES],
    'hosted-sandbox',
  );
  return bridge;
}

describe('standing live-reads completeness across tool-family-records and MCP surfaces', () => {
  it('covers every non-local read tool in tool-family-records on /__pyric/mcp with PYRIC_LIVE_REFUSED when no tab is connected', async () => {
    const bridge = createLiveBridge();
    const surface = getBridgeToolSurface({
      projectDir: process.cwd(),
      consumers: bridge.consumers,
      callerIdentity: bridge.callerIdentity,
    });
    const server = buildMcpServer(bridge, {
      forwarded: surface.forwarded,
      inProcess: surface.inProcess,
      mode: 'live',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'completeness-canary', version: '1.0.0' });
    await client.connect(clientTransport);

    const allReadTools = [
      ...toolFamilies('forwarded'),
      ...toolFamilies('in-process'),
    ].flatMap((family) =>
      Object.entries(family.tools)
        .filter(([, effect]) => effect === 'read')
        .map(([name]) => name),
    );

    const uncovered: string[] = [];
    for (const toolName of allReadTools) {
      if (PURE_LOCAL_BRIDGE_READ_TOOLS.has(toolName)) continue;
      const routed = tabCallRoute(bridge.tabTools, toolName, {});
      if (routed === undefined) {
        uncovered.push(`${toolName} (missing from tabCallRoute)`);
        continue;
      }
      const args = SAMPLE_BRIDGE_READ_ARGS[toolName] ?? {};
      const res = await client.callTool({ name: toolName, arguments: args });
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
      if (!text.includes('PYRIC_LIVE_REFUSED') || text.includes('LEAKED_SANDBOX_PEER_DATA')) {
        uncovered.push(`${toolName} (/__pyric/mcp returned: ${text})`);
      }
    }

    expect(uncovered).toEqual([]);
    await client.close();
    await server.close();
  });

  it('covers every data-service read method in METHODS via runHostedMethod when no tab is connected', async () => {
    const bridge = createLiveBridge();
    const uncovered: string[] = [];

    for (const method of METHODS) {
      if (method.effect !== 'read') continue;
      if (!DATA_SERVICE_TOOLS.has(method.tool)) continue;
      if (PURE_LOCAL_DATA_SERVICE_METHODS.has(method.key)) continue;

      let leakedLocal = false;
      const result = await runHostedMethod(
        bridge.tabTools,
        {
          instanceId: bridge.instanceId,
          projectDir: process.cwd(),
          key: method.key,
          args: {},
          allowProduction: false,
        },
        async () => {
          leakedLocal = true;
          return { ok: true, summary: 'LEAKED_LOCAL_SANDBOX' };
        },
      );

      const code = (result.data as { code?: string } | undefined)?.code;
      if (result.ok || code !== 'PYRIC_LIVE_REFUSED' || leakedLocal) {
        uncovered.push(`${method.key} (result=${JSON.stringify(result)})`);
      }
    }

    expect(uncovered).toEqual([]);
  });

  it('enforces PYRIC_LIVE_REFUSED across grouped, flat, and discriminator MCP surfaces (including resources) when attached to a live host', async () => {
    const bridge = createLiveBridge();
    const projectDir = process.cwd();

    const makeLiveRouter = () =>
      new TargetRouter({
        projectDir,
        cacheTtlMs: 60_000,
        discover: async () => ({
          url: 'http://127.0.0.1:39999',
          base: 'http://127.0.0.1:39999',
          mcpUrl: 'http://127.0.0.1:39999/__pyric/mcp',
          instanceId: bridge.instanceId,
          pointerProjectDir: projectDir,
          source: 'pointer .pyric/serve.json',
        }),
        callHosted: async (_host, key, args) =>
          runHostedMethod(
            bridge.tabTools,
            {
              instanceId: bridge.instanceId,
              projectDir,
              key,
              args,
              allowProduction: false,
            },
            async () => ({ ok: true, summary: 'LEAKED_HOSTED_SANDBOX' }),
          ),
      });

    async function withSurfaceClient<T>(
      surfaceId: string,
      fn: (client: Client) => Promise<T>,
    ): Promise<T> {
      const sandbox = initializeSandbox({ projectId: 'org-alpha' });
      const server = buildInProcessMcpServer(sandbox, {
        surface: surfaceId,
        projectDir,
        targetRouter: makeLiveRouter(),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `surface-${surfaceId}`, version: '1.0.0' });
      await client.connect(clientTransport);
      try {
        return await fn(client);
      } finally {
        await client.close();
        await server.close();
      }
    }

    expect(SURFACE_VARIANT_IDS).toEqual(
      expect.arrayContaining([
        'sdk-service',
        'verb-prefixed',
        'noun-prefixed',
        'verb-suffixed',
        'discriminator',
      ]),
    );

    // 1. Grouped surface (`sdk-service`): firestore, database, storage, auth reads all refuse.
    await withSurfaceClient('sdk-service', async (client) => {
      for (const [tool, callArgs] of [
        ['firestore', { method: 'getDoc', args: { path: 'items/item-1' } }],
        ['database', { method: 'get', args: { path: 'items/item-1' } }],
        ['storage', { method: 'listAll' }],
        ['auth', { method: 'whoami' }],
        ['auth', { method: 'sessions' }],
        ['auth', { method: 'listUsers' }],
      ] as const) {
        const res = await client.callTool({ name: tool, arguments: callArgs });
        const text = JSON.stringify(res);
        expect(text, `${tool}.${callArgs.method}`).toContain('PYRIC_LIVE_REFUSED');
        expect(text, `${tool}.${callArgs.method}`).not.toContain('LEAKED_HOSTED_SANDBOX');
      }
    });

    // 2. All three flat surfaces (`verb-prefixed`, `noun-prefixed`, `verb-suffixed`): auth whoami & sessions + data reads refuse.
    for (const [surfaceId, calls] of [
      [
        'verb-prefixed',
        [
          ['get_firestore_document', { path: 'items/item-1' }],
          ['get_database_value', { path: 'items/item-1' }],
          ['list_storage_files', {}],
          ['get_auth_identity', {}],
          ['list_auth_sessions', {}],
        ],
      ],
      [
        'noun-prefixed',
        [
          ['firestore_document_get', { path: 'items/item-1' }],
          ['database_value_get', { path: 'items/item-1' }],
          ['storage_files_list', {}],
          ['auth_identity_get', {}],
          ['auth_sessions_list', {}],
        ],
      ],
      [
        'verb-suffixed',
        [
          ['get_document_firestore', { path: 'items/item-1' }],
          ['get_value_database', { path: 'items/item-1' }],
          ['list_files_storage', {}],
          ['get_identity_auth', {}],
          ['list_sessions_auth', {}],
        ],
      ],
    ] as const) {
      await withSurfaceClient(surfaceId, async (client) => {
        for (const [toolName, callArgs] of calls) {
          const res = await client.callTool({ name: toolName, arguments: callArgs });
          const text = JSON.stringify(res);
          expect(text, `${surfaceId}:${toolName}`).toContain('PYRIC_LIVE_REFUSED');
          expect(text, `${surfaceId}:${toolName}`).not.toContain('LEAKED_HOSTED_SANDBOX');
        }
      });
    }

    // 3. Discriminator surface: both tool reads and resource template reads across firestore, database, storage, auth, and sandbox status refuse.
    await withSurfaceClient('discriminator', async (client) => {
      for (const uri of [
        'pyric://firestore/docs/items/item-1',
        'pyric://database/tree/items',
        'pyric://auth/users',
        'pyric://storage/objects/items/item-1',
        'pyric://sandbox/status',
      ]) {
        const res = await client.readResource({ uri });
        const text = JSON.stringify(res);
        expect(text, `discriminator resource ${uri}`).toContain('PYRIC_LIVE_REFUSED');
        expect(text, `discriminator resource ${uri}`).not.toContain('LEAKED_HOSTED_SANDBOX');
      }
      for (const [toolName, callArgs] of [
        ['inspect_auth_flow', { action: 'whoami' }],
        ['inspect_auth_flow', { action: 'list_sessions' }],
        ['manage_auth_users', { action: 'get', uid: 'u-1' }],
        ['manage_storage_files', { action: 'list' }],
        ['query_sandbox_data', { action: 'read', service: 'firestore', path: 'items' }],
        ['query_sandbox_data', { action: 'read', service: 'database', path: 'items' }],
      ] as const) {
        const res = await client.callTool({ name: toolName, arguments: callArgs });
        const text = JSON.stringify(res);
        expect(text, `discriminator tool ${toolName}`).toContain('PYRIC_LIVE_REFUSED');
        expect(text, `discriminator tool ${toolName}`).not.toContain('LEAKED_HOSTED_SANDBOX');
      }
    });
  });
});
