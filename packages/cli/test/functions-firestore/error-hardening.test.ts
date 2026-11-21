import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pyricAdminFirestore from 'pyric-admin/firestore';
import {
  deleteDoc,
  doc as pyricDoc,
  getFirestore as getClientFirestore,
  setDoc,
  updateDoc,
} from 'pyric/firestore';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import { discoverFirestoreTriggers } from '../../src/functions/firestore/discovery.js';
import { executeFirestoreTrigger } from '../../src/functions/firestore/event.js';
import { startFirestoreTriggerExecution } from '../../src/functions/firestore/execution.js';
import { InMemoryFirestoreTriggerDelivery } from '../../src/functions/firestore/in-memory-delivery.js';
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
process.env.GCLOUD_PROJECT ??= 'demo-project';
process.env.FIREBASE_CONFIG ??= JSON.stringify({
  projectId: 'demo-project',
  databaseURL: 'https://demo-project-default-rtdb.firebaseio.com',
});

const adminApp = requireFromConformance(
  'firebase-admin/app',
) as typeof import('firebase-admin/app');
const functionsV2 = requireFromConformance(
  'firebase-functions/v2',
) as typeof import('firebase-functions/v2');
const firestoreFunctions = requireFromConformance(
  'firebase-functions/v2/firestore',
) as typeof import('firebase-functions/v2/firestore');

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

const tempDirs = trackTempDirs('pyric-functions-firestore-error-hardening-');
let fixtureDir = '';
let runtime: ServeRuntime | undefined;
let hostCtx: HostCtx | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;
let child: FunctionsChildHandle | undefined;
let testAdminApp: ReturnType<typeof adminApp.initializeApp> | undefined;
let appSeq = 0;

const ERROR_HARDENING_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /jobs/{jobId} {
      allow read, write: if request.auth != null;
    }
    match /audit/{docId} {
      allow read, write: if false;
    }
  }
}`;

async function waitForCondition(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error('Timed out waiting for Firestore error-hardening condition.');
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built: ${childModule}`);
  }
  fixtureDir = tempDirs.makeTempDir();
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });

  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(fixtureDir, 'firestore.rules'), ERROR_HARDENING_RULES);
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({
      hosting: { public: 'public' },
      firestore: { rules: 'firestore.rules' },
    }),
  );

  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'cjs-firestore-errors', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      'const {',
      '  onDocumentCreated,',
      '  onDocumentUpdated,',
      '  onDocumentDeleted,',
      '  onDocumentWrittenWithAuthContext,',
      "} = require('firebase-functions/v2/firestore');",
      "const { getApps, initializeApp } = require('firebase-admin/app');",
      "const { getFirestore } = require('firebase-admin/firestore');",
      '',
      'function db() {',
      '  if (getApps().length === 0) initializeApp();',
      '  return getFirestore();',
      '}',
      '',
      "exports.syncThrowOnCreate = onDocumentCreated('jobs/{jobId}', (event) => {",
      "  if (event.params.jobId === 'job-bad') {",
      "    throw new Error('EXPECTED_SYNC_HANDLER_THROW');",
      '  }',
      '});',
      '',
      "exports.asyncRejectOnUpdate = onDocumentUpdated('jobs/{jobId}', async (event) => {",
      "  if (event.params.jobId === 'job-bad') {",
      '    await Promise.resolve();',
      "    throw new Error('EXPECTED_ASYNC_HANDLER_REJECT');",
      '  }',
      '});',
      '',
      "exports.outOfTurnThrowOnDelete = onDocumentDeleted('jobs/{jobId}', (event) => {",
      "  if (event.params.jobId === 'job-bad') {",
      '    setImmediate(() => {',
      "      throw new Error('EXPECTED_UNCAUGHT_TIMER_ERROR');",
      '    });',
      '    setImmediate(() => {',
      "      Promise.reject(new Error('EXPECTED_UNHANDLED_REJECTION'));",
      '    });',
      '  }',
      '});',
      '',
      'let healthySeq = 0;',
      'exports.healthySiblingWritten = onDocumentWrittenWithAuthContext(',
      "  'jobs/{jobId}',",
      '  async (event) => {',
      '    healthySeq += 1;',
      '    await db().doc(`audit/healthy-${healthySeq}`).set({',
      '      jobId: event.params.jobId,',
      '      authId: event.authId ?? null,',
      '      beforeExists: event.data.before.exists,',
      '      afterExists: event.data.after.exists,',
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
    persistenceKeyPrefix: 'functions-firestore-error-hardening',
    instanceId: 'functions-firestore-error-hardening-test',
    firestoreRules: ERROR_HARDENING_RULES,
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx: hostCtx,
    sandboxId: 'functions-firestore-error-hardening-peer',
    cwd: fixtureDir,
    sessionToken: runtime.sessionToken,
  });
  observer = await connectRemoteSandbox({
    url: runtime.handle.url,
    cwd: fixtureDir,
    sessionToken: runtime.sessionToken,
  });
});

beforeEach(() => {
  appSeq += 1;
  testAdminApp = adminApp.initializeApp(
    { projectId: 'demo-project' },
    `functions-firestore-errors-unit-${appSeq}`,
  );
  functionsV2.app.setEmulatedAdminApp(testAdminApp);
});

afterEach(async () => {
  if (testAdminApp !== undefined) {
    functionsV2.app.setEmulatedAdminApp(undefined as never);
    await adminApp.deleteApp(testAdminApp);
    testAdminApp = undefined;
  }
});

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

describe('Firestore v2 serial queue hardening and child error isolation', () => {
  test('isolates protobuf encode errors, envelopeOptions rejections, and onExecution throws without wedging serial queue', async () => {
    const [rawTrigger] = discoverFirestoreTriggers({
      bad: firestoreFunctions.onDocumentCreated('items/{id}', () => undefined),
    });
    if (rawTrigger === undefined) {
      throw new Error('expected discovered trigger');
    }

    const throwingFields: Record<string, unknown> = {};
    Object.defineProperty(throwingFields, 'broken', {
      enumerable: true,
      get() {
        throw new Error('EXPECTED_PROTO_ENCODE_FAILURE');
      },
    });

    const badEnvelopeOutcome = await executeFirestoreTrigger(rawTrigger, {
      id: 'bad-doc-1',
      time: '2026-07-13T20:00:00.000Z',
      projectId: 'demo-project',
      location: 'us-central1',
      database: '(default)',
      namespace: '(default)',
      document: 'items/bad',
      before: null,
      after: {
        fields: throwingFields,
        createTime: { seconds: 1_720_900_800, nanos: 0 },
        updateTime: { seconds: 1_720_900_800, nanos: 0 },
      },
    });
    expect(badEnvelopeOutcome.status).toBe('rejected');
    if (badEnvelopeOutcome.status === 'rejected') {
      expect((badEnvelopeOutcome.error as Error).message).toBe('EXPECTED_PROTO_ENCODE_FAILURE');
    }

    const executedIds: string[] = [];
    const deliveryErrors: string[] = [];
    const triggerA = firestoreFunctions.onDocumentCreated('items/{id}', (ev) => {
      executedIds.push(`A:${ev.params.id}`);
    });
    const triggerB = firestoreFunctions.onDocumentCreated('items/{id}', (ev) => {
      executedIds.push(`B:${ev.params.id}`);
    });

    const delivery = new InMemoryFirestoreTriggerDelivery();
    const host = startFirestoreTriggerExecution({
      exported: { triggerA, triggerB },
      delivery,
      envelopeOptions: (matched, sequence, trigger) => {
        if (matched.params.id === 'fail-envelope' && trigger.exportName === 'triggerA') {
          return Promise.reject(new Error('EXPECTED_ENVELOPE_FAILURE'));
        }
        return {
          id: `q-${sequence}`,
          time: matched.mutation.time,
          projectId: 'demo-project',
          location: 'us-central1',
        };
      },
      onExecution(_result, trigger, matched) {
        if (matched.params.id === 'fail-callback' && trigger.exportName === 'triggerA') {
          throw new Error('EXPECTED_ON_EXECUTION_THROW');
        }
      },
      onDeliveryError(err, trigger) {
        const msg = err instanceof Error ? err.message : String(err);
        deliveryErrors.push(`${trigger.exportName}:${msg}`);
      },
    });
    await host.ready;

    delivery.emitCreate({ document: 'items/fail-envelope', fields: { v: 1 } });
    delivery.emitCreate({ document: 'items/fail-callback', fields: { v: 2 } });
    delivery.emitCreate({ document: 'items/healthy-after', fields: { v: 3 } });

    await host.idle();
    host.close();

    expect(deliveryErrors).toEqual([
      'triggerA:EXPECTED_ENVELOPE_FAILURE',
      'triggerA:EXPECTED_ON_EXECUTION_THROW',
    ]);
    expect(executedIds).toEqual([
      'B:fail-envelope',
      'A:fail-callback',
      'B:fail-callback',
      'A:healthy-after',
      'B:healthy-after',
    ]);
  });

  test('reports sync throws, async rejections, and out-of-turn uncaught errors without crashing sibling triggers or leaking processes', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live HostedRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const aliceDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'uid-alice' }));
    const events: FunctionsChildEvent[] = [];

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
      onEvent: (ev) => events.push(ev),
    });
    child = localChild;

    try {
      expect(await localChild.ready).toEqual({
        triggerCount: 4,
        unsupportedTriggers: [],
      });

      await setDoc(pyricDoc(aliceDb, 'jobs/job-bad'), { attempt: 1 });
      await updateDoc(pyricDoc(aliceDb, 'jobs/job-bad'), { attempt: 2 });
      await deleteDoc(pyricDoc(aliceDb, 'jobs/job-bad'));
      await setDoc(pyricDoc(aliceDb, 'jobs/job-healthy'), { attempt: 1 });

      await waitForCondition(
        async () =>
          (await adminObserverDb.doc('audit/healthy-4').get()).exists &&
          events.filter((ev) => ev.type === 'uncaught-error').length >= 2,
      );

      expect(localChild.child.exitCode).toBeNull();

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'execution',
          exportName: 'syncThrowOnCreate',
          ref: 'jobs/job-bad',
          status: 'rejected',
          error: expect.objectContaining({ message: 'EXPECTED_SYNC_HANDLER_THROW' }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'execution',
          exportName: 'asyncRejectOnUpdate',
          ref: 'jobs/job-bad',
          status: 'rejected',
          error: expect.objectContaining({ message: 'EXPECTED_ASYNC_HANDLER_REJECT' }),
        }),
      );

      const uncaughtMessages = events
        .filter((ev) => ev.type === 'uncaught-error')
        .map((ev) => ev.error.message);
      expect(uncaughtMessages).toContain('EXPECTED_UNCAUGHT_TIMER_ERROR');
      expect(uncaughtMessages).toContain('EXPECTED_UNHANDLED_REJECTION');

      expect((await adminObserverDb.doc('audit/healthy-4').get()).data()).toEqual({
        jobId: 'job-healthy',
        authId: 'uid-alice',
        beforeExists: false,
        afterExists: true,
      });
    } finally {
      const exitCode = await localChild.stop();
      if (child === localChild) child = undefined;
      expect(exitCode).toBe(0);
      expect(localChild.child.exitCode).toBe(0);
    }
  }, 20_000);
});
