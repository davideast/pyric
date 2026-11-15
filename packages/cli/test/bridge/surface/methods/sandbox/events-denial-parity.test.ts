/**
 * End-to-end denial parity across capture, `sandbox.events` (SDK-service,
 * verb-prefixed, and discriminator), and `sandbox.inspect`.
 *
 * Verifies:
 *  - Every rules-evaluating service (Firestore, RTDB, Storage) and denial shape
 *    (write, read, listener) carries the same deciding rule text and reasons as
 *    the capture.
 *  - `request`, `resourceBefore`, and `resourceAfter` are omitted by default
 *    and appear only when `detail: true`.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type OperationDenial,
  type OperationRecord,
  type RequestEvent,
  type SandboxEvent,
  type SandboxOperationEvent,
} from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getBytes, getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
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

interface InspectedDenial {
  path: string;
  method: string;
  rule?: { citation?: string; expression?: string; path?: string };
  reasons?: string[];
  evidenceExpired?: true;
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

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDetailedRecord(value: unknown): value is DetailedRecord {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.service === 'string' &&
    typeof value.method === 'string' &&
    isObjectRecord(value.rules)
  );
}

function eventsFromData(data: unknown): DetailedRecord[] {
  if (!isObjectRecord(data) || !Array.isArray(data.events)) {
    throw new Error('Expected events array in result data');
  }
  const out: DetailedRecord[] = [];
  for (const item of data.events) {
    if (!isDetailedRecord(item)) {
      throw new Error('Unexpected non-record item in events payload');
    }
    out.push(item);
  }
  return out;
}

function eventsFromResult(result: OperationResult): DetailedRecord[] {
  expect(result.ok).toBe(true);
  return eventsFromData(result.data);
}

function isInspectedDenial(value: unknown): value is InspectedDenial {
  if (!isObjectRecord(value)) return false;
  return typeof value.path === 'string' && typeof value.method === 'string';
}

function recentDenialsFromInspect(result: OperationResult): InspectedDenial[] {
  expect(result.ok).toBe(true);
  if (!isObjectRecord(result.data) || !isObjectRecord(result.data.events)) {
    throw new Error('Expected inspect events payload');
  }
  const raw = result.data.events.recentDenials;
  if (!Array.isArray(raw)) {
    throw new Error('Expected inspect recentDenials array');
  }
  const out: InspectedDenial[] = [];
  for (const entry of raw) {
    if (!isInspectedDenial(entry)) {
      throw new Error('Unexpected recentDenials entry shape');
    }
    out.push(entry);
  }
  return out;
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

function assertCaptureDenialParity(denial: OperationDenial, raw: SandboxEvent): void {
  if (raw.kind === 'request') {
    expect(denial.reasons).toEqual(raw.reasons);
    if (raw.evaluatedRule !== undefined) {
      expect(denial.rule?.expression).toBe(raw.evaluatedRule.expression);
      expect(denial.rule?.citation).toBe(raw.evaluatedRule.citation);
    }
    return;
  }
  if (raw.kind === 'operation') {
    expect(denial.reasons).toEqual(raw.reasons ?? []);
    if (raw.rules?.matchedPath) {
      expect(denial.rule?.path).toBe(raw.rules.matchedPath);
    }
    if (raw.rules?.matchedRule) {
      expect(denial.rule?.expression).toBe(raw.rules.matchedRule);
    }
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

    const denialRecords = eventsFromResult(
      await runSdk('sandbox.events', { kind: 'denials', limit: 50 }),
    );
    assertNoPayloads(denialRecords);

    const expectedShapes: Array<[string, DetailedRecord | undefined]> = [
      ['fs:get', denialRecords.find((r) => r.service === 'firestore' && r.method === 'get' && r.path === 'items/item-1')],
      ['fs:set', denialRecords.find((r) => r.service === 'firestore' && r.method === 'set')],
      ['fs:list', denialRecords.find((r) => r.service === 'firestore' && r.method === 'list')],
      ['rtdb:get', denialRecords.find((r) => r.service === 'rtdb' && r.method === 'get')],
      ['rtdb:set', denialRecords.find((r) => r.service === 'rtdb' && r.method === 'set')],
      ['rtdb:listen', denialRecords.find((r) => r.service === 'rtdb' && r.method === 'listen')],
      ['storage:get', denialRecords.find((r) => r.service === 'storage' && r.method === 'get')],
      ['storage:create', denialRecords.find((r) => r.service === 'storage' && r.method === 'create')],
    ];

    for (const [label, maybeRecord] of expectedShapes) {
      const record = requireDefined(maybeRecord, label);
      const raw = requireDefined(captureById.get(record.id), `capture event for ${label}`);
      const denial = requireDefined(record.denial, `denial for ${label}`);
      assertCaptureDenialParity(denial, raw);
    }

    // Listener lifecycle page (`kind: 'listeners'`) correlates Firestore and RTDB denied listeners.
    const listenerRecords = eventsFromResult(
      await runSdk('sandbox.events', { kind: 'listeners', limit: 50 }),
    );
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

    const rawFsDocListenerReq = requireDefined(
      capture.events.find(
        (e): e is RequestEvent & SandboxEvent =>
          e.kind === 'request' && e.origin === 'listener' && e.method === 'get' && e.result === 'deny',
      ),
      'raw firestore doc listener denial',
    );
    const rawFsQueryListenerReq = requireDefined(
      capture.events.find(
        (e): e is RequestEvent & SandboxEvent =>
          e.kind === 'request' && e.origin === 'listener' && e.method === 'list' && e.result === 'deny',
      ),
      'raw firestore query listener denial',
    );
    const rawRtdbListenerOp = requireDefined(
      capture.events.find(
        (e): e is SandboxOperationEvent & SandboxEvent =>
          e.kind === 'operation' && e.service === 'rtdb' && e.method === 'listen' && e.result === 'deny',
      ),
      'raw rtdb listener denial',
    );

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
    const detailedEvents = eventsFromResult(
      await runSdk('sandbox.events', { kind: 'denials', limit: 50, detail: true }),
    );
    const detailedVerbEvents = eventsFromResult(
      await runVerb('list_sandbox_events', { kind: 'denials', limit: 50, detail: true }),
    );
    const detailedDiscEvents = eventsFromResult(
      await runDiscriminator('control_sandbox_environment', {
        action: 'events',
        kind: 'denials',
        limit: 50,
        detail: true,
      }),
    );
    expect(detailedVerbEvents).toEqual(detailedEvents);
    expect(detailedDiscEvents).toEqual(detailedEvents);

    const fsSetDetailed = detailedEvents.find((r) => r.service === 'firestore' && r.method === 'set');
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
    const listenerDetailedEvents = eventsFromResult(
      await runSdk('sandbox.events', { kind: 'listeners', limit: 50, detail: true }),
    );
    const erroredFsDocDetailed = listenerDetailedEvents.find(
      (r) => r.service === 'firestore' && r.method === 'errored' && r.path === 'items/item-1',
    );
    expect(erroredFsDocDetailed?.resourceBefore).toMatchObject({
      exists: true,
      data: { owner: 'user-1', secret: 'keep-private' },
    });

    // `sandbox.inspect` agrees on reasons and deciding rules across all three services.
    const recentDenials = recentDenialsFromInspect(
      await runSdk('sandbox.inspect', { recentEventLimit: 20 }),
    );
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
});
