/**
 * Regression tests for per-database Firestore `snapshot_` bridge attachment
 * (`firebase-functions@7.4.0` named-database compatibility).
 *
 * Under `firebase-functions@7.4.0`, Firestore triggers call
 * `getFirestore(getApp(), databaseId).snapshot_(...)` per database instance
 * rather than reusing a single `(default)` instance. These tests verify both:
 *  1. Unit-level per-database `snapshot_` decoding and named-DB write-back.
 *  2. Live child-process execution where named databases fire first and
 *     concurrently with per-database `getFirestore(getApp(), db).snapshot_(...)`.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pyricAdminFirestore from 'pyric-admin/firestore';
import { initializeSandbox, type WriteSandboxEvent } from 'pyric/sandbox';
import { emitSandboxEvent } from 'pyric/sandbox/internal';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { encodeFirestoreDocumentEventData } from '../../src/functions/firestore/proto-encoder.js';
import { installChildFirestoreSnapshotBridge } from '../../src/functions/firestore/snapshot-bridge.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import type { HostCtx } from '../../src/serve/worker/host.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const protos = requireFromConformance(
  './node_modules/firebase-functions/protos/compiledFirestore.js',
) as {
  google: {
    events: {
      cloud: {
        firestore: {
          v1: {
            DocumentEventData: {
              decode(buf: Uint8Array): { value?: unknown; oldValue?: unknown };
            };
          };
        };
      };
    };
  };
};

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

const tempDirs = trackTempDirs('pyric-firestore-named-db-bridge-');
let fixtureDir = '';
let runtime: ServeRuntime | undefined;
let hostCtx: HostCtx | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;
let child: FunctionsChildHandle | undefined;

const SCOPED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{orderId} {
      allow read, write: if request.auth != null;
    }
    match /invoices/{invoiceId} {
      allow read, write: if request.auth != null;
    }
    match /audit/{docId} {
      allow read, write: if false;
    }
  }
}`;

interface SnapshotResult {
  exists: boolean;
  id: string;
  ref: {
    path: string;
    firestore?: { databaseId?: string };
    update(data: Record<string, unknown>): Promise<unknown>;
  };
  data(): Record<string, unknown> | undefined;
  isEqual(other: unknown): boolean;
}

interface FirestoreWithSnapshot {
  databaseId?: string;
  doc(path: string): {
    get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
    set(data: Record<string, unknown>): Promise<unknown>;
  };
  snapshot_?: (docOrName: unknown, readTime: unknown, encoding?: string) => SnapshotResult;
}

async function waitForCondition(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error('Timed out waiting for named-database Firestore snapshot bridge condition.');
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built: ${childModule}`);
  }
  fixtureDir = tempDirs.makeTempDir();
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });

  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(fixtureDir, 'firestore.rules'), SCOPED_RULES);
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({
      hosting: { public: 'public' },
      firestore: { rules: 'firestore.rules' },
    }),
  );

  // Fixture has ONLY named-database triggers (no default trigger) plus a
  // second named database to reproduce firebase-functions@7.4.0 calling
  // `getFirestore(getApp(), databaseId).snapshot_(...)` per database instance.
  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'named-db-740-compat', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      "const path = require('node:path');",
      "const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');",
      "const { getApps, initializeApp } = require('firebase-admin/app');",
      "const { getFirestore } = require('firebase-admin/firestore');",
      "const commonApp = require(path.join(path.dirname(require.resolve('firebase-functions/v2')), '../common/app.js'));",
      '',
      'function defaultDb() {',
      '  if (getApps().length === 0) initializeApp();',
      '  return getFirestore();',
      '}',
      '',
      'exports.onAnalyticsOrder = onDocumentCreated(',
      "  { document: 'orders/{orderId}', database: 'analytics' },",
      '  async (event) => {',
      "    const perDbHandle = getFirestore(commonApp.getApp(), 'analytics');",
      "    const hasSnapshotFn = typeof perDbHandle.snapshot_ === 'function';",
      '    await defaultDb().doc(`audit/analytics-${event.params.orderId}`).set({',
      '      database: event.database,',
      '      refDatabaseId: event.data.ref.firestore?.databaseId ?? null,',
      '      refPath: event.data.ref.path,',
      '      total: event.data.data().total,',
      '      hasSnapshotFn,',
      '    });',
      '  },',
      ');',
      '',
      'exports.onBillingInvoice = onDocumentWritten(',
      "  { document: 'invoices/{invoiceId}', database: 'billing' },",
      '  async (event) => {',
      "    const perDbHandle = getFirestore(commonApp.getApp(), 'billing');",
      "    const hasSnapshotFn = typeof perDbHandle.snapshot_ === 'function';",
      '    const directSnap = perDbHandle.snapshot_(',
      '      `projects/demo-project/databases/billing/documents/invoices/${event.params.invoiceId}`,',
      '      { seconds: 1730000300, nanos: 0 },',
      "      'protobufJS',",
      '    );',
      '    await defaultDb().doc(`audit/billing-${event.params.invoiceId}`).set({',
      '      database: event.database,',
      '      refDatabaseId: event.data.after.ref.firestore?.databaseId ?? null,',
      '      directSnapDbId: directSnap.ref.firestore?.databaseId ?? null,',
      '      directSnapExists: directSnap.exists,',
      '      amount: event.data.after.data().amount,',
      '      hasSnapshotFn,',
      '    });',
      '  },',
      ');',
    ].join('\n'),
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );

  runtime = await startServe({
    cwd: fixtureDir,
    port: 0,
    cacheRoot: join(fixtureDir, '.cache'),
    logger: silentServeLogger(),
    bridge: true,
    disableAuditLog: true,
  });
  hostCtx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-named-db-740-compat',
    instanceId: 'functions-named-db-740-compat',
    firestoreRules: SCOPED_RULES,
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx: hostCtx,
    sandboxId: 'functions-named-db-740-compat-peer',
    cwd: fixtureDir,
    sessionToken: runtime.sessionToken,
  });
  observer = await connectRemoteSandbox({
    url: runtime.handle.url,
    cwd: fixtureDir,
    sessionToken: runtime.sessionToken,
  });
}, 30_000);

afterAll(async () => {
  if (child !== undefined) {
    await child.stop();
    child = undefined;
  }
  observer?.close();
  observer = undefined;
  if (peer !== undefined) {
    await peer.close();
    peer = undefined;
  }
  if (runtime !== undefined) {
    await runtime.handle.stop();
    runtime = undefined;
  }
  hostCtx?.sandbox.dispose();
  hostCtx = undefined;
  tempDirs.cleanupTempDirs();
});

describe('named-database Firestore snapshot_ bridge (firebase-functions@7.4.0)', () => {
  test('installChildFirestoreSnapshotBridge attaches snapshot_ per database instance and scopes refs to each database', async () => {
    const sandbox = initializeSandbox();
    const unitDir = tempDirs.makeTempDir();
    mkdirSync(join(unitDir, 'node_modules/firebase-admin'), { recursive: true });
    mkdirSync(join(unitDir, 'node_modules/firebase-functions/lib/v2'), { recursive: true });

    let capturedEmulatedApp: unknown;
    // Provide mock CJS `firebase-admin/*` backed directly by `pyric-admin/firestore`
    // plus a mock `firebase-functions/v2` capturing `setEmulatedAdminApp`.
    const pyricAdminFirestorePath = resolve(repoRoot, 'packages/pyric-admin/dist/firestore/index.js');
    writeFileSync(
      join(unitDir, 'node_modules/firebase-admin/package.json'),
      JSON.stringify({
        name: 'firebase-admin',
        version: '14.5.1',
        exports: {
          './app': './app.cjs',
          './firestore': './firestore.cjs',
        },
      }),
    );
    writeFileSync(
      join(unitDir, 'node_modules/firebase-admin/app.cjs'),
      'module.exports = { getApps: () => [], initializeApp: () => ({}) };\n',
    );
    writeFileSync(
      join(unitDir, 'node_modules/firebase-admin/firestore.cjs'),
      `module.exports = require(${JSON.stringify(pyricAdminFirestorePath)});\n`,
    );
    writeFileSync(
      join(unitDir, 'node_modules/firebase-functions/package.json'),
      JSON.stringify({
        name: 'firebase-functions',
        version: '7.4.0',
        exports: { './v2': './lib/v2/index.js' },
      }),
    );
    writeFileSync(
      join(unitDir, 'node_modules/firebase-functions/lib/v2/index.js'),
      'exports.app = { setEmulatedAdminApp(app) { globalThis.__PYRIC_TEST_CAPTURED_APP__ = app; } };\n',
    );
    const entryPath = join(unitDir, 'index.js');
    writeFileSync(entryPath, 'module.exports = {};\n');

    try {
      await installChildFirestoreSnapshotBridge(entryPath, 'demo-project', sandbox, [
        'analytics',
        'billing',
      ]);
      capturedEmulatedApp = (globalThis as Record<string, unknown>).__PYRIC_TEST_CAPTURED_APP__;
      expect(capturedEmulatedApp).toBeDefined();

      const defaultHandle = pyricAdminFirestore.getFirestore(
        capturedEmulatedApp as never,
      ) as unknown as FirestoreWithSnapshot;
      const analyticsHandle = pyricAdminFirestore.getFirestore(
        capturedEmulatedApp as never,
        'analytics',
      ) as unknown as FirestoreWithSnapshot;
      const billingHandle = pyricAdminFirestore.getFirestore(
        capturedEmulatedApp as never,
        'billing',
      ) as unknown as FirestoreWithSnapshot;

      expect(typeof defaultHandle.snapshot_).toBe('function');
      expect(typeof analyticsHandle.snapshot_).toBe('function');
      expect(typeof billingHandle.snapshot_).toBe('function');
      expect(analyticsHandle).not.toBe(defaultHandle);
      expect(billingHandle).not.toBe(analyticsHandle);

      // Seed the `analytics` named database so `ref.update(...)` verifies write-back
      // reaches `analytics` rather than `(default)`.
      (pyricAdminFirestore.getAdminFirestore(sandbox, 'analytics') as unknown as {
        seed(opts: { documents: Record<string, Record<string, unknown>> }): void;
      }).seed({
        documents: { 'orders/ord-1': { total: 42 } },
      });

      const encoded = encodeFirestoreDocumentEventData(
        {
          value: {
            name: 'projects/demo-project/databases/analytics/documents/orders/ord-1',
            fields: {
              total: 42,
              nested: { currency: 'USD' },
            },
            createTime: { seconds: 1_730_000_010, nanos: 0 },
            updateTime: { seconds: 1_730_000_020, nanos: 0 },
          },
        },
        { projectId: 'demo-project', database: 'analytics' },
      );
      const decoded = protos.google.events.cloud.firestore.v1.DocumentEventData.decode(encoded);
      const snap = analyticsHandle.snapshot_!(decoded.value, null, 'protobufJS');
      expect(snap.exists).toBe(true);
      expect(snap.id).toBe('ord-1');
      expect(snap.ref.path).toBe('orders/ord-1');
      expect(snap.ref.firestore?.databaseId).toBe('analytics');
      expect(snap.data()).toEqual({ total: 42, nested: { currency: 'USD' } });

      await snap.ref.update({ processed: true });
      const inAnalytics = await analyticsHandle.doc('orders/ord-1').get();
      expect(inAnalytics.data()).toEqual({ total: 42, processed: true });
      const inDefault = await defaultHandle.doc('orders/ord-1').get();
      expect(inDefault.exists).toBe(false);

      // Missing snapshot on a second named database (`billing`) also works cleanly.
      const missingBilling = billingHandle.snapshot_!(
        'projects/demo-project/databases/billing/documents/invoices/inv-9',
        { seconds: 1_730_000_050, nanos: 0 },
        'protobufJS',
      );
      expect(missingBilling.exists).toBe(false);
      expect(missingBilling.ref.firestore?.databaseId).toBe('billing');
      expect(snap.isEqual(missingBilling)).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).__PYRIC_TEST_CAPTURED_APP__;
      sandbox.dispose();
    }
  });

  test('executes named-database triggers in a live Functions child without TypeError when no (default) trigger fires first', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live ServeRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const childErrors: unknown[] = [];
    const localChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
        beaconToken: runtime.beaconToken,
        instanceId: runtime.instanceId,
        sessionToken: runtime.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => {
        if (event.type === 'execution' && event.status === 'rejected') {
          childErrors.push(event.error);
        }
        if (event.type === 'delivery-error') {
          childErrors.push(event.error);
        }
      },
    });
    child = localChild;

    try {
      expect(await localChild.ready).toEqual({
        triggerCount: 2,
        unsupportedTriggers: [],
      });

      const analyticsCreate: WriteSandboxEvent = {
        kind: 'write',
        id: 'wr-740-analytics-1',
        at: Date.now(),
        method: 'create',
        path: 'orders/ord-740',
        auth: null,
        priorState: null,
        nextState: { total: 99 },
        requestTime: { seconds: 1_730_000_100, nanoseconds: 0 },
        detail: { databaseId: 'analytics', admin: true },
      };
      emitSandboxEvent(hostCtx.sandbox, analyticsCreate);

      const billingCreate: WriteSandboxEvent = {
        kind: 'write',
        id: 'wr-740-billing-1',
        at: Date.now() + 10,
        method: 'create',
        path: 'invoices/inv-740',
        auth: null,
        priorState: null,
        nextState: { amount: 250 },
        requestTime: { seconds: 1_730_000_200, nanoseconds: 0 },
        detail: { databaseId: 'billing', admin: true },
      };
      emitSandboxEvent(hostCtx.sandbox, billingCreate);

      await waitForCondition(
        async () =>
          (await adminObserverDb.doc('audit/analytics-ord-740').get()).exists &&
          (await adminObserverDb.doc('audit/billing-inv-740').get()).exists,
      );

      expect(childErrors).toEqual([]);
      expect((await adminObserverDb.doc('audit/analytics-ord-740').get()).data()).toEqual({
        database: 'analytics',
        refDatabaseId: 'analytics',
        refPath: 'orders/ord-740',
        total: 99,
        hasSnapshotFn: true,
      });
      expect((await adminObserverDb.doc('audit/billing-inv-740').get()).data()).toEqual({
        database: 'billing',
        refDatabaseId: 'billing',
        directSnapDbId: 'billing',
        directSnapExists: false,
        amount: 250,
        hasSnapshotFn: true,
      });
      const exitCode = await localChild.stop();
      if (child === localChild) child = undefined;
      expect(exitCode).toBe(0);
    } finally {
      if (child === localChild) {
        await localChild.stop().catch(() => undefined);
        child = undefined;
      }
    }
  }, 20_000);
});
