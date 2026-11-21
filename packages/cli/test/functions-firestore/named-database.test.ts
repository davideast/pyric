import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pyricAdminFirestore from 'pyric-admin/firestore';
import {
  doc as pyricDoc,
  getFirestore as getClientFirestore,
  setDoc,
} from 'pyric/firestore';
import type { WriteSandboxEvent } from 'pyric/sandbox';
import { emitSandboxEvent } from 'pyric/sandbox/internal';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
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

const tempDirs = trackTempDirs('pyric-functions-firestore-named-db-');
let fixtureDir = '';
let runtime: ServeRuntime | undefined;
let hostCtx: HostCtx | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;
let child: FunctionsChildHandle | undefined;
let testAdminApp: ReturnType<typeof adminApp.initializeApp> | undefined;
let appSeq = 0;

const NAMED_DB_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{eventId} {
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
  throw new Error('Timed out waiting for Firestore named-database child condition.');
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built: ${childModule}`);
  }
  fixtureDir = tempDirs.makeTempDir();
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });

  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(fixtureDir, 'firestore.rules'), NAMED_DB_RULES);
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({
      hosting: { public: 'public' },
      firestore: { rules: 'firestore.rules' },
    }),
  );

  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'cjs-firestore-named-db', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      'const {',
      '  onDocumentCreatedWithAuthContext,',
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
      'let defaultSeq = 0;',
      'exports.onDefaultEventWritten = onDocumentWrittenWithAuthContext(',
      "  'events/{eventId}',",
      '  async (event) => {',
      '    defaultSeq += 1;',
      '    await db().doc(`audit/default-${defaultSeq}`).set({',
      '      eventId: event.params.eventId,',
      '      database: event.database,',
      '      source: event.source,',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '      beforeExists: event.data.before.exists,',
      '      afterExists: event.data.after.exists,',
      '    });',
      '  },',
      ');',
      '',
      'let analyticsSeq = 0;',
      'exports.onAnalyticsEventCreated = onDocumentCreatedWithAuthContext(',
      "  { document: 'events/{eventId}', database: 'analytics', namespace: 'ns-analytics', region: 'europe-west1' },",
      '  async (event) => {',
      '    await db().doc(`audit/analytics-created-${event.params.eventId}`).set({',
      '      database: event.database,',
      '      namespace: event.namespace,',
      '      location: event.location,',
      '      source: event.source,',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '      metric: event.data.data().metric,',
      '    });',
      '  },',
      ');',
      '',
      'exports.onAnalyticsEventWritten = onDocumentWrittenWithAuthContext(',
      "  { document: 'events/{eventId}', database: 'analytics' },",
      '  async (event) => {',
      '    analyticsSeq += 1;',
      '    await db().doc(`audit/analytics-written-${analyticsSeq}`).set({',
      '      eventId: event.params.eventId,',
      '      database: event.database,',
      '      authType: event.authType,',
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
    persistenceKeyPrefix: 'functions-firestore-named-db',
    instanceId: 'functions-firestore-named-db-test',
    firestoreRules: NAMED_DB_RULES,
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx: hostCtx,
    sandboxId: 'functions-firestore-named-db-peer',
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
    `functions-firestore-named-db-unit-${appSeq}`,
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

describe('Firestore v2 named database scoping', () => {
  test('enforces bidirectional named database isolation across (default), analytics, and billing in unit execution', async () => {
    const hits: string[] = [];

    const onDefault = firestoreFunctions.onDocumentWritten('events/{eventId}', (ev) => {
      hits.push(`default:${ev.database}:${ev.params.eventId}`);
    });
    const onAnalytics = firestoreFunctions.onDocumentWritten(
      { document: 'events/{eventId}', database: 'analytics' },
      (ev) => {
        hits.push(`analytics:${ev.database}:${ev.params.eventId}:${ev.source}`);
      },
    );
    const onBilling = firestoreFunctions.onDocumentCreatedWithAuthContext(
      { document: 'events/{eventId}', database: 'billing' },
      (ev) => {
        hits.push(`billing:${ev.database}:${ev.params.eventId}:${ev.authType}:${ev.authId ?? ''}`);
      },
    );

    const delivery = new InMemoryFirestoreTriggerDelivery();
    const host = startFirestoreTriggerExecution({
      exported: { onDefault, onAnalytics, onBilling },
      delivery,
      envelopeOptions: (matched, sequence) => ({
        id: `db-seq-${sequence}`,
        time: matched.mutation.time,
        projectId: 'demo-project',
        location: 'us-central1',
      }),
    });
    await host.ready;

    delivery.emitCreate({ document: 'events/ev-default', fields: { n: 1 } });
    delivery.emitCreate({
      database: 'analytics',
      document: 'events/ev-analytics',
      fields: { n: 2 },
    });
    delivery.emitCreate({
      database: 'billing',
      document: 'events/ev-billing',
      fields: { n: 3 },
      authType: 'unknown',
      authId: 'uid-finance',
    });
    delivery.emitCreate({
      database: 'unsubscribed-db',
      document: 'events/ev-ignored',
      fields: { n: 4 },
    });

    await host.idle();
    host.close();

    expect(hits).toEqual([
      'default:(default):ev-default',
      'analytics:analytics:ev-analytics://firestore.googleapis.com/projects/demo-project/databases/analytics',
      'billing:billing:ev-billing:unknown:uid-finance',
    ]);
  });

  test('routes live child-process writes bidirectionally between (default) and database: analytics without cross-triggering', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live HostedRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const aliceDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'uid-alice' }));

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
    });
    child = localChild;

    try {
      expect(await localChild.ready).toEqual({
        triggerCount: 3,
        unsupportedTriggers: [],
      });

      await setDoc(pyricDoc(aliceDb, 'events/ev-def-1'), { metric: 'signup' });
      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/default-1').get()).exists,
      );
      expect((await adminObserverDb.doc('audit/default-1').get()).data()).toEqual({
        eventId: 'ev-def-1',
        database: '(default)',
        source: '//firestore.googleapis.com/projects/demo-project/databases/(default)',
        authType: 'unknown',
        authId: 'uid-alice',
        beforeExists: false,
        afterExists: true,
      });
      expect(
        (await adminObserverDb.doc('audit/analytics-created-ev-def-1').get()).exists,
      ).toBe(false);
      expect((await adminObserverDb.doc('audit/analytics-written-1').get()).exists).toBe(false);

      const analyticsCreate: WriteSandboxEvent = {
        kind: 'write',
        id: 'wr-analytics-1',
        at: Date.now(),
        method: 'create',
        path: 'events/ev-ana-9',
        auth: { uid: 'uid-bob' },
        priorState: null,
        nextState: { metric: 'conversion' },
        requestTime: { seconds: 1_730_000_100, nanoseconds: 0 },
        detail: { databaseId: 'analytics' },
      };
      emitSandboxEvent(hostCtx.sandbox, analyticsCreate);

      const analyticsDelete: WriteSandboxEvent = {
        kind: 'write',
        id: 'wr-analytics-2',
        at: Date.now() + 10,
        method: 'delete',
        path: 'events/ev-ana-9',
        auth: null,
        priorState: { metric: 'conversion' },
        nextState: null,
        requestTime: { seconds: 1_730_000_200, nanoseconds: 0 },
        detail: { databaseId: 'analytics', admin: true },
      };
      emitSandboxEvent(hostCtx.sandbox, analyticsDelete);

      await waitForCondition(
        async () =>
          (await adminObserverDb.doc('audit/analytics-created-ev-ana-9').get()).exists &&
          (await adminObserverDb.doc('audit/analytics-written-2').get()).exists,
      );

      expect(
        (await adminObserverDb.doc('audit/analytics-created-ev-ana-9').get()).data(),
      ).toEqual({
        database: 'analytics',
        namespace: 'ns-analytics',
        location: 'europe-west1',
        source: '//firestore.googleapis.com/projects/demo-project/databases/analytics',
        authType: 'unknown',
        authId: 'uid-bob',
        metric: 'conversion',
      });
      expect((await adminObserverDb.doc('audit/analytics-written-1').get()).data()).toEqual({
        eventId: 'ev-ana-9',
        database: 'analytics',
        authType: 'unknown',
        authId: 'uid-bob',
        beforeExists: false,
        afterExists: true,
      });
      expect((await adminObserverDb.doc('audit/analytics-written-2').get()).data()).toEqual({
        eventId: 'ev-ana-9',
        database: 'analytics',
        authType: 'service_account',
        authId: null,
        beforeExists: true,
        afterExists: false,
      });
      expect((await adminObserverDb.doc('audit/default-2').get()).exists).toBe(false);
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 20_000);
});
