/**
 * Shared MCP client/server harness and per-variant operation adapters for the
 * five-surface MCP entrypoint parity suite (`five-surface-entrypoint-parity.test.ts`).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMemoryBackend, initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { resolveFirebaseProject } from '../../src/cli/firebase-project.js';
import type { BridgeToolEvent } from '../../src/bridge/server/bridge.js';
import { createLocalBridge } from '../../src/bridge/server/local-bridge.js';
import { registerRenderedSurface } from '../../src/bridge/server/surface-server.js';
import { TargetRouter } from '../../src/bridge/server/target-router.js';
import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { spellName, wordsFor } from '../../src/bridge/surface/render/method-words.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { readPyricConfigProjectSync } from '../../src/serve/live-project.js';
import { createSandboxSession } from '../../src/serve/sandbox-session.js';

export interface Envelope {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
}

export interface McpSurfaceClient {
  variant: string;
  client: Client;
  events: BridgeToolEvent[];
  sandbox: LocalSandbox;
  close(): Promise<void>;
}

export function makeHostedInit(projectId: string) {
  return {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    permissive: false,
    projectKey: projectId,
    sessionToken: 'tok-five-surface-test',
    appOptions: { projectId },
  };
}

export function makeInMemoryPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

export async function openHostedLoopbackBridge(projectDir: string): Promise<{
  makeRouter(): TargetRouter;
  close(): Promise<void>;
}> {
  const project = resolveFirebaseProject({
    projectDir,
    configProject: readPyricConfigProjectSync(projectDir),
  });
  const sandboxSession = await createSandboxSession({
    projectDir,
    firebaseConfig: JSON.parse(readFileSync(join(projectDir, 'firebase.json'), 'utf8')),
    project,
    capture: false,
    sdk: { dir: projectDir },
  });
  const mount = createBridgeMount({
    project: project.projectId ?? 'demo-project',
    projectKey: projectDir,
    hosted: true,
    sessionToken: sandboxSession.sessionToken,
    disableAuditLog: true,
    upgradeGuard: { boundHost: '127.0.0.1' },
  });
  let baseUrl = 'http://127.0.0.1:0';
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', baseUrl);
    if (await mount.handler(req, res, url)) return;
    if (await sandboxSession.handle(req, res, url)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', rejectListen);
      resolveListen();
    });
  });
  const port = (httpServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  mount.attachHost({
    servers: [httpServer],
    projectDir,
    origin: () => ({ host: '127.0.0.1', port }),
  });
  await mount.startHostedSandbox(
    {
      ...sandboxSession.payload(),
      hosted: true,
      bridgeUrl: mount.wsUrl({ host: '127.0.0.1', port }),
    },
    () => baseUrl,
    { persistence: makeInMemoryPersistence() as never, record: false },
  );
  return {
    makeRouter: () => new TargetRouter({ projectDir, cacheTtlMs: 0 }),
    async close() {
      await mount.close();
      await sandboxSession.close();
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

export async function openMcpVariant(
  variant: string,
  projectDir: string,
  router?: TargetRouter,
): Promise<McpSurfaceClient> {
  const sandbox = initializeSandbox({ projectId: 'org-alpha' });
  const events: BridgeToolEvent[] = [];
  const bridge = createLocalBridge(sandbox, { onToolEvent: (e) => events.push(e) });
  const server = new McpServer({ name: 'pyric', version: bridge.version });
  const ctx = createSurfaceContext(sandbox, projectDir, router);
  registerRenderedSurface(server, bridge, renderSurface(variant), ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: `parity-${variant}`, version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    variant,
    client,
    events,
    sandbox,
    async close() {
      await client.close();
      await server.close();
      sandbox.dispose();
    },
  };
}

export function parseToolEnvelope(raw: Record<string, unknown>): Envelope {
  const entries = (raw.content ?? []) as Array<{ text?: string }>;
  return JSON.parse(entries[0]?.text ?? '{}') as Envelope;
}

export function parseResourceEnvelope(raw: {
  contents?: ReadonlyArray<{ text?: string; blob?: string }>;
}): Envelope {
  return JSON.parse(raw.contents?.[0]?.text ?? '{}') as Envelope;
}

function namedToolFor(variant: string, methodKey: string): string {
  const words = wordsFor(methodKey);
  if (variant === 'verb-prefixed') return spellName([words.verb, words.service, words.object]);
  if (variant === 'noun-prefixed') return spellName([words.service, words.object, words.verb]);
  if (variant === 'verb-suffixed') return spellName([words.verb, words.object, words.service]);
  throw new Error(`unexpected named variant ${variant}`);
}

export async function callMethodOnVariant(
  session: McpSurfaceClient,
  methodKey: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  if (session.variant === 'sdk-service') {
    const [tool, method] = methodKey.split('.');
    const res = await session.client.callTool({
      name: tool!,
      arguments: { method: method!, args },
    });
    return parseToolEnvelope(res);
  }
  const res = await session.client.callTool({
    name: namedToolFor(session.variant, methodKey),
    arguments: args,
  });
  return parseToolEnvelope(res);
}

export async function switchAnonymous(session: McpSurfaceClient): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'switch_auth_identity',
        arguments: { mode: 'anonymous' },
      }),
    );
  }
  return callMethodOnVariant(session, 'auth.actAsAnonymous', {});
}

export async function switchAdmin(session: McpSurfaceClient): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'switch_auth_identity',
        arguments: { mode: 'admin' },
      }),
    );
  }
  return callMethodOnVariant(session, 'auth.actAsAdmin', {});
}

export async function impersonateUser(
  session: McpSurfaceClient,
  uid: string,
  tenantId?: string,
  customClaims?: Record<string, unknown>,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    const argumentsObj: Record<string, unknown> = { mode: 'uid', uid };
    if (tenantId !== undefined) argumentsObj.tenant = tenantId;
    if (customClaims !== undefined) argumentsObj.claimsJson = JSON.stringify(customClaims);
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'switch_auth_identity',
        arguments: argumentsObj,
      }),
    );
  }
  const args: Record<string, unknown> = { uid };
  if (tenantId !== undefined) args.tenantId = tenantId;
  if (customClaims !== undefined) args.customClaims = customClaims;
  return callMethodOnVariant(session, 'auth.impersonate', args);
}

export async function importUsers(
  session: McpSurfaceClient,
  users: Array<Record<string, unknown>>,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'manage_auth_users',
        arguments: { action: 'import', usersJson: JSON.stringify(users) },
      }),
    );
  }
  return callMethodOnVariant(session, 'auth.importUsers', { users });
}

export async function setFirestoreDoc(
  session: McpSurfaceClient,
  path: string,
  data: Record<string, unknown>,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'mutate_sandbox_data',
        arguments: {
          service: 'firestore',
          action: 'set',
          path,
          dataJson: JSON.stringify(data),
        },
      }),
    );
  }
  return callMethodOnVariant(session, 'firestore.setDoc', { path, data });
}

export async function readFirestoreDoc(
  session: McpSurfaceClient,
  path: string,
  encodedUriPath?: string,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    const tail = encodedUriPath ?? path;
    return parseResourceEnvelope(
      await session.client.readResource({ uri: `pyric://firestore/docs/${tail}` }),
    );
  }
  return callMethodOnVariant(session, 'firestore.getDoc', { path });
}

export async function listFirestoreCollection(
  session: McpSurfaceClient,
  path: string,
  encodedUriPath?: string,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    const tail = encodedUriPath ?? path;
    return parseResourceEnvelope(
      await session.client.readResource({ uri: `pyric://firestore/docs/${tail}` }),
    );
  }
  return callMethodOnVariant(session, 'firestore.getDocs', { path });
}

export async function setDatabaseValue(
  session: McpSurfaceClient,
  path: string,
  value: unknown,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'mutate_sandbox_data',
        arguments: {
          service: 'database',
          action: 'set',
          path,
          dataJson: JSON.stringify(value),
        },
      }),
    );
  }
  return callMethodOnVariant(session, 'database.set', { path, value });
}

export async function readDatabaseValue(
  session: McpSurfaceClient,
  path: string,
  encodedUriPath?: string,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    const tail = encodedUriPath ?? path;
    return parseResourceEnvelope(
      await session.client.readResource({ uri: `pyric://database/tree/${tail}` }),
    );
  }
  return callMethodOnVariant(session, 'database.get', { path });
}

export async function uploadStorageObject(
  session: McpSurfaceClient,
  path: string,
  contentBase64: string,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'manage_storage_files',
        arguments: {
          action: 'upload',
          path,
          base64Content: contentBase64,
          contentType: 'text/plain',
        },
      }),
    );
  }
  return callMethodOnVariant(session, 'storage.uploadBytes', {
    path,
    contentBase64,
    metadata: { contentType: 'text/plain' },
  });
}

export async function readStorageMetadata(
  session: McpSurfaceClient,
  path: string,
  encodedUriPath?: string,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    const tail = encodedUriPath ?? path;
    return parseResourceEnvelope(
      await session.client.readResource({ uri: `pyric://storage/objects/${tail}` }),
    );
  }
  return callMethodOnVariant(session, 'storage.getMetadata', { path });
}

export async function listTriggersOnVariant(session: McpSurfaceClient): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'manage_functions',
        arguments: { action: 'list_triggers' },
      }),
    );
  }
  return callMethodOnVariant(session, 'functions.listTriggers', {});
}

export async function fireTriggerOnVariant(
  session: McpSurfaceClient,
  trigger: string,
  path: string,
  value: unknown,
): Promise<Envelope> {
  if (session.variant === 'discriminator') {
    return parseToolEnvelope(
      await session.client.callTool({
        name: 'manage_functions',
        arguments: {
          action: 'fire',
          trigger,
          path,
          valueJson: JSON.stringify(value),
        },
      }),
    );
  }
  return callMethodOnVariant(session, 'functions.fire', { trigger, path, value });
}
