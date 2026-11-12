import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getAuth as getInProcAuth, sandbox as authSandboxOps } from 'pyric/auth';
import { initializeApp as initAdminApp, deleteApp as deleteAdminApp } from 'pyric-admin/app';
import { getStorage as getAdminStorage } from 'pyric-admin/storage';

import { startServer } from '../../src/bridge/server/standalone.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get as getRtdb, ref as rtdbRef } from 'pyric/database';
import { databaseFor } from '../../src/bridge/surface/service-handles.js';
import { createLocalBridge } from '../../src/bridge/server/local-bridge.js';
import { registerRenderedSurface } from '../../src/bridge/server/surface-server.js';
import { TargetRouter } from '../../src/bridge/server/target-router.js';
import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { callMethod } from '../../src/bridge/surface/method-call.js';
import { methodByKey } from '../../src/bridge/surface/methods/registry.js';
import { runMcpProxy } from '../../src/cli/mcp-proxy.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { runServeReproCapture } from '../../src/cli/serve-repro.js';
import { type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import { spawnFunctionsChild } from '../../src/functions/spawn.js';
import { connectRemoteSandbox } from '../../src/remote/index.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import * as workerClient from '../../src/serve/worker/client.js';
import { handleAuthOp } from '../../src/serve/worker/host-auth.js';
import { connectClientToHost, makeHostCtx } from '../serve/worker/integration-support.js';

function makeInitPayload(projectId = 'demo-proj') {
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
    sessionToken: 'tok-hosted-test',
    appOptions: { projectId },
  };
}

function makeInMemoryHostedPersistence() {
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

function rawHttp(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('standalone /mcp loopback guards, isolated functions.fire, and session lifecycle', () => {
  it('enforces loopback Host/Origin/Sec-Fetch-Site guards across all HTTP methods on /mcp and 405 on unsupported local methods', async () => {
    const sb = initializeSandbox();
    const handle = await startServer({
      sandbox: sb,
      port: 0,
      silent: true,
      disableAuditLog: true,
    });
    try {
      for (const method of ['OPTIONS', 'HEAD', 'PUT', 'POST', 'GET', 'DELETE']) {
        const foreignHost = await rawHttp(handle.port, method, '/mcp', {
          Host: 'other.example',
          Origin: 'https://other.example',
          'Sec-Fetch-Site': 'cross-site',
        });
        expect(foreignHost.status).toBe(403);

        const crossOrigin = await rawHttp(handle.port, method, '/mcp', {
          Host: `127.0.0.1:${handle.port}`,
          Origin: 'https://other.example',
        });
        expect(crossOrigin.status).toBe(403);
      }

      const localOptions = await rawHttp(handle.port, 'OPTIONS', '/mcp', {
        Host: `127.0.0.1:${handle.port}`,
      });
      expect(localOptions.status).toBe(405);
      expect(String(localOptions.headers.allow)).toContain('POST');
    } finally {
      await handle.stop();
      sb.dispose();
    }
  });

  it('runs functions.fire in an isolated Swap-or-Stop child with stripped credentials and reloads edited source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-fire-unit-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolvePath(import.meta.dir, '../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-fn', type: 'module', main: 'index.mjs' }),
    );

    const writeFnSource = (rev: string) => {
      writeFileSync(
        join(fnDir, 'index.mjs'),
        [
          "import { onValueCreated } from 'firebase-functions/v2/database';",
          "import { getApps, initializeApp } from 'firebase-admin/app';",
          "export const onItemCreated = onValueCreated('/items/{itemId}', async (event) => {",
          "  const apps = getApps();",
          "  const app = apps.length > 0 ? apps[0] : initializeApp();",
          "  const isSwappedPyricAdmin = Boolean(app && 'sandbox' in app);",
          "  if (isSwappedPyricAdmin) {",
          `    await event.data.ref.parent.child('mirrored').set('${rev}:' + String(event.data.val()?.title ?? ''));`,
          "  }",
          `  return { rev: '${rev}', isSwappedPyricAdmin, adc: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null };`,
          "});",
        ].join('\n'),
      );
    };
    writeFnSource('rev-1');

    const prevAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'synthetic-adc-path.json';
    const sb = initializeSandbox();
    try {
      const ctx = createSurfaceContext(sb, dir);
      const fire1 = await callMethod(
        methodByKey('functions.fire'),
        { trigger: 'onItemCreated', path: 'items/a1', value: { title: 'first' } },
        ctx,
      );
      expect(fire1.ok).toBe(true);
      const r1 = (fire1.data as { result: { rev: string; isSwappedPyricAdmin: boolean; adc: string | null } }).result;
      expect(r1.isSwappedPyricAdmin).toBe(true);
      expect(r1.adc).toBeNull();
      expect(r1.rev).toBe('rev-1');

      const snap1 = await getRtdb(rtdbRef(databaseFor(ctx), 'items/mirrored'));
      expect(snap1.val()).toBe('rev-1:first');

      writeFnSource('rev-2');
      const fire2 = await callMethod(
        methodByKey('functions.fire'),
        { trigger: 'onItemCreated', path: 'items/a2', value: { title: 'second' } },
        ctx,
      );
      expect(fire2.ok).toBe(true);
      const r2 = (fire2.data as { result: { rev: string } }).result;
      expect(r2.rev).toBe('rev-2');

      const snap2 = await getRtdb(rtdbRef(databaseFor(ctx), 'items/mirrored'));
      expect(snap2.val()).toBe('rev-2:second');
    } finally {
      if (prevAdc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevAdc;
      sb.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown Mcp-Session-Id with 404 without allocating leaked sessions and frees closed sessions', async () => {
    const sb = initializeSandbox();
    const handle = await startServer({
      sandbox: sb,
      port: 0,
      maxSessions: 1,
      silent: true,
      disableAuditLog: true,
    });
    try {
      const stalePost = await fetch(handle.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': 'missing-session',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(stalePost.status).toBe(404);

      const badNoSessionPost = await fetch(handle.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(badNoSessionPost.status).toBe(400);

      const client1 = new Client({ name: 'c1', version: '1.0' });
      const transport1 = new StreamableHTTPClientTransport(new URL(handle.mcpUrl));
      await client1.connect(transport1);
      await client1.listTools();

      const staleDeleteAtCap = await fetch(handle.mcpUrl, {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'expired-session' },
      });
      expect(staleDeleteAtCap.status).toBe(404);

      await transport1.terminateSession();
      await client1.close();

      const client2 = new Client({ name: 'c2', version: '1.0' });
      await client2.connect(new StreamableHTTPClientTransport(new URL(handle.mcpUrl)));
      const listed = await client2.listTools();
      expect(listed.tools.length).toBeGreaterThan(0);
      await client2.close();
    } finally {
      await handle.stop();
      sb.dispose();
    }
  });
});

describe('TargetRouter caller identity propagation, MCP surface parity, and Live assurance gating', () => {
  it('forwards per-call and held caller identities to hosted runtime across attach and host restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-identity-router-unit-'));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));

    let hostRuntime = await createHostedRuntime(
      makeInitPayload(),
      'http://127.0.0.1:4100',
      () => {},
      dir,
      { persistence: makeInMemoryHostedPersistence() as never, record: false },
    );
    await hostRuntime.deployRules(
      'firestore',
      "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow read, write: if request.auth != null && request.auth.uid == 'owner-1'; } } }",
    );

    const inProcSb = initializeSandbox();
    let currentInstanceId = hostRuntime.instanceId;
    const conn = {};
    const router = new TargetRouter({
      projectDir: dir,
      cacheTtlMs: 0,
      discover: async () => ({
        pointerProjectDir: dir,
        url: 'http://localhost:4100',
        base: 'http://127.0.0.1:4100',
        mcpUrl: 'http://127.0.0.1:4100/__pyric/mcp',
        instanceId: currentInstanceId,
        source: `pointer ${join(dir, '.pyric', 'serve.json')}`,
      }),
      callHosted: async (_host, key, args, projectDir, allowProduction) =>
        hostRuntime.runMethod(
          { instanceId: currentInstanceId, projectDir, key, args, allowProduction },
          conn,
        ),
    });

    try {
      const ctx = createSurfaceContext(inProcSb, dir, router);
      const disc = renderSurface('discriminator');
      const mutateTool = disc.tools.find((t) => t.name === 'mutate_sandbox_data')!;

      const deniedDisc = await mutateTool.execute(
        {
          service: 'firestore',
          action: 'set',
          path: 'items/doc-1',
          dataJson: '{"v":1}',
          auth: { mode: 'uid', uid: 'intruder' },
        },
        ctx,
      );
      expect(deniedDisc.ok).toBe(false);

      const allowedDisc = await mutateTool.execute(
        {
          service: 'firestore',
          action: 'set',
          path: 'items/doc-1',
          dataJson: '{"v":1}',
          auth: { mode: 'uid', uid: 'owner-1' },
        },
        ctx,
      );
      expect(allowedDisc.ok).toBe(true);

      await callMethod(methodByKey('auth.impersonate'), { uid: 'intruder' }, ctx);

      await hostRuntime.close();
      hostRuntime = await createHostedRuntime(
        makeInitPayload(),
        'http://127.0.0.1:4101',
        () => {},
        dir,
        { persistence: makeInMemoryHostedPersistence() as never, record: false },
      );
      await hostRuntime.deployRules(
        'firestore',
        "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow read, write: if false; } } }",
      );
      currentInstanceId = hostRuntime.instanceId;

      const afterRestart = await callMethod(
        methodByKey('firestore.setDoc'),
        { path: 'items/after-restart', data: { v: 2 } },
        ctx,
      );
      expect(afterRestart.ok).toBe(false);
    } finally {
      inProcSb.dispose();
      await hostRuntime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('permits local assurance methods on a Live-mode hosted runtime while refusing sandbox mutations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-live-assurance-unit-'));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
    writeFileSync(
      join(dir, 'firestore.rules'),
      "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow read: if request.auth != null; } } }",
    );

    const runtime = await createHostedRuntime(
      makeInitPayload(),
      'http://127.0.0.1:4102',
      () => {},
      dir,
      {
        persistence: makeInMemoryHostedPersistence() as never,
        record: false,
        ownWriteRefusal: ({ action }) =>
          Object.assign(new Error(`Live refused ${action}`), { code: 'PYRIC_LIVE_REFUSED' }),
      },
    );
    try {
      const conn = {};
      const setDocRes = await runtime.runMethod(
        {
          instanceId: runtime.instanceId,
          projectDir: dir,
          key: 'firestore.setDoc',
          args: { path: 'items/a', data: { v: 1 } },
          allowProduction: false,
        },
        conn,
      );
      expect(setDocRes.ok).toBe(false);
      expect((setDocRes.data as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

      const deriveRes = await runtime.runMethod(
        {
          instanceId: runtime.instanceId,
          projectDir: dir,
          key: 'assurance.derive',
          args: { campaignId: 'audit-1' },
          allowProduction: false,
        },
        conn,
      );
      expect((deriveRes.data as { code?: string } | undefined)?.code).not.toBe('PYRIC_LIVE_REFUSED');
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves guard/unknown arguments across rendered MCP surfaces, routes Storage list on discriminator, and honors --surface/--project-dir in runMcpProxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-surface-parity-unit-'));
    const sb = initializeSandbox();
    const bridge = createLocalBridge(sb);
    const ctx = createSurfaceContext(sb, dir);

    await callMethod(
      methodByKey('sandbox.seed'),
      {
        users: [{ uid: 'u1', email: 'u1@example.test', password: 'secret-password' }],
        firestore: { 'items/pub': { visible: true }, 'items/priv': { visible: false } },
      },
      ctx,
    );

    const vpServer = new McpServer({ name: 'pyric', version: '1.0' });
    registerRenderedSurface(vpServer, bridge, renderSurface('verb-prefixed'), ctx);
    const [vpClientT, vpServerT] = InMemoryTransport.createLinkedPair();
    await vpServer.connect(vpServerT);
    const vpClient = new Client({ name: 'vp', version: '1.0' });
    await vpClient.connect(vpClientT);

    try {
      const exportCall = await vpClient.callTool({
        name: 'export_sandbox_fixture',
        arguments: { path: 'out.json', includePasswords: false },
      });
      const exportEnv = JSON.parse((exportCall.content as Array<{ text: string }>)[0]!.text);
      expect(exportEnv.ok).toBe(false);

      const whereCall = await vpClient.callTool({
        name: 'read_firestore_collection',
        arguments: { path: 'items', where: [['visible', '==', true]] },
      });
      const whereEnv = JSON.parse((whereCall.content as Array<{ text: string }>)[0]!.text);
      expect(whereEnv.ok).toBe(false);
    } finally {
      await vpClient.close();
      await vpServer.close();
    }

    const disc = renderSurface('discriminator');
    const storageTool = disc.tools.find((t) => t.name === 'manage_storage_files')!;
    await storageTool.execute(
      { action: 'upload', path: 'surface-docs/readme.txt', base64Content: 'aGVsbG8=' },
      ctx,
    );
    const listed = await storageTool.execute({ action: 'list', path: 'surface-docs' }, ctx);
    expect(listed.ok).toBe(true);
    expect((listed.data as { items: string[] }).items).toEqual(['surface-docs/readme.txt']);
    const storageResource = disc.resources?.find((r) => r.name === 'storage_objects');
    const metaRead = await storageResource!.read('pyric://storage/objects/surface-docs/readme.txt', ctx);
    expect(metaRead.ok).toBe(true);

    let delegatedOptions: unknown = null;
    const exitCode = await runMcpProxy(
      parseArgs(['mcp', '--surface', 'verb-prefixed', '--project-dir', '/other']),
      '/cwd-with-host',
      {
        discover: async (queriedDir) => ({
          pointerProjectDir: queriedDir,
          mcpUrl: 'http://127.0.0.1:3473/__pyric/mcp',
          url: 'http://localhost:3473',
          base: 'http://127.0.0.1:3473',
          instanceId: 'inst-1',
          source: 'pointer .pyric/serve.json',
        }),
        inProcess: async (_cwd, opts) => {
          delegatedOptions = opts;
          return 0;
        },
        env: {},
      },
    );
    expect(exitCode).toBe(0);
    expect(delegatedOptions).toMatchObject({ surface: 'verb-prefixed', projectDir: '/other' });

    sb.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Storage multi-bucket reset and CLI --url repro capture', () => {
  it('clears named Storage buckets alongside default bucket on sandbox.reset({ scope: "storage" })', async () => {
    const sb = initializeSandbox();
    const app = initAdminApp(
      { sandbox: sb, projectId: 'demo-proj', storageBucket: 'demo-proj.appspot.com' },
      'storage-reset-unit-admin',
    );
    try {
      const storage = getAdminStorage(app);
      await storage.bucket('demo-proj.appspot.com').file('items/a.txt').save('alpha');
      await storage.bucket('archive-bucket').file('items/b.txt').save('beta');

      const ctx = createSurfaceContext(sb, process.cwd());
      const res = await callMethod(
        methodByKey('sandbox.reset'),
        { scope: 'storage', confirm: true },
        ctx,
      );
      expect(res.ok).toBe(true);

      const [defFiles] = await storage.bucket('demo-proj.appspot.com').getFiles();
      const [arcFiles] = await storage.bucket('archive-bucket').getFiles();
      expect(defFiles).toHaveLength(0);
      expect(arcFiles).toHaveLength(0);
    } finally {
      await deleteAdminApp(app);
      sb.dispose();
    }
  });

  it('honors --url on pyric serve repro capture from outside the host directory', async () => {
    const hostDir = mkdtempSync(join(tmpdir(), 'pyric-repro-url-host-'));
    const callerDir = mkdtempSync(join(tmpdir(), 'pyric-repro-url-caller-'));
    let receivedBody: unknown = null;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === '/__pyric/health') {
          return Response.json({
            status: 'ok',
            mode: 'sandbox',
            instanceId: 'inst-repro-url',
            sandboxConnected: true,
          });
        }
        if (pathname === '/__pyric/init.json') {
          return Response.json({ workerInit: { projectKey: hostDir } });
        }
        if (pathname === '/__pyric/hosted/repro') {
          receivedBody = await req.json();
          return Response.json({ schema: 'pyric.repro.v1', entries: [], truncated: false });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const outPath = join(callerDir, 'captured.json');
      const code = await runServeReproCapture(
        parseArgs([
          'serve',
          'repro',
          'capture',
          '--url',
          `http://127.0.0.1:${server.port}`,
          '--out',
          outPath,
        ]),
        { cwd: callerDir, stdout: { write() {} }, stderr: { write() {} } },
      );
      expect(code).toBe(0);
      expect(receivedBody).toEqual({ instanceId: 'inst-repro-url', projectDir: hostDir });
      expect(JSON.parse(readFileSync(outPath, 'utf8')).schema).toBe('pyric.repro.v1');
    } finally {
      server.stop(true);
      rmSync(hostDir, { recursive: true, force: true });
      rmSync(callerDir, { recursive: true, force: true });
    }
  });

  it('suppresses background Functions trigger cascades during hosted functions.fire while delivering live snapshots to connectRemoteSandbox listeners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-fn-fire-scope-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolvePath(import.meta.dir, '../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({ functions: { source: 'functions' } }),
    );
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-hosted-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "export const onItemCreated = onValueCreated('/items/{itemId}', async (event) => {",
        "  await event.data.ref.parent.child('mirrored').set('rev-1:' + String(event.data.val()?.title ?? ''));",
        "  return { title: event.data.val()?.title ?? null };",
        "});",
      ].join('\n'),
    );

    const mount = createBridgeMount({
      hosted: true,
      projectKey: dir,
      disableAuditLog: true,
    });
    const httpServer = http.createServer((req, res) => {
      const port = (httpServer.address() as { port: number }).port;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      void mount.handler(req, res, url).then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await mount.startHostedSandbox(
      { ...makeInitPayload('demo-proj'), permissive: true, sessionToken: mount.sessionToken },
      baseUrl,
      { persistence: makeInMemoryHostedPersistence() as never, record: false },
    );
    const attachment = mount.attachHost({
      servers: [httpServer],
      projectDir: dir,
      origin: () => ({ host: '127.0.0.1', port }),
    });

    const childModule = resolvePath(import.meta.dir, '../../dist/functions/child.js');
    const bgEvents: FunctionsChildEvent[] = [];
    let bgChild: ReturnType<typeof spawnFunctionsChild> | undefined;
    let observer: Awaited<ReturnType<typeof connectRemoteSandbox>> | undefined;
    let stopMirroredSub: (() => void) | undefined;
    try {
      observer = await connectRemoteSandbox({
        url: baseUrl,
        sessionToken: mount.sessionToken,
        cwd: dir,
      });

      const mirroredUpdates: unknown[] = [];
      stopMirroredSub = observer.rtdb.onValue('items/mirrored', (snap) => {
        mirroredUpdates.push(snap.value ?? null);
      });

      bgChild = spawnFunctionsChild({
        cwd: fnDir,
        entry: join(fnDir, 'index.mjs'),
        childModuleUrl: pathToFileURL(childModule),
        env: buildChildEnv(process.env, {
          serveUrl: baseUrl,
          registerUrl: registerModuleUrl(),
          instanceId: mount.instanceId,
          sessionToken: mount.sessionToken,
        }),
        instance: 'demo-proj-default-rtdb',
        projectId: 'demo-proj',
        location: 'us-central1',
        onEvent: (ev) => bgEvents.push(ev),
      });
      await bgChild.ready;

      // Confirm the background child runs on normal RTDB writes first (and cascades when items/mirrored is created).
      for (let i = 0; i < 10; i++) {
        await observer.rtdb.set(`items/warmup-${i}`, { title: 'warm' });
        await new Promise((r) => setTimeout(r, 60));
        if ((await observer.rtdb.get('items/mirrored')) === 'rev-1:warm') break;
      }
      expect(await observer.rtdb.get('items/mirrored')).toBe('rev-1:warm');
      expect(bgEvents.length).toBeGreaterThan(0);
      await observer.rtdb.remove('items/mirrored');
      const clearDeadline = Date.now() + 3_000;
      while (!mirroredUpdates.includes(null) && Date.now() < clearDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      mirroredUpdates.length = 0;
      bgEvents.length = 0;

      const fireRes = await fetch(`${baseUrl}/__pyric/hosted/method`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-session-token': mount.sessionToken,
        },
        body: JSON.stringify({
          instanceId: mount.instanceId,
          projectDir: dir,
          key: 'functions.fire',
          args: {
            trigger: 'onItemCreated',
            path: 'items/synthetic-1',
            value: { title: 'alpha' },
          },
          allowProduction: false,
        }),
      });
      expect(fireRes.status).toBe(200);
      const fired = (await fireRes.json()) as { ok: boolean; data?: { result?: unknown } };
      expect(fired.ok).toBe(true);

      // Give any accidental background cascade a chance to surface, then verify isolation + live observer delivery.
      await new Promise((r) => setTimeout(r, 120));
      expect(await observer.rtdb.get('items/mirrored')).toBe('rev-1:alpha');
      expect(bgEvents).toHaveLength(0);
      expect(mirroredUpdates).toContain('rev-1:alpha');
    } finally {
      stopMirroredSub?.();
      if (bgChild) await bgChild.stop().catch(() => {});
      observer?.close();
      await attachment.close();
      await mount.close();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);

  it('routes serve-repro and TargetRouter loopback HTTPS requests through pinned self-signed TLS trust under Node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-https-loopback-pin-'));
    const callerDir = mkdtempSync(join(tmpdir(), 'pyric-https-loopback-caller-'));
    const keyPath = join(dir, 'server.key');
    const certPath = join(dir, 'server.pem');
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
          '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath,
        ],
        { stdio: 'ignore' },
      );
      const distRoot = resolvePath(import.meta.dir, '../../dist');
      const pyricSandboxUrl = pathToFileURL(
        resolvePath(import.meta.dir, '../../../pyric/dist/sandbox/index.js'),
      ).href;

      const script = `
        import https from 'node:https';
        import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { initializeSandbox } from ${JSON.stringify(pyricSandboxUrl)};
        import { hostTrustFor, honorsCertificatePin } from ${JSON.stringify(pathToFileURL(join(distRoot, 'remote/loopback-tls.js')).href)};
        import { parseArgs } from ${JSON.stringify(pathToFileURL(join(distRoot, 'cli/parse-args.js')).href)};
        import { runServeReproCapture } from ${JSON.stringify(pathToFileURL(join(distRoot, 'cli/serve-repro.js')).href)};
        import { TargetRouter } from ${JSON.stringify(pathToFileURL(join(distRoot, 'bridge/server/target-router.js')).href)};
        import { createSurfaceContext } from ${JSON.stringify(pathToFileURL(join(distRoot, 'bridge/surface/index.js')).href)};
        import { methodByKey } from ${JSON.stringify(pathToFileURL(join(distRoot, 'bridge/surface/methods/registry.js')).href)};

        if (!honorsCertificatePin()) {
          throw new Error('Expected Node runtime to honor certificate pinning');
        }

        const hostDir = realpathSync(${JSON.stringify(dir)});
        const callerDir = realpathSync(${JSON.stringify(callerDir)});
        const key = readFileSync(${JSON.stringify(keyPath)}, 'utf8');
        const cert = readFileSync(${JSON.stringify(certPath)}, 'utf8');
        let methodCalls = 0;

        const server = https.createServer({ key, cert }, (req, res) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const url = new URL(req.url ?? '/', 'https://127.0.0.1');
            res.setHeader('content-type', 'application/json');
            if (url.pathname === '/__pyric/health') {
              res.end(JSON.stringify({
                status: 'ok',
                mode: 'sandbox',
                instanceId: 'https-inst-1',
                sandboxConnected: true,
                live: { projectId: 'demo-proj' },
              }));
              return;
            }
            if (url.pathname === '/__pyric/init.json') {
              res.end(JSON.stringify({ workerInit: { projectKey: hostDir } }));
              return;
            }
            if (url.pathname === '/__pyric/hosted/repro') {
              res.end(JSON.stringify({ schema: 'pyric.repro.v1', entries: [1], truncated: false }));
              return;
            }
            if (url.pathname === '/__pyric/hosted/method') {
              methodCalls += 1;
              res.end(JSON.stringify({ ok: true, summary: 'https-hosted-ok' }));
              return;
            }
            res.statusCode = 404;
            res.end('{}');
          });
        });

        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        const origin = 'https://127.0.0.1:' + port;
        const trust = hostTrustFor(origin, { cert, key });
        mkdirSync(join(hostDir, '.pyric'), { recursive: true });
        writeFileSync(
          join(hostDir, '.pyric', 'serve.json'),
          JSON.stringify({
            url: origin,
            mcpUrl: origin + '/__pyric/mcp',
            port,
            pid: process.pid,
            instanceId: 'https-inst-1',
            token: 'https-tok-1',
            tls: { ca: trust.ca, fingerprint256: trust.fingerprint256 },
          }),
        );

        try {
          const out1 = join(hostDir, 'repro-discovered.json');
          const code1 = await runServeReproCapture(
            parseArgs(['serve', 'repro', 'capture', '--out', out1]),
            { cwd: hostDir, stdout: { write() {} }, stderr: { write() {} } },
          );
          if (code1 !== 0) throw new Error('Expected pointer HTTPS repro capture to exit 0, got ' + code1);

          const out2 = join(callerDir, 'repro-explicit.json');
          const code2 = await runServeReproCapture(
            parseArgs(['serve', 'repro', 'capture', '--url', origin, '--project-dir', hostDir, '--out', out2]),
            { cwd: callerDir, stdout: { write() {} }, stderr: { write() {} } },
          );
          if (code2 !== 0) throw new Error('Expected --url HTTPS repro capture to exit 0, got ' + code2);

          const sb = initializeSandbox();
          const router = new TargetRouter({ projectDir: hostDir, cacheTtlMs: 0 });
          const ctx = createSurfaceContext(sb, hostDir, router);
          const routed = await router.dispatch(methodByKey('auth.whoami'), {}, ctx, false);
          sb.dispose();
          if (!routed.ok || methodCalls !== 1 || router.getCurrentTarget() !== 'host' || router.getCurrentMode() !== 'live') {
            throw new Error('Unexpected TargetRouter HTTPS dispatch result: ' + JSON.stringify({
              routed,
              methodCalls,
              target: router.getCurrentTarget(),
              mode: router.getCurrentMode(),
            }));
          }
        } finally {
          await new Promise((r) => server.close(r));
        }
      `;

      const res = spawnSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (res.status !== 0) {
        throw new Error(`Node HTTPS TLS pin probe failed (status ${res.status}):\n${res.stderr}\n${res.stdout}`);
      }
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(callerDir, { recursive: true, force: true });
    }
  });
});

describe('worker auth multi-tenant isolation, currentUser reference parity, and session claim restoration', () => {
  it('isolates multi-tenant OAuth sign-in and adminCreateUser across worker host and client', async () => {
    const ctx = await makeHostCtx();
    try {
      const hostAuth = getInProcAuth(ctx.sandbox);
      authSandboxOps.seedUsers(hostAuth, [
        { uid: 'beta-alice', email: 'alice@example.test', displayName: 'Beta Alice', tenantId: 'org-beta' },
      ]);

      const { db: alphaDb } = connectClientToHost(ctx, 'worker://tenant-alpha');
      const alphaAuth = workerClient.getAuth(alphaDb);
      alphaAuth.tenantId = 'org-alpha';

      const accepted = await workerClient.acceptProviderCredential(alphaAuth, {
        uid: '',
        providerId: 'google.com',
        email: 'alice@example.test',
        displayName: 'Alpha Alice',
        photoURL: null,
        customClaims: {},
      });
      expect(accepted.user.uid).not.toBe('beta-alice');
      expect(accepted.user.tenantId).toBe('org-alpha');

      workerClient.stageSignInResult(alphaAuth, {
        user: { uid: 'alpha-carol', email: 'carol@example.test', emailVerified: true },
        providerId: 'google.com',
      });
      const stagedCred = await workerClient.signInWithCredential(alphaAuth, {
        providerId: 'google.com',
        signInMethod: 'google.com',
      });
      expect(stagedCred.user.tenantId).toBe('org-alpha');

      const created = await workerClient.adminCreateUser(alphaAuth, {
        uid: 'beta-bob',
        email: 'bob@example.test',
        tenantId: 'org-beta',
      });
      expect(created.tenantId).toBe('org-beta');

      const users = authSandboxOps.listUsers(hostAuth);
      expect(users.find((u) => u.uid === 'beta-alice')?.displayName).toBe('Beta Alice');
      expect(users.find((u) => u.uid === 'alpha-carol')?.tenantId).toBe('org-alpha');
      expect(users.find((u) => u.uid === 'beta-bob')?.tenantId).toBe('org-beta');
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('preserves ClientAuth.currentUser reference identity across multiple listeners and forced token refreshes', async () => {
    const ctx = await makeHostCtx();
    try {
      const { db } = connectClientToHost(ctx, 'worker://auth-user-ref');
      const auth = workerClient.getAuth(db);

      let u1: workerClient.ClientUser | null = null;
      let u2: workerClient.ClientUser | null = null;
      let authStateEvents = 0;
      const off1 = workerClient.onAuthStateChanged(auth, (u) => {
        if (u) authStateEvents += 1;
        u1 = u;
      });
      const off2 = workerClient.onAuthStateChanged(auth, (u) => {
        u2 = u;
      });

      const cred = await workerClient.createUserWithEmailAndPassword(
        auth,
        'member@example.test',
        'secret-pass-1',
      );
      await new Promise((r) => setTimeout(r, 30));

      const initialRef = auth.currentUser;
      expect(initialRef).not.toBeNull();
      expect(initialRef).toBe(cred.user);
      expect(u1).toBe(initialRef);
      expect(u2).toBe(initialRef);

      const eventsBefore = authStateEvents;
      await initialRef!.getIdTokenResult(true);
      await initialRef!.getIdToken(true);
      await new Promise((r) => setTimeout(r, 30));

      expect(auth.currentUser).toBe(initialRef);
      expect(authStateEvents).toBe(eventsBefore);

      off1();
      off2();
    } finally {
      ctx.sandbox.dispose();
    }
  });

  it('restores recorded non-custom session customClaims (including own __proto__ keys) on auth.restorePortSession', async () => {
    const ctx = await makeHostCtx();
    try {
      setFirestoreRules(
        ctx.sandbox,
        "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow read: if request.auth != null && request.auth.token.role == 'admin'; } } }",
      );
      const hostAuth = getInProcAuth(ctx.sandbox);
      authSandboxOps.createUser(hostAuth, {
        uid: 'u-repro',
        email: 'repro@example.test',
        password: 'password123',
        customClaims: {},
      });

      const { db } = connectClientToHost(ctx, 'worker://session-restore');
      const protoClaims = JSON.parse('{"role":"admin","__proto__":{"tier":"gold"}}') as Record<
        string,
        unknown
      >;
      await new Promise<void>((resolve, reject) => {
        const fakeReplyPort = {
          postMessage(msg: unknown) {
            const m = msg as { t?: string; ok?: boolean; error?: { message?: string } };
            if (m.t === 'res') {
              if (m.ok) resolve();
              else reject(new Error(m.error?.message ?? 'restore failed'));
            }
          },
        };
        void handleAuthOp(
          ctx,
          (db.port as unknown as { hostPort?: unknown }).hostPort
            ? ((db.port as unknown as { hostPort: never }).hostPort)
            : (fakeReplyPort as never),
          {
            t: 'op',
            id: 'restore-1',
            method: 'auth.restorePortSession',
            uid: 'u-repro',
            tenantId: null,
            customClaims: protoClaims,
            signInProvider: 'password',
          } as never,
        );
      });

      const sessions = [...(ctx.portSessions?.values() ?? [])].filter(Boolean);
      expect(sessions.length).toBeGreaterThan(0);
      const restored = sessions[0]!;
      expect(restored.state.token?.role).toBe('admin');
      expect(Object.hasOwn(restored.state.token ?? {}, '__proto__')).toBe(true);
    } finally {
      ctx.sandbox.dispose();
    }
  });
});
