/**
 * End-to-end denial parity across capture, `sandbox.events` (SDK-service,
 * verb-prefixed, discriminator, CLI, and in-process MCP), and `sandbox.inspect`.
 *
 * Verifies:
 *  - Every rules-evaluating service (Firestore, RTDB, Storage) and denial shape
 *    (write, read, listener) carries the same deciding rule text and reasons as
 *    the capture.
 *  - `request`, `resourceBefore`, and `resourceAfter` are omitted by default
 *    and appear only when `detail: true` (or CLI `--detail`).
 *  - Expired Firestore rules evidence sets `denial.evidenceExpired: true`.
 *  - The `sandbox events` description points callers to `pyric serve denials`.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  get as rtdbGet,
  getAdminDatabase,
  getDatabase,
  onValue,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  set as rtdbSet,
} from 'pyric/database';
import { collection, doc, getDoc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';
import {
  initializeSandbox,
  type LocalSandbox,
  type OperationRecord,
  type RequestEvent,
  type SandboxEvent,
  type SandboxOperationEvent,
} from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getBytes, getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';

import {
  runInProcessMcp,
} from '../../../../../src/bridge/server/in-process.js';
import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
import { methodByKey } from '../../../../../src/bridge/surface/methods/registry.js';
import { parseArgs } from '../../../../../src/cli/parse-args.js';
import { argumentsFromFlags } from '../../../../../src/cli/surface-method-args.js';
import { runSurfaceMethod } from '../../../../../src/cli/surface-method-runner.js';
import { HOSTED_METHOD_PATH } from '../../../../../src/serve/hosted/method-protocol.js';
import { buildVerifyFixture } from '../../../../../src/verify/fixture.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
      allow write: if request.auth != null && request.auth.uid == request.resource.data.owner;
    }
  }
}`;

const RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': 'auth.uid === $id',
        '.write': 'auth.uid === $id',
      },
    },
  },
};

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

type DetailedRecord = OperationRecord & {
  request?: unknown;
  resourceBefore?: unknown;
  resourceAfter?: unknown;
};

interface EventsPayload {
  events: DetailedRecord[];
  nextCursor: string | null;
}

interface InspectPayload {
  events: {
    recentDenials: Array<{
      path: string;
      method: string;
      rule?: { citation?: string; expression?: string; path?: string };
      reasons?: string[];
      evidenceExpired?: true;
    }>;
  };
}

const sdkSurface = renderSurface(undefined);
const verbSurface = renderSurface('verb-prefixed');
const discriminatorSurface = renderSurface('discriminator');

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;
let storageSeq = 0;

function storageDb(label: string): string {
  storageSeq += 1;
  return `events-denial-parity-${label}-${storageSeq}`;
}

async function runSdk(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = sdkSurface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

async function runVerb(toolName: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const tool = verbSurface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute(args, ctx);
}

async function runDiscriminator(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const tool = discriminatorSurface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute(args, ctx);
}

function awaitDeniedListener(subscribe: (onError: () => void) => () => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = subscribe(() => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => {
        unsubscribe();
        resolve();
      });
    });
  });
}

async function plantCrossServiceDenials(target: LocalSandbox): Promise<void> {
  setRules(target, FIRESTORE_RULES);
  seedDocuments(target, { 'items/item-1': { owner: 'user-1', secret: 'keep-private' } });

  const fsDb = getFirestore(target.withAuth({ uid: 'user-2' }));
  await getDoc(doc(fsDb, 'items/item-1')).catch(() => undefined);
  await setDoc(doc(fsDb, 'items/item-1'), { owner: 'user-1', secret: 'candidate-write' }).catch(
    () => undefined,
  );
  await awaitDeniedListener((onError) =>
    onSnapshot(doc(fsDb, 'items/item-1'), () => {}, onError),
  );
  await awaitDeniedListener((onError) =>
    onSnapshot(collection(fsDb, 'items'), () => {}, onError),
  );

  const rtdb = getDatabase(target.withAuth({ uid: 'user-2' }));
  rtdbSandbox.setRules(rtdb, RTDB_RULES);
  await rtdbSet(rtdbRef(getAdminDatabase(target), 'items/user-1'), { secret: 'rtdb-private' });
  await rtdbGet(rtdbRef(rtdb, 'items/user-1')).catch(() => undefined);
  await rtdbSet(rtdbRef(rtdb, 'items/user-1'), { secret: 'rtdb-candidate' }).catch(() => undefined);
  await awaitDeniedListener((onError) =>
    onValue(rtdbRef(rtdb, 'items/user-1'), () => {}, onError),
  );

  const adminStorage = getAdminStorageSandbox(target, { dbName: storageDb('cross-service') });
  await replaceStorageRules(target, STORAGE_RULES);
  await uploadBytes(
    storageRef(adminStorage, 'files/user-1/note.txt'),
    new Uint8Array([1, 2, 3]),
    { contentType: 'text/plain' },
  );
  const clientStorage = getStorageSandbox(target.withAuth({ uid: 'user-2' }));
  await getBytes(storageRef(clientStorage, 'files/user-1/note.txt')).catch(() => undefined);
  await uploadBytes(
    storageRef(clientStorage, 'files/user-1/note.txt'),
    new Uint8Array([4, 5, 6, 7]),
    { contentType: 'text/plain' },
  ).catch(() => undefined);
}

function assertNoPayloads(records: readonly DetailedRecord[]): void {
  for (const record of records) {
    expect('request' in record).toBe(false);
    expect('resourceBefore' in record).toBe(false);
    expect('resourceAfter' in record).toBe(false);
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-events-denial-parity-'));
  sandbox = initializeSandbox();
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('sandbox events denial parity and detail flag', () => {
  it('exposes the same deciding rule and reasons as the capture across all services and surfaces', async () => {
    await plantCrossServiceDenials(sandbox);

    const capture = buildVerifyFixture({
      sandbox,
      firestoreRules: FIRESTORE_RULES,
      rtdbRules: RTDB_RULES,
      storageRules: STORAGE_RULES,
    });
    const captureById = new Map<string, SandboxEvent>(
      capture.events.map((event) => [event.id, event]),
    );

    const defaultDenials = await runSdk('sandbox.events', { kind: 'denials', limit: 50 });
    expect(defaultDenials.ok).toBe(true);
    const denialRecords = (defaultDenials.data as EventsPayload).events;
    assertNoPayloads(denialRecords);

    // Every service (Firestore, RTDB, Storage) and denial shape must match the capture.
    const fsGet = denialRecords.find(
      (r) => r.service === 'firestore' && r.method === 'get' && r.path === 'items/item-1',
    );
    const fsSet = denialRecords.find((r) => r.service === 'firestore' && r.method === 'set');
    const fsList = denialRecords.find((r) => r.service === 'firestore' && r.method === 'list');
    const rtdbRead = denialRecords.find((r) => r.service === 'rtdb' && r.method === 'get');
    const rtdbWrite = denialRecords.find((r) => r.service === 'rtdb' && r.method === 'set');
    const rtdbListen = denialRecords.find((r) => r.service === 'rtdb' && r.method === 'listen');
    const stRead = denialRecords.find((r) => r.service === 'storage' && r.method === 'get');
    const stWrite = denialRecords.find((r) => r.service === 'storage' && r.method === 'create');

    for (const record of [fsGet, fsSet, fsList, rtdbRead, rtdbWrite, rtdbListen, stRead, stWrite]) {
      expect(record).toBeDefined();
      const raw = captureById.get(record!.id);
      expect(raw).toBeDefined();
      expect(record!.denial).toBeDefined();
      if (raw!.kind === 'request') {
        expect(record!.denial!.reasons).toEqual(raw!.reasons);
        if (raw!.evaluatedRule !== undefined) {
          expect(record!.denial!.rule?.expression).toBe(raw!.evaluatedRule.expression);
          expect(record!.denial!.rule?.citation).toBe(raw!.evaluatedRule.citation);
        }
      } else if (raw!.kind === 'operation') {
        expect(record!.denial!.reasons).toEqual(raw!.reasons ?? []);
        if (raw!.rules?.matchedPath) {
          expect(record!.denial!.rule?.path).toBe(raw!.rules.matchedPath);
        }
        if (raw!.rules?.matchedRule) {
          expect(record!.denial!.rule?.expression).toBe(raw!.rules.matchedRule);
        }
      }
    }

    // Listener lifecycle page (`kind: 'listeners'`) correlates Firestore denied listeners and RTDB denied listeners.
    const listenersDefault = await runSdk('sandbox.events', { kind: 'listeners', limit: 50 });
    expect(listenersDefault.ok).toBe(true);
    const listenerRecords = (listenersDefault.data as EventsPayload).events;
    assertNoPayloads(listenerRecords);

    const erroredFsDoc = listenerRecords.find(
      (r) => r.service === 'firestore' && r.method === 'errored' && r.path === 'items/item-1',
    );
    const erroredFsQuery = listenerRecords.find(
      (r) => r.service === 'firestore' && r.method === 'errored' && r.path === 'items',
    );
    const erroredRtdb = listenerRecords.find(
      (r) => r.service === 'rtdb' && r.method === 'errored' && r.path === '/items/user-1',
    );

    const rawFsDocListenerReq = capture.events.find(
      (e): e is RequestEvent & SandboxEvent =>
        e.kind === 'request' && e.origin === 'listener' && e.method === 'get' && e.result === 'deny',
    )!;
    const rawFsQueryListenerReq = capture.events.find(
      (e): e is RequestEvent & SandboxEvent =>
        e.kind === 'request' && e.origin === 'listener' && e.method === 'list' && e.result === 'deny',
    )!;
    const rawRtdbListenerOp = capture.events.find(
      (e): e is SandboxOperationEvent & SandboxEvent =>
        e.kind === 'operation' && e.service === 'rtdb' && e.method === 'listen' && e.result === 'deny',
    )!;

    expect(erroredFsDoc?.denial?.reasons).toEqual(rawFsDocListenerReq.reasons);
    expect(erroredFsDoc?.denial?.rule?.expression).toBe(rawFsDocListenerReq.evaluatedRule?.expression);
    expect(erroredFsDoc?.denial?.rule?.citation).toBe(rawFsDocListenerReq.evaluatedRule?.citation);
    expect(erroredFsQuery?.denial?.reasons).toEqual(rawFsQueryListenerReq.reasons);
    expect(erroredRtdb?.denial?.reasons).toEqual(rawRtdbListenerOp.reasons ?? []);
    expect(erroredRtdb?.denial?.rule).toEqual({
      path: '/items/$id',
      expression: 'auth.uid === $id',
    });

    // `detail: true` exposes request, resourceBefore, resourceAfter across all surface variants.
    const detailedSdk = await runSdk('sandbox.events', { kind: 'denials', limit: 50, detail: true });
    const detailedVerb = await runVerb('list_sandbox_events', {
      kind: 'denials',
      limit: 50,
      detail: true,
    });
    const detailedDisc = await runDiscriminator('control_sandbox_environment', {
      action: 'events',
      kind: 'denials',
      limit: 50,
      detail: true,
    });
    expect(detailedSdk.ok).toBe(true);
    expect(detailedVerb.ok).toBe(true);
    expect(detailedDisc.ok).toBe(true);
    expect((detailedVerb.data as EventsPayload).events).toEqual(
      (detailedSdk.data as EventsPayload).events,
    );
    expect((detailedDisc.data as EventsPayload).events).toEqual(
      (detailedSdk.data as EventsPayload).events,
    );

    const detailedEvents = (detailedSdk.data as EventsPayload).events;
    const fsSetDetailed = detailedEvents.find(
      (r) => r.service === 'firestore' && r.method === 'set',
    );
    expect(fsSetDetailed?.request).toMatchObject({
      resourceData: { owner: 'user-1', secret: 'candidate-write' },
    });
    expect(fsSetDetailed?.resourceBefore).toMatchObject({
      exists: true,
      data: { owner: 'user-1', secret: 'keep-private' },
    });
    expect(fsSetDetailed?.resourceAfter).toMatchObject({
      exists: true,
      data: { owner: 'user-1', secret: 'keep-private' },
    });

    const rtdbSetDetailed = detailedEvents.find((r) => r.service === 'rtdb' && r.method === 'set');
    expect(rtdbSetDetailed?.request).toMatchObject({ data: { secret: 'rtdb-candidate' } });
    expect(rtdbSetDetailed?.resourceBefore).toMatchObject({
      exists: true,
      data: { secret: 'rtdb-private' },
    });
    expect(rtdbSetDetailed?.resourceAfter).toMatchObject({
      exists: true,
      data: { secret: 'rtdb-candidate' },
    });

    const stWriteDetailed = detailedEvents.find(
      (r) => r.service === 'storage' && r.method === 'create',
    );
    expect(stWriteDetailed?.request).toMatchObject({
      resourceData: { name: 'files/user-1/note.txt', size: 4, contentType: 'text/plain' },
    });
    expect(stWriteDetailed?.resourceBefore).toMatchObject({
      exists: true,
      data: { name: 'files/user-1/note.txt', size: 3, contentType: 'text/plain' },
    });

    // Detailed listener page includes Firestore doc listener's resourceBefore.
    const listenersDetailed = await runSdk('sandbox.events', {
      kind: 'listeners',
      limit: 50,
      detail: true,
    });
    const erroredFsDocDetailed = (listenersDetailed.data as EventsPayload).events.find(
      (r) => r.service === 'firestore' && r.method === 'errored' && r.path === 'items/item-1',
    );
    expect(erroredFsDocDetailed?.resourceBefore).toMatchObject({
      exists: true,
      data: { owner: 'user-1', secret: 'keep-private' },
    });

    // `sandbox.inspect` agrees on reasons and deciding rules across all three services.
    const inspected = await runSdk('sandbox.inspect', { recentEventLimit: 20 });
    expect(inspected.ok).toBe(true);
    const recentDenials = (inspected.data as InspectPayload).events.recentDenials;
    expect(
      recentDenials.some(
        (d) =>
          d.path === 'items/item-1' &&
          d.method === 'set' &&
          d.rule?.expression ===
            'request.auth != null && request.auth.uid == request.resource.data.owner' &&
          (d.reasons?.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(
      recentDenials.some(
        (d) =>
          d.path === '/items/user-1' &&
          d.method === 'set' &&
          d.rule?.path === '/items/$id' &&
          d.rule?.expression === 'auth.uid === $id' &&
          (d.reasons?.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(
      recentDenials.some(
        (d) =>
          d.path === 'files/user-1/note.txt' &&
          d.method === 'create' &&
          d.reasons?.[0]?.includes('match /files/{uid}/{name}'),
      ),
    ).toBe(true);
  });

  it('supports CLI --detail and MCP sandbox.events parity with default payload redaction', async () => {
    const cliDir = mkdtempSync(join(tmpdir(), 'pyric-cli-events-detail-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'pyric-cli-events-home-'));
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      writeFileSync(join(cliDir, 'firestore.rules'), FIRESTORE_RULES);
      writeFileSync(
        join(cliDir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
      );

      // Verify CLI boolean flag parsing accepts --detail and --detail false.
      const eventsMethod = methodByKey('sandbox.events');
      expect(
        argumentsFromFlags(eventsMethod, parseArgs(['sandbox', 'events', '--kind', 'denials', '--detail'])),
      ).toEqual({ args: { kind: 'denials', detail: true } });
      expect(
        argumentsFromFlags(eventsMethod, parseArgs(['sandbox', 'events', '--detail', 'false'])),
      ).toEqual({ args: { detail: false } });

      // 1. CLI `pyric sandbox events` against a hosted loopback endpoint carrying a planted denial.
      const hostedSandbox = initializeSandbox();
      setRules(hostedSandbox, FIRESTORE_RULES);
      seedDocuments(hostedSandbox, { 'items/item-1': { owner: 'user-1', secret: 'cli-private' } });
      await setDoc(doc(getFirestore(hostedSandbox.withAuth({ uid: 'user-2' })), 'items/item-1'), {
        owner: 'user-1',
        secret: 'cli-candidate',
      }).catch(() => undefined);
      const hostedCtx = createSurfaceContext(hostedSandbox, cliDir);
      const server = createServer((req, res) => {
        if (req.url !== HOSTED_METHOD_PATH || req.method !== 'POST') {
          res.statusCode = 404;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            key: string;
            args: Record<string, unknown>;
          };
          void methodByKey(body.key)
            .handler(body.args, hostedCtx)
            .then((result) => {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(result));
            });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const host = {
        url: `http://127.0.0.1:${port}`,
        mcpUrl: `http://127.0.0.1:${port}/__pyric/mcp`,
        base: `http://127.0.0.1:${port}`,
        instanceId: 'test-instance',
        source: 'pointer .pyric/serve.json',
      };
      const runCliEvents = async (argv: string[]): Promise<DetailedRecord[]> => {
        let out = '';
        const code = await runSurfaceMethod('sandbox.events', parseArgs(argv), {
          cwd: cliDir,
          stdout: { write: (chunk) => { out += chunk; } },
          stderr: { write: () => {} },
          discover: async () => host,
        });
        expect(code).toBe(0);
        return (JSON.parse(out) as { data: EventsPayload }).data.events;
      };
      try {
        const cliDefaultEvents = await runCliEvents(['sandbox', 'events', '--kind', 'denials', '--json']);
        expect(cliDefaultEvents).toHaveLength(1);
        expect(cliDefaultEvents[0]!.denial?.reasons.length).toBeGreaterThan(0);
        expect(cliDefaultEvents[0]!.denial?.rule?.expression).toBe(
          'request.auth != null && request.auth.uid == request.resource.data.owner',
        );
        assertNoPayloads(cliDefaultEvents);

        const cliDetailEvents = await runCliEvents(['sandbox', 'events', '--kind', 'denials', '--detail', '--json']);
        expect(cliDetailEvents[0]!.request).toMatchObject({
          resourceData: { owner: 'user-1', secret: 'cli-candidate' },
        });
        expect(cliDetailEvents[0]!.resourceBefore).toMatchObject({
          exists: true,
          data: { owner: 'user-1', secret: 'cli-private' },
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // 2. Real MCP client over InMemoryTransport (`runInProcessMcp`)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const serverDone = runInProcessMcp(cliDir, {
        env: { ...process.env, HOME: homeDir },
        transport: serverTransport,
      });
      const client = new Client({ name: 'events-denial-parity', version: '0' });
      await client.connect(clientTransport);
      const callMcp = async (name: string, method: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: { method, args } });
        return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { data: EventsPayload };
      };
      try {
        await callMcp('sandbox', 'seed', {
          firestore: { 'items/item-1': { owner: 'user-1', secret: 'mcp-private' } },
        });
        await callMcp('auth', 'impersonate', { uid: 'user-2' });
        await callMcp('firestore', 'setDoc', {
          path: 'items/item-1',
          data: { owner: 'user-1', secret: 'mcp-candidate' },
        });

        const mcpDefault = await callMcp('sandbox', 'events', { kind: 'denials' });
        expect(mcpDefault.data.events).toHaveLength(1);
        expect(mcpDefault.data.events[0]!.denial?.rule?.expression).toBe(
          'request.auth != null && request.auth.uid == request.resource.data.owner',
        );
        assertNoPayloads(mcpDefault.data.events);

        const mcpDetail = await callMcp('sandbox', 'events', { kind: 'denials', detail: true });
        expect(mcpDetail.data.events[0]!.request).toMatchObject({
          resourceData: { owner: 'user-1', secret: 'mcp-candidate' },
        });
        expect(mcpDetail.data.events[0]!.resourceBefore).toMatchObject({
          exists: true,
          data: { owner: 'user-1', secret: 'mcp-private' },
        });
      } finally {
        await client.close();
        await serverDone;
      }
    } finally {
      process.env.HOME = priorHome;
      rmSync(cliDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('surfaces evidenceExpired on sandbox.events and points to pyric serve denials in its description', async () => {
    setRules(sandbox, FIRESTORE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'user-1' } });
    const deniedDb = getFirestore(sandbox.withAuth({ uid: 'user-2' }));
    const allowedDb = getFirestore(sandbox.withAuth({ uid: 'user-1' }));

    await getDoc(doc(deniedDb, 'items/item-1')).catch(() => undefined);
    for (let i = 0; i < 65; i++) {
      await getDoc(doc(allowedDb, 'items/item-1'));
    }

    const res = await runSdk('sandbox.events', { kind: 'denials' });
    expect(res.ok).toBe(true);
    const first = (res.data as EventsPayload).events[0]!;
    expect(first.denial?.evidenceExpired).toBe(true);
    expect(first.denial?.reasons.length).toBeGreaterThan(0);

    const eventsMethod = methodByKey('sandbox.events');
    expect(eventsMethod.description).toContain('pyric serve denials');
    expect(eventsMethod.signature).toContain('detail?');
  });
});
