/**
 * The auth tool families against a real bridge over real MCP.
 *
 * The unit tests inject the transport; this one does not. It starts the
 * standalone bridge, registers a client in its registry, and runs the CLI
 * commands with their default `callTool`, so the MCP handshake, the
 * registration of all twelve `auth_*` tools, and the CLI's result parsing are
 * all exercised.
 *
 * It also pins the fact the tool descriptions state: an identity set here
 * changes a client's registry entry, or the bridge's record of the caller,
 * and nothing about how a forwarded tool call executes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { startServer, type ServerHandle } from '../../src/bridge/server.js';
import { dispatchSandboxTool, SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';
import { isBridgeMessage } from '../../src/bridge/protocol.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  runAuthImpersonate,
  runAuthReset,
  runAuthSessions,
  runAuthWhoami,
  type AuthIdentityDeps,
} from '../../src/cli/auth-identity.js';
import type { BridgeMessage } from '../../src/bridge/protocol.js';

const PORT = 5183;

let server: ServerHandle;
const clientFrames: BridgeMessage[] = [];

beforeAll(async () => {
  server = await startServer({ port: PORT, disableAuditLog: true, silent: true });
  server.bridge.consumers.register({
    clientSessionId: 'sess-live',
    platform: 'kotlin',
    deviceLabel: 'Pixel 10',
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    activeLens: { mode: 'app-session' },
    send: (msg) => clientFrames.push(msg),
  });
});

afterAll(async () => {
  await server.stop();
});

function parsed(...argv: string[]) {
  const raw = parseArgs(argv);
  return { ...raw, positional: raw.positional.slice(1) };
}

function deps(out: string[], err: string[]): AuthIdentityDeps {
  return {
    cwd: '/tmp',
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    discover: async () => ({
      mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
      url: `http://127.0.0.1:${PORT}`,
      base: `http://127.0.0.1:${PORT}`,
      instanceId: null,
      source: 'test',
    }),
  };
}

describe('pyric auth identity commands over a live bridge', () => {
  it('lists the registered client', async () => {
    const out: string[] = [];
    const err: string[] = [];

    expect(await runAuthSessions(parsed('auth', 'sessions', '--json'), deps(out, err))).toBe(0);
    expect(err.join('')).toBe('');
    const result = JSON.parse(out.join('')) as {
      ok: boolean;
      data: { sessions: Array<{ target: string; identity: string }> };
    };
    expect(result.ok).toBe(true);
    expect(result.data.sessions).toHaveLength(1);
    expect(result.data.sessions[0]).toMatchObject({
      target: 'sess-live',
      identity: 'app session',
    });
  });

  it('impersonates a uid with a tenant and claims on a named target', async () => {
    const out: string[] = [];
    const err: string[] = [];

    expect(
      await runAuthImpersonate(
        parsed(
          'auth', 'impersonate', 'alice',
          '--tenant', 'tenant-acme',
          '--claims', '{"role":"editor"}',
          '--target', 'sess-live',
        ),
        deps(out, err),
      ),
    ).toBe(0);
    expect(err.join('')).toBe('');
    expect(server.bridge.consumers.get('sess-live')?.activeLens).toEqual({
      mode: 'as',
      uid: 'alice',
      tenant: 'tenant-acme',
      token: { role: 'editor' },
    });
    expect(clientFrames.at(-1)).toMatchObject({ type: 'worker-event', event: 'remote-lens' });
    expect(out.join('')).toContain('applies to the named client only');
  });

  it('resets a named target back to the application session', async () => {
    const out: string[] = [];
    const err: string[] = [];

    expect(
      await runAuthReset(parsed('auth', 'reset', '--target', 'sess-live'), deps(out, err)),
    ).toBe(0);
    expect(server.bridge.consumers.get('sess-live')?.activeLens).toEqual({ mode: 'app-session' });
  });

  it('records the caller identity and reads it back through whoami', async () => {
    const out: string[] = [];
    const err: string[] = [];

    expect(await runAuthImpersonate(parsed('auth', 'impersonate', '--admin'), deps(out, err))).toBe(0);
    expect(server.bridge.callerIdentity.get()).toEqual({ mode: 'admin' });
    // The client the previous test reset must be untouched by a self call.
    expect(server.bridge.consumers.get('sess-live')?.activeLens).toEqual({ mode: 'app-session' });

    const whoOut: string[] = [];
    expect(await runAuthWhoami(parsed('auth', 'whoami'), deps(whoOut, err))).toBe(0);
    expect(whoOut.join('')).toContain('admin');
    expect(whoOut.join('')).toContain(
      'applied to the tool calls you forward through it',
    );

    expect(await runAuthReset(parsed('auth', 'reset'), deps([], err))).toBe(0);
    expect(server.bridge.callerIdentity.get()).toEqual({ mode: 'app-session' });
    expect(err.join('')).toBe('');
  });

  it('reports an unknown target with exit 2', async () => {
    const out: string[] = [];
    const err: string[] = [];

    expect(
      await runAuthImpersonate(
        parsed('auth', 'impersonate', '--anonymous', '--target', 'sess-missing'),
        deps(out, err),
      ),
    ).toBe(2);
    expect(err.join('')).toContain('sess-missing');
  });
});

/**
 * The user-administration tools over the same wire: the MCP SDK validates each
 * call against the Zod shape the bridge derives from the tool's JSON schema,
 * the bridge forwards it, and the page dispatcher executes it against a real
 * sandbox. A schema the converter cannot express would fail here, not at
 * review time.
 */
function connectFakePeer(
  sandbox: LocalSandbox = initializeSandbox(),
): Promise<{ disconnect: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sandbox`);
  return new Promise((resolve, reject) => {
    let resolved = false;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          tools: [...SANDBOX_TOOL_NAMES],
          sandboxId: 'auth-users-peer',
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
        resolve({ disconnect: () => ws.close() });
        return;
      }
      if (msg.type === 'tool-call') {
        // Mirrors the real page peer (`bridge/client/bridge.ts`): the frame's
        // identity is relayed to the dispatcher, and a rules denial comes back
        // as an errored tool-result rather than hanging the call.
        try {
          const result = await dispatchSandboxTool(sandbox, msg.name, msg.args ?? {}, msg.actAs);
          ws.send(JSON.stringify({ type: 'tool-result', id: msg.id, ok: true, result }));
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
    ws.on('error', reject);
  });
}

async function mcpClient() {
  const client = new Client({ name: 'auth-users-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function payload(response: unknown): { ok: boolean; summary: string; data?: unknown } {
  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find((block) => block.type === 'text')!.text!);
}

describe('the auth user tools over a live bridge', () => {
  it('advertises every auth tool by its own name, with no op field', async () => {
    const { client, close } = await mcpClient();
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toContain('auth_create_user');
      expect(listed).toContain('auth_impersonate');
      expect(listed).toContain('auth_whoami');
      expect(listed.some((name) => name.includes('lens'))).toBe(false);
      const create = (await client.listTools()).tools.find((t) => t.name === 'auth_create_user')!;
      expect(Object.keys(create.inputSchema.properties ?? {})).not.toContain('op');
    } finally {
      await close();
    }
  });

  it('creates, imports, lists, and mints a token through MCP', async () => {
    const peer = await connectFakePeer();
    const { client, close } = await mcpClient();
    try {
      const created = payload(
        await client.callTool({
          name: 'auth_create_user',
          arguments: {
            uid: 'ada',
            email: 'ada@example.com',
            password: 'password123',
            claims: { role: 'admin' },
          },
        }),
      );
      expect(created.ok).toBe(true);
      expect((created.data as { user: { photoUrl: unknown } }).user.photoUrl).toBeNull();

      const imported = payload(
        await client.callTool({
          name: 'auth_import_users',
          arguments: { users: [{ email: 'goog@example.com', providers: ['google.com'] }] },
        }),
      );
      expect(imported.ok).toBe(true);

      const listed = payload(await client.callTool({ name: 'auth_list_users', arguments: {} }));
      const users = (listed.data as { users: Array<{ uid: string; photoUrl: string | null }> }).users;
      expect(users).toHaveLength(2);
      expect(users.find((user) => user.uid === 'ada')!.photoUrl).toBeNull();
      const federated = users.find((user) => user.uid !== 'ada')!;
      expect(federated.photoUrl).toStartWith('data:image/svg+xml,');

      const fetched = payload(
        await client.callTool({ name: 'auth_get_user', arguments: { uid: 'ada' } }),
      );
      expect((fetched.data as { user: { uid: string } }).user.uid).toBe('ada');

      const updated = payload(
        await client.callTool({
          name: 'auth_update_user',
          arguments: { uid: 'ada', displayName: 'Ada L' },
        }),
      );
      expect((updated.data as { user: { displayName: string } }).user.displayName).toBe('Ada L');

      const claimed = payload(
        await client.callTool({
          name: 'auth_set_claims',
          arguments: { uid: 'ada', claims: { role: 'editor' } },
        }),
      );
      expect((claimed.data as { user: { claims: unknown } }).user.claims).toEqual({
        role: 'editor',
      });

      const token = payload(
        await client.callTool({
          name: 'auth_custom_token',
          arguments: { uid: 'ada', claims: { role: 'admin' } },
        }),
      );
      expect((token.data as { token: string }).token.length).toBeGreaterThan(0);

      const deleted = payload(
        await client.callTool({ name: 'auth_delete_user', arguments: { uid: 'ada' } }),
      );
      expect(deleted.ok).toBe(true);
    } finally {
      await close();
      peer.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});

/**
 * The core claim of the caller identity, at the outermost layer there is: a
 * real MCP client calls `auth_impersonate`, then calls a data tool, and the
 * bridge, the WebSocket, the page peer, and the sandbox's rules engine all sit
 * between the two calls.
 */
const IDENTITY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{note} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
    }
    match /open/{doc} {
      allow read: if request.auth == null;
    }
    match /sealed/{doc} {
      allow read: if false;
    }
  }
}`;

describe('the caller identity governs the tool calls the bridge forwards', () => {
  const sandbox = initializeSandbox();
  let peer: { disconnect: () => void };
  let client: Client;
  let closeClient: () => Promise<void>;

  const read = async (path: string, args: Record<string, unknown> = {}) =>
    payload(
      await client.callTool({ name: 'firestore_get_document', arguments: { path, ...args } }),
    );
  const impersonate = async (args: Record<string, unknown>) =>
    payload(await client.callTool({ name: 'auth_impersonate', arguments: args }));

  beforeAll(async () => {
    peer = await connectFakePeer(sandbox);
    const connected = await mcpClient();
    client = connected.client;
    closeClient = async () => {
      await connected.close();
    };
    // Seeded before any impersonation, so the seeds prove the untouched
    // default: no identity recorded, admin write, rules not yet deployed.
    for (const [path, data] of [
      ['notes/n1', { owner: 'alice' }],
      ['open/o1', { v: 1 }],
      ['sealed/s1', { v: 1 }],
    ] as const) {
      const created = payload(
        await client.callTool({
          name: 'firestore_create_document',
          arguments: { path, data },
        }),
      );
      expect(created.ok).toBe(true);
    }
    setRules(sandbox, IDENTITY_RULES);
  });

  afterAll(async () => {
    await client.callTool({ name: 'auth_reset', arguments: {} });
    await closeClient();
    peer.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('reads with rules bypassed while the caller holds the app session', async () => {
    expect(await impersonate({ uid: 'zzz' })).toMatchObject({ ok: true });
    expect(payload(await client.callTool({ name: 'auth_reset', arguments: {} })).ok).toBe(true);
    expect((await read('sealed/s1')).ok).toBe(true);
  });

  it('denies a read the impersonated user may not make, and allows it after a reset', async () => {
    expect((await impersonate({ uid: 'bob' })).ok).toBe(true);
    const denied = await read('notes/n1');
    expect(denied.ok).toBe(false);
    expect(denied.summary.toLowerCase()).toContain('denied by rules');

    expect((await impersonate({ uid: 'alice' })).ok).toBe(true);
    const allowed = await read('notes/n1');
    expect(allowed.ok).toBe(true);
    expect((allowed.data as { data: unknown }).data).toEqual({ owner: 'alice' });

    expect(payload(await client.callTool({ name: 'auth_reset', arguments: {} })).ok).toBe(true);
    expect((await read('sealed/s1')).ok).toBe(true);
  });

  it("lets a call's own as argument outrank the recorded identity, which stays put", async () => {
    expect((await impersonate({ uid: 'bob' })).ok).toBe(true);

    expect((await read('notes/n1', { as: { uid: 'alice' } })).ok).toBe(true);
    expect(server.bridge.callerIdentity.get()).toEqual({ mode: 'as', uid: 'bob' });
    const whoami = payload(await client.callTool({ name: 'auth_whoami', arguments: {} }));
    expect((whoami.data as { identity: string }).identity).toBe('as bob');

    // The recorded identity is still the one in force for a call without `as`.
    expect((await read('notes/n1')).ok).toBe(false);
  });

  it('bypasses rules for admin, and runs genuinely signed out for anonymous', async () => {
    expect((await impersonate({ admin: true })).ok).toBe(true);
    expect((await read('sealed/s1')).ok).toBe(true);

    expect((await impersonate({ anonymous: true })).ok).toBe(true);
    expect((await read('open/o1')).ok).toBe(true);
    expect((await read('notes/n1')).ok).toBe(false);
    expect((await read('sealed/s1')).ok).toBe(false);
  });

  it('leaves another connected client alone when the caller impersonates', async () => {
    expect((await impersonate({ uid: 'alice' })).ok).toBe(true);
    expect(server.bridge.consumers.get('sess-live')?.activeLens).toEqual({ mode: 'app-session' });
  });
});
