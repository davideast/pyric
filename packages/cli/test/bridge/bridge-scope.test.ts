/**
 * Project credentials resolve once per bridge entry point and reach the
 * in-process handlers.
 *
 *  1. `resolveBridgeScope` never throws: no credentials yields
 *     `scope: undefined` with the reason; a resolved scope carries its source.
 *  2. Each entry point (standalone server, headless server, serve mount)
 *     lists `firestore_rules.test` without credentials and answers it with
 *     the credentials error.
 *  3. Each entry point hands a supplied scope to the handlers: the call
 *     resolves a token from it and targets its project.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeSandbox } from 'pyric/sandbox';
import { FIRESTORE_TEST_RULES_SCOPE_REQUIRED } from 'pyric/rules/internal/node';
import type { ProjectScope } from '../../src/credentials/core/types.js';
import { resolveBridgeScope } from '../../src/bridge/server/scope.js';
import { startServer, type ServerHandle } from '../../src/bridge/server/standalone.js';
import { buildHeadlessMcpServer } from '../../src/bridge/server/headless.js';
import { createBridgeMount, type BridgeMount } from '../../src/serve/bridge-mount.js';

const RULES_API_HOST = 'firebaserules.googleapis.com';
const CREDENTIAL_ENV = ['FIREBASE_SA_BASE64', 'GOOGLE_APPLICATION_CREDENTIALS', 'PYRIC_PROJECT'];

const originalFetch = globalThis.fetch;
const savedEnv = new Map<string, string | undefined>();

/** Clear the credential sources so entry points resolve no scope, whatever the developer's shell holds. */
beforeAll(() => {
  for (const name of CREDENTIAL_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer Rules Test API calls with an empty result; every other URL reaches the real fetch. */
function stubRulesTestApi(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(RULES_API_HOST)) return originalFetch(input, init);
    urls.push(url);
    return new Response(JSON.stringify({ testResults: [] }), { status: 200 });
  }) as typeof fetch;
  return urls;
}

function fakeScope(): ProjectScope & { tokenCalls: number } {
  const scope = {
    projectId: 'fake-project',
    tokenCalls: 0,
    async resolveToken() {
      scope.tokenCalls += 1;
      return 'fake-token';
    },
  };
  return scope;
}

interface ToolText {
  ok: boolean;
  summary: string;
}

async function callTestRules(client: Client): Promise<ToolText> {
  const result = await client.callTool({
    name: 'firestore_rules',
    arguments: { op: 'test', source: "rules_version = '2';", testCases: [] },
  });
  const content = (result.content as Array<{ type: string; text: string }>)[0]!;
  return JSON.parse(content.text) as ToolText;
}

async function listedOps(client: Client, tool: string): Promise<string[]> {
  const { tools } = await client.listTools();
  const schema = tools.find((candidate) => candidate.name === tool)!.inputSchema as {
    properties: { op: { enum: string[] } };
  };
  return schema.properties.op.enum;
}

async function connectHttp(url: string): Promise<Client> {
  const client = new Client({ name: 'bridge-scope-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe('resolveBridgeScope', () => {
  it('yields no scope and the reason when no credential source is configured', async () => {
    const resolution = await resolveBridgeScope({ env: {} });
    expect(resolution.scope).toBeUndefined();
    if (resolution.scope) throw new Error('unreachable');
    expect(resolution.reason).toContain('FIREBASE_SA_BASE64');
  });

  it('yields the resolved scope and its source', async () => {
    const scope = fakeScope();
    const resolution = await resolveBridgeScope({
      projectId: 'p',
      resolve: async (options) => {
        expect(options.projectId).toBe('p');
        return { scope, source: 'adc' };
      },
    });
    expect(resolution.scope).toBe(scope);
    if (!resolution.scope) throw new Error('unreachable');
    expect(resolution.source).toBe('adc');
  });

  it('never throws when the credential walk does', async () => {
    const resolution = await resolveBridgeScope({
      resolve: async () => {
        throw new Error('walk failed');
      },
    });
    expect(resolution).toEqual({ scope: undefined, reason: 'walk failed' });
  });
});

describe('standalone bridge', () => {
  const handles: ServerHandle[] = [];
  afterAll(async () => {
    for (const handle of handles) await handle.stop();
  });

  async function start(scope?: ProjectScope): Promise<Client> {
    const handle = await startServer({
      port: 0,
      disableAuditLog: true,
      silent: true,
      ...(scope ? { scope } : {}),
    });
    handles.push(handle);
    return connectHttp(`${handle.url}/mcp`);
  }

  it('lists firestore_rules.test without credentials and answers it with the credentials error', async () => {
    const urls = stubRulesTestApi();
    const client = await start();
    expect(await listedOps(client, 'firestore_rules')).toContain('test');
    expect(await listedOps(client, 'pyric')).toEqual(['can_i_use', 'verify', 'verify_cases']);
    const result = await callTestRules(client);
    expect(result).toMatchObject({ ok: false, summary: FIRESTORE_TEST_RULES_SCOPE_REQUIRED });
    expect(urls).toEqual([]);
    await client.close();
  });

  it('hands a supplied scope to the handlers', async () => {
    const urls = stubRulesTestApi();
    const scope = fakeScope();
    const client = await start(scope);
    const result = await callTestRules(client);
    expect(result.ok).toBe(true);
    expect(scope.tokenCalls).toBe(1);
    expect(urls).toEqual([`https://${RULES_API_HOST}/v1/projects/fake-project:test`]);
    await client.close();
  });
});

describe('headless bridge', () => {
  async function connect(scope?: ProjectScope): Promise<Client> {
    const server = buildHeadlessMcpServer(initializeSandbox(), scope ? { scope } : {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'bridge-scope-test', version: '0' });
    await client.connect(clientTransport);
    return client;
  }

  it('lists firestore_rules.test without credentials and answers it with the credentials error', async () => {
    const urls = stubRulesTestApi();
    const client = await connect();
    expect(await listedOps(client, 'firestore_rules')).toContain('test');
    expect(await callTestRules(client)).toMatchObject({ ok: false, summary: FIRESTORE_TEST_RULES_SCOPE_REQUIRED });
    expect(urls).toEqual([]);
    await client.close();
  });

  it('hands a supplied scope to the handlers', async () => {
    const urls = stubRulesTestApi();
    const scope = fakeScope();
    const client = await connect(scope);
    expect((await callTestRules(client)).ok).toBe(true);
    expect(scope.tokenCalls).toBe(1);
    expect(urls).toHaveLength(1);
    await client.close();
  });
});

describe('serve bridge mount', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function mountOn(scope?: ProjectScope): Promise<Client> {
    const mount: BridgeMount = createBridgeMount({ disableAuditLog: true, ...(scope ? { scope } : {}) });
    const http: Server = createServer((req, res) => {
      void mount.handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    cleanups.push(async () => {
      await mount.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    return connectHttp(`http://127.0.0.1:${port}/__pyric/mcp`);
  }

  it('lists firestore_rules.test without credentials and answers it with the credentials error', async () => {
    const urls = stubRulesTestApi();
    const client = await mountOn();
    expect(await listedOps(client, 'firestore_rules')).toContain('test');
    expect(await callTestRules(client)).toMatchObject({ ok: false, summary: FIRESTORE_TEST_RULES_SCOPE_REQUIRED });
    expect(urls).toEqual([]);
    await client.close();
  });

  it('hands a supplied scope to the handlers', async () => {
    const urls = stubRulesTestApi();
    const scope = fakeScope();
    const client = await mountOn(scope);
    expect((await callTestRules(client)).ok).toBe(true);
    expect(scope.tokenCalls).toBe(1);
    expect(urls).toHaveLength(1);
    await client.close();
  });
});
