import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
} from 'pyric/rules/internal';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  DOC_VALUE_ENCODING,
  deserializeDocData,
  serializeDocData,
  type SerializedDocData,
} from '../../src/serve/worker/protocol.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

const tempDirs = trackTempDirs('pyric-functions-firestore-child-');
let fixtureDir = '';
let runtime: ServeRuntime | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;
let child: FunctionsChildHandle | undefined;

async function writeFirestoreDoc(
  sandbox: RemoteSandbox,
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  const encoded = serializeDocData(data, DOC_VALUE_ENCODING);
  await sandbox.channel.op({
    method: 'setDoc',
    path,
    data: JSON.parse(encoded.json) as unknown,
    valueEncoding: DOC_VALUE_ENCODING,
    actAs: { mode: 'admin' },
  });
}

async function readFirestoreDoc(
  sandbox: RemoteSandbox,
  path: string,
): Promise<Record<string, unknown> | null> {
  const res = (await sandbox.channel.op({
    method: 'getDoc',
    path,
    docValueEncoding: DOC_VALUE_ENCODING,
    actAs: { mode: 'admin' },
  })) as { exists: boolean; data?: SerializedDocData };
  if (!res.exists || res.data === undefined) return null;
  return deserializeDocData(res.data) as Record<string, unknown>;
}

async function waitForDoc(
  sandbox: RemoteSandbox,
  path: string,
  predicate: (doc: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const doc = await readFirestoreDoc(sandbox, path);
    if (doc !== null && predicate(doc)) return doc;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error(`Timed out waiting for Firestore document at ${path}`);
}

async function waitForEvents(
  events: readonly FunctionsChildEvent[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
}

const RESTRICTIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/orders/{orderId} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /invoices/{invoiceId} {
      allow read, write: if false;
    }
    match /config/{docId} {
      allow read, write: if false;
    }
  }
}`;

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built: ${childModule}`);
  }
  fixtureDir = tempDirs.makeTempDir();
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
  mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });

  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(fixtureDir, 'firestore.rules'), RESTRICTIVE_RULES);
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({
      hosting: { public: 'public' },
      firestore: { rules: 'firestore.rules' },
    }),
  );

  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'cjs-firestore-functions', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      "const { onDocumentCreated } = require('firebase-functions/v2/firestore');",
      "const { getApps, initializeApp, getApp } = require('firebase-admin/app');",
      "const { getFirestore, Timestamp, GeoPoint } = require('firebase-admin/firestore');",
      'const topLevelAppCount = getApps().length;',
      '',
      'exports.onOrderCreated = onDocumentCreated(',
      "  { document: 'users/{userId}/orders/{orderId}', region: 'europe-west1' },",
      '  async (event) => {',
      '    const preInitAppCount = getApps().length;',
      '    if (getApps().length === 0) initializeApp();',
      '    const snap = event.data;',
      '    const data = snap.data();',
      '    await snap.ref.update({',
      '      processedByTrigger: true,',
      '      topLevelAppCount,',
      '      preInitAppCount,',
      '      defaultAppName: getApp().name,',
      '      capturedParams: event.params,',
      '      capturedDatabase: event.database,',
      '      capturedDocument: event.document,',
      '      capturedLocation: event.location,',
      '      hasValidTimes:',
      '        snap.createTime instanceof Timestamp &&',
      '        snap.updateTime instanceof Timestamp &&',
      '        snap.readTime instanceof Timestamp,',
      '      isGeoPoint: data.shippingPoint instanceof GeoPoint,',
      '      isTimestamp: data.placedAt instanceof Timestamp,',
      '      isBuffer: Buffer.isBuffer(data.receiptBytes),',
      "      customerRefPath: data.customerRef ? data.customerRef.path : null,",
      '      nestedFirstItem: Array.isArray(data.items) ? data.items[0] : null,',
      '    });',
      '    await getFirestore().doc(`invoices/${event.params.orderId}`).set({',
      '      userId: event.params.userId,',
      '      totalCents: data.totalCents,',
      '    });',
      '  },',
      ');',
      '',
      'exports.billing = {',
      '  onInvoiceCreated: onDocumentCreated(',
      "    'invoices/{invoiceId}',",
      '    async (event) => {',
      '      await event.data.ref.update({',
      '        invoiceStamped: `${event.params.invoiceId}:${event.data.data().totalCents}`,',
      '      });',
      '    },',
      '  ),',
      '};',
      '',
      'exports.onSingletonConfig = onDocumentCreated(',
      "  'config/singleton',",
      '  async (event) => {',
      '    await event.data.ref.update({ initialized: true });',
      '  },',
      ');',
      '',
      'exports.onAnalyticsEvent = onDocumentCreated(',
      "  { document: 'users/{userId}/orders/{orderId}', database: 'analytics' },",
      '  async () => {',
      "    await getFirestore().doc('config/wrong-db-fired').set({ bad: true });",
      '  },',
      ');',
      '',
      'exports.omittedTrigger = onDocumentCreated(',
      "  { document: 'users/{userId}', omit: true },",
      '  () => undefined,',
      ');',
    ].join('\n'),
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );

  writeFileSync(
    join(fixtureDir, 'functions-esm/package.json'),
    JSON.stringify({
      name: 'esm-firestore-functions',
      private: true,
      type: 'module',
      main: 'index.js',
    }),
  );
  writeFileSync(
    join(fixtureDir, 'functions-esm/index.js'),
    [
      "import { onDocumentCreated } from 'firebase-functions/v2/firestore';",
      'await Promise.resolve();',
      'export const stampProfile = onDocumentCreated(',
      "  'profiles/{profileId}',",
      '  async (event) => {',
      '    await event.data.ref.update({',
      '      upperHandle: String(event.data.data().handle).toUpperCase(),',
      '      profileParam: event.params.profileId,',
      '    });',
      '  },',
      ');',
    ].join('\n'),
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions-esm/node_modules/firebase-functions'),
  );

  runtime = await startServe({
    cwd: fixtureDir,
    port: 0,
    cacheRoot: join(fixtureDir, '.cache'),
    logger: silentServeLogger(),
    bridge: true,
    disableAuditLog: true,
  });
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-firestore-child',
    instanceId: 'functions-firestore-child-test',
    firestoreRules: RESTRICTIVE_RULES,
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx,
    sandboxId: 'functions-firestore-child-peer',
    cwd: fixtureDir,
    sessionToken: runtime.sessionToken,
  });
  observer = await connectRemoteSandbox({
    url: runtime.handle.url,
    cwd: fixtureDir,
    sessionToken: runtime.sessionToken,
  });
});

afterAll(async () => {
  if (child) {
    await child.stop();
    child = undefined;
  }
  observer?.close();
  observer = undefined;
  if (peer) {
    await peer.close();
    peer = undefined;
  }
  if (runtime) {
    await runtime.handle.stop();
    runtime = undefined;
  }
  tempDirs.cleanupTempDirs();
});

describe('isolated Functions Firestore child against live HostedRuntime', () => {
  test('executes CJS onDocumentCreated with rich types, Admin ref.update write-back, chained triggers, literal paths, and database scoping', async () => {
    if (!runtime || !observer) throw new Error('expected live HostedRuntime');

    // Seed a pre-existing document before spawning child to prove startup does not replay history
    await writeFirestoreDoc(observer, 'users/preexisting/orders/ord-0', {
      totalCents: 100,
    });

    const events: FunctionsChildEvent[] = [];
    child = spawnFunctionsChild({
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
      onEvent: (event) => events.push(event),
    });

    const ready = await child.ready;
    expect(ready).toEqual({
      triggerCount: 4,
      unsupportedTriggers: [
        {
          exportName: 'omittedTrigger',
          eventType: 'google.cloud.firestore.document.v1.created (omitted from emulation)',
        },
      ],
    });

    await writeFirestoreDoc(observer, 'users/alice/orders/ord-77', {
      totalCents: 2599,
      placedAt: new RulesTimestamp(1_720_000_000, 125_000_000),
      shippingPoint: new RulesLatLng(47.6062, -122.3321),
      receiptBytes: new RulesBytes(new Uint8Array([0xca, 0xfe])),
      customerRef: new RulesReference('users/alice'),
      items: ['espresso', 'croissant'],
    });

    await writeFirestoreDoc(observer, 'config/singleton', {
      version: 1,
    });

    const updatedOrder = await waitForDoc(
      observer,
      'users/alice/orders/ord-77',
      (doc) => doc.processedByTrigger === true,
    );
    expect(updatedOrder.capturedParams).toEqual({
      userId: 'alice',
      orderId: 'ord-77',
    });
    expect(updatedOrder.topLevelAppCount).toBe(0);
    expect(updatedOrder.preInitAppCount).toBe(0);
    expect(updatedOrder.defaultAppName).toBe('[DEFAULT]');
    expect(updatedOrder.capturedDatabase).toBe('(default)');
    expect(updatedOrder.capturedDocument).toBe('users/alice/orders/ord-77');
    expect(updatedOrder.capturedLocation).toBe('europe-west1');
    expect(updatedOrder.hasValidTimes).toBe(true);
    expect(updatedOrder.isGeoPoint).toBe(true);
    expect(updatedOrder.isTimestamp).toBe(true);
    expect(updatedOrder.isBuffer).toBe(true);
    expect(updatedOrder.customerRefPath).toBe('users/alice');
    expect(updatedOrder.nestedFirstItem).toBe('espresso');

    const invoice = await waitForDoc(
      observer,
      'invoices/ord-77',
      (doc) => typeof doc.invoiceStamped === 'string',
    );
    expect(invoice).toEqual({
      userId: 'alice',
      totalCents: 2599,
      invoiceStamped: 'ord-77:2599',
    });

    const singleton = await waitForDoc(
      observer,
      'config/singleton',
      (doc) => doc.initialized === true,
    );
    expect(singleton).toEqual({ version: 1, initialized: true });

    await waitForEvents(events, 3);
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'onOrderCreated',
      ref: 'users/alice/orders/ord-77',
      params: { userId: 'alice', orderId: 'ord-77' },
      status: 'fulfilled',
    });
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'billing-onInvoiceCreated',
      ref: 'invoices/ord-77',
      params: { invoiceId: 'ord-77' },
      status: 'fulfilled',
    });
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'onSingletonConfig',
      ref: 'config/singleton',
      params: {},
      status: 'fulfilled',
    });

    // Pre-existing doc and named-database trigger must NOT have fired
    const preexisting = await readFirestoreDoc(observer, 'users/preexisting/orders/ord-0');
    expect(preexisting).toEqual({ totalCents: 100 });
    expect(await readFirestoreDoc(observer, 'config/wrong-db-fired')).toBeNull();

    expect(await child.stop()).toBe(0);
    child = undefined;
  }, 20_000);

  test('executes unchanged ESM top-level-await onDocumentCreated source against live HostedRuntime', async () => {
    if (!runtime || !observer) throw new Error('expected live HostedRuntime');

    const events: FunctionsChildEvent[] = [];
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
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
      onEvent: (event) => events.push(event),
    });

    expect(await child.ready).toEqual({
      triggerCount: 1,
      unsupportedTriggers: [],
    });

    await writeFirestoreDoc(observer, 'profiles/dev-1', { handle: 'pyric_builder' });
    const stamped = await waitForDoc(
      observer,
      'profiles/dev-1',
      (doc) => doc.upperHandle === 'PYRIC_BUILDER',
    );
    expect(stamped).toEqual({
      handle: 'pyric_builder',
      upperHandle: 'PYRIC_BUILDER',
      profileParam: 'dev-1',
    });

    await waitForEvents(events, 1);
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'stampProfile',
      ref: 'profiles/dev-1',
      params: { profileId: 'dev-1' },
      status: 'fulfilled',
    });

    expect(await child.stop()).toBe(0);
    child = undefined;
  }, 20_000);
});
