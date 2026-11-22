/**
 * Differential test across all 4 execution planes for Firestore named databases:
 *   1. In-process `Sandbox` (`pyric/firestore` + `pyric/sandbox/admin-firestore`)
 *   2. SharedWorker (`handleMessage` + `connectClientPort` + `withDatabaseId`)
 *   3. HostedRuntime SQLite (`createHostedRuntime` + WebSocket `getHostedFirestore` + restart)
 *   4. MCP / CLI Bridge Surface (`createSurfaceContext` + `renderSurface` + `verifyFixture`)
 *
 * Two databases (`(default)` and `reports`) hold distinct data at the same path
 * (`items/shared`) and enforce distinct rules (`alice` on `(default)`, `bob` on `reports`).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAuth } from 'pyric/auth';
import {
  doc as inProcDoc,
  getAdminFirestore as getInProcAdminFirestore,
  getDoc as inProcGetDoc,
  getFirestore as getInProcFirestore,
  setDoc as inProcSetDoc,
} from 'pyric/firestore';
import { declareFirestoreDatabase, getDatabaseEnv } from 'pyric/firestore/internal';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';

import {
  createSurfaceContext,
  renderSurface,
} from '../../src/bridge/surface/index.js';
import { buildLiveSessionCaptureFixture } from '../../src/serve/session-capture-fixture.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import { recordPeerWorkerProtocol } from '../../src/serve/worker/client/protocol-version.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import {
  doc as workerDoc,
  getDoc as workerGetDoc,
  setDoc as workerSetDoc,
  setFirestoreRules as workerSetFirestoreRules,
  setLens,
  withDatabaseId,
  type ClientDb,
} from '../../src/serve/worker/index.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import { verifyFixture } from '../../src/verify/index.js';
import { openDifferentialHostedServer } from './named-databases-differential-support.js';

const DEFAULT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

const REPORTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth.uid == 'bob';
    }
  }
}`;

interface PlaneOutcome {
  defaultDoc: Record<string, unknown> | undefined;
  reportsDoc: Record<string, unknown> | undefined;
  aliceCanReadDefault: boolean;
  aliceCanReadReports: boolean;
  bobCanReadDefault: boolean;
  bobCanReadReports: boolean;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-named-db-diff-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setLens(undefined);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function connectSharedWorkerClient(ctx: HostCtx): ClientDb {
  const listeners = new Set<(event: { data: OutboundMessage }) => void>();
  const clientPort = {
    onmessage: null as ((event: { data: OutboundMessage }) => void) | null,
    start() {},
    close() {},
    postMessage(msg: InboundMessage) {
      queueMicrotask(() => {
        void handleMessage(ctx, hostPort, msg);
      });
    },
    addEventListener(_t: 'message', fn: (event: { data: OutboundMessage }) => void) {
      listeners.add(fn);
    },
    removeEventListener(_t: 'message', fn: (event: { data: OutboundMessage }) => void) {
      listeners.delete(fn);
    },
  } as unknown as MessagePort;
  const hostPort: PortLike = {
    postMessage(msg: OutboundMessage) {
      queueMicrotask(() => {
        (clientPort as unknown as { onmessage?: ((e: { data: OutboundMessage }) => void) | null }).onmessage?.({
          data: msg,
        });
        for (const fn of listeners) fn({ data: msg });
      });
    },
  };
  wirePort(clientPort);
  clientPort.start();
  recordPeerWorkerProtocol(clientPort, 2);
  return { __kind: 'client-db', type: 'firestore', port: clientPort };
}

async function runInProcessPlane(): Promise<PlaneOutcome> {
  const sandbox = initializeSandbox();
  declareFirestoreDatabase(sandbox, 'reports');
  getDatabaseEnv(sandbox).deployRules(DEFAULT_RULES);
  getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_RULES);

  await inProcSetDoc(
    inProcDoc(getInProcAdminFirestore(sandbox.withAuth(null)), 'items/shared'),
    { db: 'default', v: 1 },
  );
  await inProcSetDoc(
    inProcDoc(getInProcAdminFirestore(sandbox.withAuth(null), 'reports'), 'items/shared'),
    { db: 'reports', v: 2 },
  );

  const aliceDefault = getInProcFirestore(sandbox.withAuth({ uid: 'alice' }));
  const aliceReports = getInProcFirestore(sandbox.withAuth({ uid: 'alice' }), 'reports');
  const bobDefault = getInProcFirestore(sandbox.withAuth({ uid: 'bob' }));
  const bobReports = getInProcFirestore(sandbox.withAuth({ uid: 'bob' }), 'reports');

  const dSnap = await inProcGetDoc(inProcDoc(aliceDefault, 'items/shared'));
  const rSnap = await inProcGetDoc(inProcDoc(bobReports, 'items/shared'));
  const aliceReportsAllowed = await inProcGetDoc(inProcDoc(aliceReports, 'items/shared')).then(
    () => true,
    () => false,
  );
  const bobDefaultAllowed = await inProcGetDoc(inProcDoc(bobDefault, 'items/shared')).then(
    () => true,
    () => false,
  );

  await inProcSetDoc(inProcDoc(aliceDefault, 'items/alice-note'), { ok: true });
  await inProcSetDoc(inProcDoc(bobReports, 'items/bob-report'), { ok: true });
  const capture = buildLiveSessionCaptureFixture({
    sandbox,
    authState: { users: [], currentUser: null },
  });
  const verified = await verifyFixture(capture, {
    rules: {
      firestore: DEFAULT_RULES,
      firestoreDatabases: { reports: REPORTS_RULES },
    },
  });
  expect(verified.ok).toBe(true);

  return {
    defaultDoc: dSnap.data(),
    reportsDoc: rSnap.data(),
    aliceCanReadDefault: dSnap.exists(),
    aliceCanReadReports: aliceReportsAllowed,
    bobCanReadDefault: bobDefaultAllowed,
    bobCanReadReports: rSnap.exists(),
  };
}

async function runSharedWorkerPlane(): Promise<PlaneOutcome> {
  const sandbox = initializeSandbox();
  declareFirestoreDatabase(sandbox, 'reports');
  getDatabaseEnv(sandbox).deployRules(DEFAULT_RULES);
  getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_RULES);
  await sandbox.enablePersistence({
    key: `sw-diff-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  getAuth(sandbox);
  const ctx: HostCtx = {
    db: getInProcFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
    instanceId: 'sw-diff',
  };

  const defaultDb = connectSharedWorkerClient(ctx);
  const reportsDb = withDatabaseId(defaultDb, 'reports');

  setLens({ mode: 'admin' });
  await workerSetDoc(workerDoc(defaultDb, 'items/shared'), { db: 'default', v: 1 });
  await workerSetDoc(workerDoc(reportsDb, 'items/shared'), { db: 'reports', v: 2 });

  setLens({ mode: 'as', uid: 'alice' });
  const dSnap = await workerGetDoc(workerDoc(defaultDb, 'items/shared'));
  const aliceReportsAllowed = await workerGetDoc(workerDoc(reportsDb, 'items/shared')).then(
    () => true,
    () => false,
  );

  setLens({ mode: 'as', uid: 'bob' });
  const rSnap = await workerGetDoc(workerDoc(reportsDb, 'items/shared'));
  const bobDefaultAllowed = await workerGetDoc(workerDoc(defaultDb, 'items/shared')).then(
    () => true,
    () => false,
  );

  return {
    defaultDoc: dSnap.data(),
    reportsDoc: rSnap.data(),
    aliceCanReadDefault: dSnap.exists(),
    aliceCanReadReports: aliceReportsAllowed,
    bobCanReadDefault: bobDefaultAllowed,
    bobCanReadReports: rSnap.exists(),
  };
}

async function runHostedSqlitePlane(): Promise<PlaneOutcome> {
  const dir = makeTempDir();

  const first = await openDifferentialHostedServer(dir, DEFAULT_RULES);
  try {
    const seeded = await first.runtime.runMethod(
      {
        key: 'sandbox.seed',
        args: { firestoreDeclared: ['reports'] },
        projectDir: dir,
      },
      {},
    );
    expect(seeded.ok).toBe(true);
    const client1 = await first.openClient();
    const reports1 = withDatabaseId(client1, 'reports');
    await workerSetFirestoreRules(client1, DEFAULT_RULES);
    await workerSetFirestoreRules(client1, REPORTS_RULES, 'reports');
    setLens({ mode: 'admin' });
    await workerSetDoc(workerDoc(client1, 'items/shared'), { db: 'default', v: 1 });
    await workerSetDoc(workerDoc(reports1, 'items/shared'), { db: 'reports', v: 2 });
    client1.port.close();
  } finally {
    await first.close();
  }

  const second = await openDifferentialHostedServer(dir, DEFAULT_RULES);
  try {
    const defaultDb = await second.openClient();
    const reportsDb = withDatabaseId(defaultDb, 'reports');
    await workerSetFirestoreRules(defaultDb, DEFAULT_RULES);
    await workerSetFirestoreRules(defaultDb, REPORTS_RULES, 'reports');

    setLens({ mode: 'as', uid: 'alice' });
    const dSnap = await workerGetDoc(workerDoc(defaultDb, 'items/shared'));
    const aliceReportsAllowed = await workerGetDoc(workerDoc(reportsDb, 'items/shared')).then(
      () => true,
      () => false,
    );

    setLens({ mode: 'as', uid: 'bob' });
    const rSnap = await workerGetDoc(workerDoc(reportsDb, 'items/shared'));
    const bobDefaultAllowed = await workerGetDoc(workerDoc(defaultDb, 'items/shared')).then(
      () => true,
      () => false,
    );
    defaultDb.port.close();

    return {
      defaultDoc: dSnap.data(),
      reportsDoc: rSnap.data(),
      aliceCanReadDefault: dSnap.exists(),
      aliceCanReadReports: aliceReportsAllowed,
      bobCanReadDefault: bobDefaultAllowed,
      bobCanReadReports: rSnap.exists(),
    };
  } finally {
    await second.close();
  }
}

async function runBridgeSurfacePlane(): Promise<PlaneOutcome> {
  const sandbox = initializeSandbox();
  const dir = makeTempDir();
  const ctx = createSurfaceContext(sandbox, dir);
  const surface = renderSurface(undefined);
  const call = (key: string, args: Record<string, unknown>) => {
    const [toolName, methodName] = key.split('.');
    const tool = surface.tools.find((candidate) => candidate.name === toolName)!;
    return tool.execute({ method: methodName!, args }, ctx);
  };

  await call('rules.set', { service: 'firestore', rules: DEFAULT_RULES });
  await call('rules.set', {
    service: 'firestore',
    database: 'reports',
    rules: REPORTS_RULES,
  });
  await call('firestore.setDoc', { path: 'items/shared', data: { db: 'default', v: 1 } });
  await call('firestore.setDoc', {
    path: 'items/shared',
    data: { db: 'reports', v: 2 },
    database: 'reports',
  });

  await call('auth.impersonate', { uid: 'alice' });
  const aliceDefault = await call('firestore.getDoc', { path: 'items/shared' });
  const aliceReports = await call('firestore.getDoc', {
    path: 'items/shared',
    database: 'reports',
  });

  await call('auth.impersonate', { uid: 'bob' });
  const bobDefault = await call('firestore.getDoc', { path: 'items/shared' });
  const bobReports = await call('firestore.getDoc', {
    path: 'items/shared',
    database: 'reports',
  });

  return {
    defaultDoc: (aliceDefault.data as { data?: Record<string, unknown> } | undefined)?.data,
    reportsDoc: (bobReports.data as { data?: Record<string, unknown> } | undefined)?.data,
    aliceCanReadDefault: aliceDefault.ok,
    aliceCanReadReports: aliceReports.ok,
    bobCanReadDefault: bobDefault.ok,
    bobCanReadReports: bobReports.ok,
  };
}

describe('two-database differential parity across all 4 planes', () => {
  it('reaches identical data isolation and per-database rules verdicts on in-process, SharedWorker, HostedRuntime SQLite, and MCP bridge planes', async () => {
    const expected: PlaneOutcome = {
      defaultDoc: { db: 'default', v: 1 },
      reportsDoc: { db: 'reports', v: 2 },
      aliceCanReadDefault: true,
      aliceCanReadReports: false,
      bobCanReadDefault: false,
      bobCanReadReports: true,
    };

    const inProc = await runInProcessPlane();
    const sharedWorker = await runSharedWorkerPlane();
    const hostedSqlite = await runHostedSqlitePlane();
    const bridgeSurface = await runBridgeSurfacePlane();

    expect(inProc).toEqual(expected);
    expect(sharedWorker).toEqual(expected);
    expect(hostedSqlite).toEqual(expected);
    expect(bridgeSurface).toEqual(expected);
  });
});
