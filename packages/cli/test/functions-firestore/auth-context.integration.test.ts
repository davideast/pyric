import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pyricAdminFirestore from 'pyric-admin/firestore';
import {
  deleteDoc,
  doc as pyricDoc,
  getFirestore as getClientFirestore,
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
} from 'pyric/firestore';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import type { HostCtx } from '../../src/serve/worker/host.js';
import {
  DOC_VALUE_ENCODING,
  serializeDocData,
} from '../../src/serve/worker/protocol.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

const tempDirs = trackTempDirs('pyric-functions-firestore-auth-child-');
let fixtureDir = '';
let runtime: ServeRuntime | undefined;
let hostCtx: HostCtx | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;
let child: FunctionsChildHandle | undefined;

const AUTH_SCOPED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /workspaces/{wsId}/tasks/{taskId} {
      allow read, write: if request.auth != null;
    }
    match /publicInbox/{msgId} {
      allow read, write: if true;
    }
    match /esmPosts/{postId} {
      allow read, write: if true;
    }
    match /audit/{docId} {
      allow read, write: if false;
    }
  }
}`;

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error('Timed out waiting for Firestore *WithAuthContext child condition.');
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built: ${childModule}`);
  }
  fixtureDir = tempDirs.makeTempDir();
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
  mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });

  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(fixtureDir, 'firestore.rules'), AUTH_SCOPED_RULES);
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({
      hosting: { public: 'public' },
      firestore: { rules: 'firestore.rules' },
    }),
  );

  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'cjs-firestore-auth-context', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      'const {',
      '  onDocumentCreated,',
      '  onDocumentUpdated,',
      '  onDocumentDeleted,',
      '  onDocumentWritten,',
      '  onDocumentCreatedWithAuthContext,',
      '  onDocumentUpdatedWithAuthContext,',
      '  onDocumentDeletedWithAuthContext,',
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
      'exports.onTaskCreatedAuth = onDocumentCreatedWithAuthContext(',
      "  'workspaces/{wsId}/tasks/{taskId}',",
      '  async (event) => {',
      '    await db().doc(`audit/created-auth-${event.params.taskId}`).set({',
      '      wsId: event.params.wsId,',
      '      taskId: event.params.taskId,',
      '      type: event.type,',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '      v1AuthType: event.context.authType ?? null,',
      '      v1AuthId: event.context.authId ?? null,',
      '      title: event.data.data().title,',
      '    });',
      '  },',
      ');',
      '',
      'exports.onTaskUpdatedAuth = onDocumentUpdatedWithAuthContext(',
      "  'workspaces/{wsId}/tasks/{taskId}',",
      '  async (event) => {',
      '    await db().doc(`audit/updated-auth-${event.params.taskId}`).set({',
      '      type: event.type,',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '      beforeTitle: event.data.before.data().title,',
      '      afterTitle: event.data.after.data().title,',
      '    });',
      '  },',
      ');',
      '',
      'exports.onTaskDeletedAuth = onDocumentDeletedWithAuthContext(',
      "  'workspaces/{wsId}/tasks/{taskId}',",
      '  async (event) => {',
      '    await db().doc(`audit/deleted-auth-${event.params.taskId}`).set({',
      '      type: event.type,',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '      removedTitle: event.data.data().title,',
      '    });',
      '  },',
      ');',
      '',
      'let inboxWriteSeq = 0;',
      'exports.onInboxWrittenAuth = onDocumentWrittenWithAuthContext(',
      "  'publicInbox/{msgId}',",
      '  async (event) => {',
      '    inboxWriteSeq += 1;',
      '    await db().doc(`audit/inbox-written-auth-${inboxWriteSeq}`).set({',
      '      seq: inboxWriteSeq,',
      '      msgId: event.params.msgId,',
      '      type: event.type,',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '      beforeExists: event.data.before.exists,',
      '      afterExists: event.data.after.exists,',
      '    });',
      '  },',
      ');',
      '',
      '// Companion non-withAuthContext triggers on identical paths must NEVER expose authType/authId',
      'let plainSeq = 0;',
      'const recordPlain = async (kind, event) => {',
      '  plainSeq += 1;',
      '  await db().doc(`audit/plain-${plainSeq}`).set({',
      '    kind,',
      "    hasAuthType: 'authType' in event,",
      "    hasAuthId: 'authId' in event,",
      '    v1AuthTypeNull: event.context.authType === undefined,',
      '    v1AuthIdNull: event.context.authId === undefined,',
      '  });',
      '};',
      "exports.onTaskCreatedPlain = onDocumentCreated('workspaces/{wsId}/tasks/{taskId}', (ev) => recordPlain('created', ev));",
      "exports.onTaskUpdatedPlain = onDocumentUpdated('workspaces/{wsId}/tasks/{taskId}', (ev) => recordPlain('updated', ev));",
      "exports.onTaskDeletedPlain = onDocumentDeleted('workspaces/{wsId}/tasks/{taskId}', (ev) => recordPlain('deleted', ev));",
      "exports.onInboxWrittenPlain = onDocumentWritten('publicInbox/{msgId}', (ev) => recordPlain('written', ev));",
    ].join('\n'),
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );

  writeFileSync(
    join(fixtureDir, 'functions-esm/package.json'),
    JSON.stringify({
      name: 'esm-firestore-auth-context',
      private: true,
      type: 'module',
      main: 'index.js',
    }),
  );
  writeFileSync(
    join(fixtureDir, 'functions-esm/index.js'),
    [
      'import {',
      '  onDocumentCreatedWithAuthContext,',
      '  onDocumentUpdatedWithAuthContext,',
      '  onDocumentDeletedWithAuthContext,',
      '  onDocumentWrittenWithAuthContext,',
      "} from 'firebase-functions/v2/firestore';",
      "import { getApps, initializeApp } from 'firebase-admin/app';",
      "import { getFirestore } from 'firebase-admin/firestore';",
      'await Promise.resolve();',
      '',
      'function db() {',
      '  if (getApps().length === 0) initializeApp();',
      '  return getFirestore();',
      '}',
      '',
      'let esmSeq = 0;',
      'export const esmCreatedAuth = onDocumentCreatedWithAuthContext(',
      "  'esmPosts/{postId}',",
      '  async (event) => {',
      '    await db().doc(`audit/esm-created-${event.params.postId}`).set({',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '    });',
      '  },',
      ');',
      'export const esmUpdatedAuth = onDocumentUpdatedWithAuthContext(',
      "  'esmPosts/{postId}',",
      '  async (event) => {',
      '    await db().doc(`audit/esm-updated-${event.params.postId}`).set({',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '    });',
      '  },',
      ');',
      'export const esmDeletedAuth = onDocumentDeletedWithAuthContext(',
      "  'esmPosts/{postId}',",
      '  async (event) => {',
      '    await db().doc(`audit/esm-deleted-${event.params.postId}`).set({',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
      '    });',
      '  },',
      ');',
      'export const esmWrittenAuth = onDocumentWrittenWithAuthContext(',
      "  'esmPosts/{postId}',",
      '  async (event) => {',
      '    esmSeq += 1;',
      '    await db().doc(`audit/esm-written-${esmSeq}`).set({',
      '      authType: event.authType,',
      '      authId: event.authId ?? null,',
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
  hostCtx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-firestore-auth-child',
    instanceId: 'functions-firestore-auth-child-test',
    firestoreRules: AUTH_SCOPED_RULES,
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx: hostCtx,
    sandboxId: 'functions-firestore-auth-child-peer',
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

describe('Firestore v2 *WithAuthContext triggers in isolated child process', () => {
  test('propagates authentic authType and authId across 2 distinct UIDs, anon, admin, batches, and transactions while keeping non-auth triggers clean', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live HostedRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const aliceDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'uid-alice' }));
    const bobDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'uid-bob' }));
    const anonDb = getClientFirestore(hostCtx.sandbox.withAuth(null));

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
        triggerCount: 8,
        unsupportedTriggers: [],
      });

      // 1. Alice creates t-1 via WriteBatch; Bob updates t-1 via runTransaction; Admin deletes t-1
      const aliceBatch = writeBatch(aliceDb);
      aliceBatch.set(pyricDoc(aliceDb, 'workspaces/ws-1/tasks/t-1'), { title: 'Spec v1' });
      await aliceBatch.commit();

      await runTransaction(bobDb, async (tx) => {
        tx.update(pyricDoc(bobDb, 'workspaces/ws-1/tasks/t-1'), { title: 'Spec v2' });
      });

      await adminObserverDb.doc('workspaces/ws-1/tasks/t-1').delete();

      // 2. Relayed actAs: { mode: 'as', uid: 'uid-bob' } create on t-2
      const encodedT2 = serializeDocData({ title: 'Relayed Bob' }, DOC_VALUE_ENCODING);
      await observer.channel.op({
        method: 'setDoc',
        path: 'workspaces/ws-1/tasks/t-2',
        data: JSON.parse(encodedT2.json) as unknown,
        valueEncoding: DOC_VALUE_ENCODING,
        actAs: { mode: 'as', uid: 'uid-bob' },
      });

      // 3. Unauthenticated create -> Alice update -> Admin delete on publicInbox/m-1
      await setDoc(pyricDoc(anonDb, 'publicInbox/m-1'), { body: 'hello anon' });
      await updateDoc(pyricDoc(aliceDb, 'publicInbox/m-1'), { body: 'triaged by alice' });
      await adminObserverDb.doc('publicInbox/m-1').delete();

      await waitForCondition(
        async () =>
          (await adminObserverDb.doc('audit/deleted-auth-t-1').get()).exists &&
          (await adminObserverDb.doc('audit/created-auth-t-2').get()).exists &&
          (await adminObserverDb.doc('audit/inbox-written-auth-3').get()).exists &&
          (await adminObserverDb.doc('audit/plain-7').get()).exists,
      );

      expect((await adminObserverDb.doc('audit/created-auth-t-1').get()).data()).toEqual({
        wsId: 'ws-1',
        taskId: 't-1',
        type: 'google.cloud.firestore.document.v1.created.withAuthContext',
        authType: 'unknown',
        authId: 'uid-alice',
        v1AuthType: 'unknown',
        v1AuthId: 'uid-alice',
        title: 'Spec v1',
      });
      expect((await adminObserverDb.doc('audit/updated-auth-t-1').get()).data()).toEqual({
        type: 'google.cloud.firestore.document.v1.updated.withAuthContext',
        authType: 'unknown',
        authId: 'uid-bob',
        beforeTitle: 'Spec v1',
        afterTitle: 'Spec v2',
      });
      expect((await adminObserverDb.doc('audit/deleted-auth-t-1').get()).data()).toEqual({
        type: 'google.cloud.firestore.document.v1.deleted.withAuthContext',
        authType: 'service_account',
        authId: null,
        removedTitle: 'Spec v2',
      });
      expect((await adminObserverDb.doc('audit/created-auth-t-2').get()).data()).toEqual({
        wsId: 'ws-1',
        taskId: 't-2',
        type: 'google.cloud.firestore.document.v1.created.withAuthContext',
        authType: 'unknown',
        authId: 'uid-bob',
        v1AuthType: 'unknown',
        v1AuthId: 'uid-bob',
        title: 'Relayed Bob',
      });

      expect((await adminObserverDb.doc('audit/inbox-written-auth-1').get()).data()).toEqual({
        seq: 1,
        msgId: 'm-1',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        authType: 'unauthenticated',
        authId: null,
        beforeExists: false,
        afterExists: true,
      });
      expect((await adminObserverDb.doc('audit/inbox-written-auth-2').get()).data()).toEqual({
        seq: 2,
        msgId: 'm-1',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        authType: 'unknown',
        authId: 'uid-alice',
        beforeExists: true,
        afterExists: true,
      });
      expect((await adminObserverDb.doc('audit/inbox-written-auth-3').get()).data()).toEqual({
        seq: 3,
        msgId: 'm-1',
        type: 'google.cloud.firestore.document.v1.written.withAuthContext',
        authType: 'service_account',
        authId: null,
        beforeExists: true,
        afterExists: false,
      });

      for (let i = 1; i <= 7; i += 1) {
        const plainSnap = await adminObserverDb.doc(`audit/plain-${i}`).get();
        expect(plainSnap.data()).toMatchObject({
          hasAuthType: false,
          hasAuthId: false,
          v1AuthTypeNull: true,
          v1AuthIdNull: true,
        });
      }

      const rejected = events.filter(
        (ev) => ev.type === 'execution' && ev.status === 'rejected',
      );
      expect(rejected).toEqual([]);
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 25_000);

  test('executes ESM top-level-await *WithAuthContext triggers across distinct principals', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live HostedRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const aliceDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'uid-alice' }));
    const anonDb = getClientFirestore(hostCtx.sandbox.withAuth(null));

    const localChild = spawnFunctionsChild({
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
    });
    child = localChild;

    try {
      expect(await localChild.ready).toEqual({
        triggerCount: 4,
        unsupportedTriggers: [],
      });

      await setDoc(pyricDoc(aliceDb, 'esmPosts/p-1'), { text: 'v1' });
      await updateDoc(pyricDoc(anonDb, 'esmPosts/p-1'), { text: 'v2' });
      await deleteDoc(pyricDoc(aliceDb, 'esmPosts/p-1'));

      await waitForCondition(
        async () =>
          (await adminObserverDb.doc('audit/esm-deleted-p-1').get()).exists &&
          (await adminObserverDb.doc('audit/esm-written-3').get()).exists,
      );

      expect((await adminObserverDb.doc('audit/esm-created-p-1').get()).data()).toEqual({
        authType: 'unknown',
        authId: 'uid-alice',
      });
      expect((await adminObserverDb.doc('audit/esm-updated-p-1').get()).data()).toEqual({
        authType: 'unauthenticated',
        authId: null,
      });
      expect((await adminObserverDb.doc('audit/esm-deleted-p-1').get()).data()).toEqual({
        authType: 'unknown',
        authId: 'uid-alice',
      });
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 20_000);
});
