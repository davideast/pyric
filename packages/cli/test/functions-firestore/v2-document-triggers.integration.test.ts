import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pyricAdminFirestore from 'pyric-admin/firestore';
import {
  arrayRemove,
  arrayUnion,
  deleteDoc,
  deleteField,
  doc as pyricDoc,
  getFirestore as getClientFirestore,
  increment,
  runTransaction,
  serverTimestamp,
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
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

const tempDirs = trackTempDirs('pyric-functions-firestore-lifecycle-');
let fixtureDir = '';
let runtime: ServeRuntime | undefined;
let hostCtx: HostCtx | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;
let child: FunctionsChildHandle | undefined;

const RESTRICTIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
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
  throw new Error('Timed out waiting for Firestore v2 lifecycle trigger condition.');
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
    JSON.stringify({ name: 'cjs-firestore-lifecycle', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      "const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } = require('firebase-functions/v2/firestore');",
      "const { getApps, initializeApp } = require('firebase-admin/app');",
      "const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');",
      '',
      'function db() {',
      '  if (getApps().length === 0) initializeApp();',
      '  return getFirestore();',
      '}',
      '',
      'let updateSeq = 0;',
      'exports.onTicketUpdated = onDocumentUpdated(',
      "  { document: 'users/{uid}/tickets/{ticketId}', region: 'europe-west1' },",
      '  async (event) => {',
      '    updateSeq += 1;',
      '    const before = event.data.before;',
      '    const after = event.data.after;',
      '    await db().doc(`audit/ticket-update-${updateSeq}`).set({',
      '      seq: updateSeq,',
      '      uid: event.params.uid,',
      '      ticketId: event.params.ticketId,',
      '      type: event.type,',
      '      location: event.location,',
      '      beforeExists: before.exists,',
      '      afterExists: after.exists,',
      '      beforeData: before.data(),',
      '      afterData: after.data(),',
      '      sameCreateTime: before.createTime.isEqual(after.createTime),',
      '      updateAdvanced: after.updateTime.toMillis() >= before.updateTime.toMillis(),',
      '      snapshotsEqual: before.isEqual(after),',
      '    });',
      '  },',
      ');',
      '',
      'exports.onTicketDeleted = onDocumentDeleted(',
      "  'users/{uid}/tickets/{ticketId}',",
      '  async (event) => {',
      '    const snap = event.data;',
      '    await db().doc(`audit/ticket-deleted-${event.params.ticketId}`).set({',
      '      uid: event.params.uid,',
      '      ticketId: event.params.ticketId,',
      '      type: event.type,',
      '      exists: snap.exists,',
      '      path: snap.ref.path,',
      '      removedData: snap.data(),',
      '      hasValidTimes:',
      '        snap.createTime instanceof Timestamp &&',
      '        snap.updateTime instanceof Timestamp &&',
      '        snap.readTime instanceof Timestamp,',
      '    });',
      '  },',
      ');',
      '',
      'let slugWriteSeq = 0;',
      'exports.onSlugWritten = onDocumentWritten(',
      "  'users/{uid}/slugs/{slugId}',",
      '  async (event) => {',
      '    slugWriteSeq += 1;',
      '    const before = event.data.before;',
      '    const after = event.data.after;',
      '    const beforeData = before.data();',
      '    const afterData = after.data();',
      '    await db().doc(`audit/slug-write-${slugWriteSeq}`).set({',
      '      seq: slugWriteSeq,',
      '      slugId: event.params.slugId,',
      '      type: event.type,',
      '      beforeExists: before.exists,',
      '      afterExists: after.exists,',
      '      beforeDataUndefined: beforeData === undefined,',
      '      afterDataUndefined: afterData === undefined,',
      "      beforeSlug: beforeData ? beforeData.slug : null,",
      "      afterSlug: afterData ? afterData.slug : null,",
      '    });',
      '    if (after.exists && afterData && typeof afterData.slug === "string") {',
      '      const normalized = afterData.slug.trim().toLowerCase();',
      '      // Unconditional idempotent merge write-back: must stop after 1 normalization hop.',
      '      await after.ref.set({ slug: normalized }, { merge: true });',
      '    }',
      '  },',
      ');',
      '',
      'let walletSeq = 0;',
      'exports.onWalletCreated = onDocumentCreated(',
      "  'users/{uid}/wallets/{walletId}',",
      '  async (event) => {',
      '    const data = event.data.data();',
      '    await db().doc(`audit/wallet-created-${event.params.walletId}`).set({',
      '      walletId: event.params.walletId,',
      '      balance: data.balance,',
      '      tags: data.tags ?? [],',
      '      hasOpenedAt: data.openedAt instanceof Timestamp,',
      '    });',
      '  },',
      ');',
      '',
      'exports.onWalletUpdated = onDocumentUpdated(',
      "  'users/{uid}/wallets/{walletId}',",
      '  async (event) => {',
      '    walletSeq += 1;',
      '    const beforeData = event.data.before.data();',
      '    const afterData = event.data.after.data();',
      '    await db().runTransaction(async (tx) => {',
      '      const ledgerRef = db().doc(`audit/wallet-ledger-${event.params.walletId}`);',
      '      tx.set(',
      '        ledgerRef,',
      '        {',
      '          updates: FieldValue.increment(1),',
      '          lastBeforeBalance: beforeData.balance,',
      '          lastAfterBalance: afterData.balance,',
      '          afterTags: afterData.tags ?? [],',
      "          legacyPresent: Object.prototype.hasOwnProperty.call(afterData, 'legacyFlag'),",
      '        },',
      '        { merge: true },',
      '      );',
      '    });',
      '  },',
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
      name: 'esm-firestore-lifecycle',
      private: true,
      type: 'module',
      main: 'index.js',
    }),
  );
  writeFileSync(
    join(fixtureDir, 'functions-esm/index.js'),
    [
      "import { onDocumentUpdated, onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';",
      "import { getApps, initializeApp } from 'firebase-admin/app';",
      "import { getFirestore } from 'firebase-admin/firestore';",
      'await Promise.resolve();',
      '',
      'function db() {',
      '  if (getApps().length === 0) initializeApp();',
      '  return getFirestore();',
      '}',
      '',
      'export const trackNoteUpdated = onDocumentUpdated(',
      "  'users/{uid}/notes/{noteId}',",
      '  async (event) => {',
      '    await db().doc(`audit/esm-updated-${event.params.noteId}`).set({',
      '      beforeText: event.data.before.data().text,',
      '      afterText: event.data.after.data().text,',
      '    });',
      '  },',
      ');',
      '',
      'export const trackNoteDeleted = onDocumentDeleted(',
      "  'users/{uid}/notes/{noteId}',",
      '  async (event) => {',
      '    await db().doc(`audit/esm-deleted-${event.params.noteId}`).set({',
      '      finalText: event.data.data().text,',
      '    });',
      '  },',
      ');',
      '',
      'let esmWriteCount = 0;',
      'export const trackNoteWritten = onDocumentWritten(',
      "  'users/{uid}/notes/{noteId}',",
      '  async (event) => {',
      '    esmWriteCount += 1;',
      '    await db().doc(`audit/esm-written-${esmWriteCount}`).set({',
      '      beforeExists: event.data.before.exists,',
      '      afterExists: event.data.after.exists,',
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
    persistenceKeyPrefix: 'functions-firestore-lifecycle',
    instanceId: 'functions-firestore-lifecycle-test',
    firestoreRules: RESTRICTIVE_RULES,
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx: hostCtx,
    sandboxId: 'functions-firestore-lifecycle-peer',
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

describe('Firestore v2 lifecycle triggers (updated, deleted, written) in isolated child', () => {
  test('delivers Change<DocumentSnapshot> across create/update/delete, terminates self-write-backs without loops, and handles batches, transactions, merge, and FieldValue sentinels', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live HostedRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const aliceClientDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'alice' }));

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
      onEvent: (event) => events.push(event),
    });
    child = localChild;

    try {
      const ready = await localChild.ready;
      expect(ready).toEqual({
        triggerCount: 5,
        unsupportedTriggers: [],
      });

      // 1. Ticket create -> no-op merge -> real update -> delete
      await setDoc(pyricDoc(aliceClientDb, 'users/alice/tickets/t-42'), {
        title: 'Draft',
        priority: 1,
      });
      // Idempotent merge write with identical field values must NOT fire onDocumentUpdated
      await setDoc(
        pyricDoc(aliceClientDb, 'users/alice/tickets/t-42'),
        { title: 'Draft' },
        { merge: true },
      );
      await updateDoc(pyricDoc(aliceClientDb, 'users/alice/tickets/t-42'), {
        title: 'Published',
        priority: 2,
      });
      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/ticket-update-1').get()).exists,
      );

      await deleteDoc(pyricDoc(aliceClientDb, 'users/alice/tickets/t-42'));
      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/ticket-deleted-t-42').get()).exists,
      );

      const ticketUpdateSnap = await adminObserverDb.doc('audit/ticket-update-1').get();
      expect(ticketUpdateSnap.data()).toEqual({
        seq: 1,
        uid: 'alice',
        ticketId: 't-42',
        type: 'google.cloud.firestore.document.v1.updated',
        location: 'europe-west1',
        beforeExists: true,
        afterExists: true,
        beforeData: { title: 'Draft', priority: 1 },
        afterData: { title: 'Published', priority: 2 },
        sameCreateTime: true,
        updateAdvanced: true,
        snapshotsEqual: false,
      });
      expect((await adminObserverDb.doc('audit/ticket-update-2').get()).exists).toBe(false);

      const ticketDeleteSnap = await adminObserverDb.doc('audit/ticket-deleted-t-42').get();
      expect(ticketDeleteSnap.data()).toEqual({
        uid: 'alice',
        ticketId: 't-42',
        type: 'google.cloud.firestore.document.v1.deleted',
        exists: true,
        path: 'users/alice/tickets/t-42',
        removedData: { title: 'Published', priority: 2 },
        hasValidTimes: true,
      });

      // 2. Self-normalizing onDocumentWritten with unconditional merge write-back
      await setDoc(pyricDoc(aliceClientDb, 'users/alice/slugs/s-1'), { slug: '  Hello-Pyric  ' });
      await waitForCondition(async () => {
        const snap = await adminObserverDb.doc('users/alice/slugs/s-1').get();
        return snap.data()?.slug === 'hello-pyric';
      });
      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/slug-write-2').get()).exists,
      );
      await setDoc(
        pyricDoc(aliceClientDb, 'users/alice/slugs/s-1'),
        { slug: 'hello-pyric' },
        { merge: true },
      );
      await deleteDoc(pyricDoc(aliceClientDb, 'users/alice/slugs/s-1'));
      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/slug-write-3').get()).exists,
      );

      expect((await adminObserverDb.doc('audit/slug-write-1').get()).data()).toEqual({
        seq: 1, slugId: 's-1', type: 'google.cloud.firestore.document.v1.written',
        beforeExists: false, afterExists: true, beforeDataUndefined: true, afterDataUndefined: false,
        beforeSlug: null, afterSlug: '  Hello-Pyric  ',
      });
      expect((await adminObserverDb.doc('audit/slug-write-2').get()).data()).toEqual({
        seq: 2, slugId: 's-1', type: 'google.cloud.firestore.document.v1.written',
        beforeExists: true, afterExists: true, beforeDataUndefined: false, afterDataUndefined: false,
        beforeSlug: '  Hello-Pyric  ', afterSlug: 'hello-pyric',
      });
      expect((await adminObserverDb.doc('audit/slug-write-3').get()).data()).toEqual({
        seq: 3, slugId: 's-1', type: 'google.cloud.firestore.document.v1.written',
        beforeExists: true, afterExists: false, beforeDataUndefined: false, afterDataUndefined: true,
        beforeSlug: 'hello-pyric', afterSlug: null,
      });
      expect((await adminObserverDb.doc('audit/slug-write-4').get()).exists).toBe(false);

      // 3. WriteBatch (multi-op coalescing + ephemeral create/delete suppression),
      //    FieldValue sentinels, and runTransaction
      const walletRef = pyricDoc(aliceClientDb, 'users/alice/wallets/w-1');
      const ephemeralRef = pyricDoc(aliceClientDb, 'users/alice/wallets/w-ephemeral');
      const setupBatch = writeBatch(aliceClientDb);
      setupBatch.set(walletRef, {
        balance: 100,
        legacyFlag: true,
        tags: ['seed', 'temp'],
        openedAt: serverTimestamp(),
      });
      setupBatch.update(walletRef, {
        balance: increment(50),
        tags: arrayUnion('verified'),
      });
      setupBatch.set(ephemeralRef, { balance: 1 });
      setupBatch.delete(ephemeralRef);
      await setupBatch.commit();

      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/wallet-created-w-1').get()).exists,
      );
      expect((await adminObserverDb.doc('audit/wallet-created-w-1').get()).data()).toEqual({
        walletId: 'w-1',
        balance: 150,
        tags: ['seed', 'temp', 'verified'],
        hasOpenedAt: true,
      });
      expect(
        (await adminObserverDb.doc('audit/wallet-created-w-ephemeral').get()).exists,
      ).toBe(false);
      // Coalesced create+update in setupBatch must NOT spuriously fire onWalletUpdated
      expect((await adminObserverDb.doc('audit/wallet-ledger-w-1').get()).exists).toBe(false);

      // Aborted transaction must emit zero trigger executions
      await expect(
        runTransaction(aliceClientDb, async (tx) => {
          tx.update(walletRef, { balance: 999 });
          throw new Error('EXPECTED_TX_ROLLBACK');
        }),
      ).rejects.toThrow('EXPECTED_TX_ROLLBACK');

      // Committed transaction with increment, arrayRemove, arrayUnion, and deleteField
      await runTransaction(aliceClientDb, async (tx) => {
        const snap = await tx.get(walletRef);
        const current = Number(snap.data()?.balance ?? 0);
        tx.update(walletRef, {
          balance: current + 25,
          legacyFlag: deleteField(),
          tags: arrayRemove('temp'),
        });
      });

      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/wallet-ledger-w-1').get()).exists,
      );
      expect((await adminObserverDb.doc('audit/wallet-ledger-w-1').get()).data()).toEqual({
        updates: 1,
        lastBeforeBalance: 150,
        lastAfterBalance: 175,
        afterTags: ['seed', 'verified'],
        legacyPresent: false,
      });

      const rejected = events.filter(
        (ev) => ev.type === 'execution' && ev.status === 'rejected',
      );
      expect(rejected).toEqual([]);
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 25_000);

  test('executes unchanged ESM onDocumentUpdated, onDocumentDeleted, and onDocumentWritten source against live HostedRuntime', async () => {
    if (runtime === undefined || observer === undefined || hostCtx === undefined) {
      throw new Error('expected live HostedRuntime and HostCtx');
    }

    const adminObserverDb = pyricAdminFirestore.getAdminFirestore(observer);
    const bobClientDb = getClientFirestore(hostCtx.sandbox.withAuth({ uid: 'bob' }));
    const events: FunctionsChildEvent[] = [];

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
      onEvent: (event) => events.push(event),
    });
    child = localChild;

    try {
      expect(await localChild.ready).toEqual({
        triggerCount: 3,
        unsupportedTriggers: [],
      });

      const noteRef = pyricDoc(bobClientDb, 'users/bob/notes/n-7');
      await setDoc(noteRef, { text: 'first draft' });
      await updateDoc(noteRef, { text: 'second draft' });
      await deleteDoc(noteRef);

      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/esm-written-3').get()).exists,
      );
      await waitForCondition(
        async () => (await adminObserverDb.doc('audit/esm-deleted-n-7').get()).exists,
      );

      expect((await adminObserverDb.doc('audit/esm-updated-n-7').get()).data()).toEqual({
        beforeText: 'first draft', afterText: 'second draft',
      });
      expect((await adminObserverDb.doc('audit/esm-deleted-n-7').get()).data()).toEqual({
        finalText: 'second draft',
      });
      expect((await adminObserverDb.doc('audit/esm-written-1').get()).data()).toEqual({
        beforeExists: false, afterExists: true,
      });
      expect((await adminObserverDb.doc('audit/esm-written-2').get()).data()).toEqual({
        beforeExists: true, afterExists: true,
      });
      expect((await adminObserverDb.doc('audit/esm-written-3').get()).data()).toEqual({
        beforeExists: true, afterExists: false,
      });

      const rejected = events.filter(
        (ev) => ev.type === 'execution' && ev.status === 'rejected',
      );
      expect(rejected).toEqual([]);
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 20_000);
});
