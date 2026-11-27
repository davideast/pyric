import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
} from 'pyric/rules/internal';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  DOC_VALUE_ENCODING,
  deserializeDocData,
  serializeDocData,
  type SerializedDocData,
} from '../../src/serve/worker/protocol.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');

const tempDirs = trackTempDirs('pyric-functions-firestore-hosted-');
let activeProcess: ChildProcess | undefined;
let activeObserver: RemoteSandbox | undefined;

async function waitFor<T>(
  probe: () => T | null | Promise<T | null>,
  timeoutMs = 12_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error('Timed out waiting for live HostedRuntime Firestore trigger outcome');
}

async function writeHostedDoc(
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

async function readHostedDoc(
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

afterEach(async () => {
  activeObserver?.close();
  activeObserver = undefined;
  if (activeProcess !== undefined && activeProcess.exitCode === null) {
    activeProcess.kill('SIGKILL');
    await new Promise<void>((resolveExit) => {
      activeProcess?.once('close', () => resolveExit());
    });
  }
  activeProcess = undefined;
  tempDirs.cleanupTempDirs();
});

describe('pyric sandbox --hosted Firestore v2 onDocumentCreated E2E', () => {
  test('runs live HostedRuntime + isolated Functions child under Node and writes back via firebase-admin/firestore', async () => {
    if (!existsSync(cliEntry)) {
      throw new Error(`Build packages/cli first: ${cliEntry}`);
    }

    const cwd = tempDirs.makeTempDir();
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>hosted</body>');
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-project' } }),
    );
    writeFileSync(
      join(cwd, 'firestore.rules'),
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /{document=**} {',
        '      allow read, write: if false;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        hosting: { public: 'public' },
        firestore: { rules: 'firestore.rules' },
        functions: { source: 'functions' },
      }),
    );
    writeFileSync(
      join(cwd, 'functions/package.json'),
      JSON.stringify({
        name: 'hosted-firestore-functions',
        private: true,
        type: 'commonjs',
        main: 'index.cjs',
      }),
    );
    writeFileSync(
      join(cwd, 'functions/index.cjs'),
      [
        "const { onDocumentCreated } = require('firebase-functions/v2/firestore');",
        "const { getApps, initializeApp } = require('firebase-admin/app');",
        "const { getFirestore, Timestamp, GeoPoint } = require('firebase-admin/firestore');",
        '',
        'exports.stampHostedOrder = onDocumentCreated(',
        "  'tenants/{tenantId}/orders/{orderId}',",
        '  async (event) => {',
        '    if (getApps().length === 0) initializeApp();',
        '    const snap = event.data;',
        '    const doc = snap.data();',
        '    await snap.ref.update({',
        '      hostedStamped: true,',
        '      tenantParam: event.params.tenantId,',
        '      orderParam: event.params.orderId,',
        '      isTimestamp: doc.createdAt instanceof Timestamp,',
        '      isGeoPoint: doc.origin instanceof GeoPoint,',
        '      isBuffer: Buffer.isBuffer(doc.checksum),',
        "      ownerPath: doc.owner ? doc.owner.path : null,",
        '    });',
        '    await getFirestore().doc(`summaries/${event.params.orderId}`).set({',
        '      tenantId: event.params.tenantId,',
        '      amount: doc.amount,',
        '    });',
        '  },',
        ');',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    let stdout = '';
    let stderr = '';
    activeProcess = spawn(
      process.env.PYRIC_TEST_NODE ?? 'node',
      [cliEntry, 'sandbox', '--hosted', '--bridge', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeProcess.stdout?.setEncoding('utf8');
    activeProcess.stderr?.setEncoding('utf8');
    activeProcess.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    activeProcess.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const serveUrl = await waitFor(() => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      return match !== null ? match[0] : null;
    });

    await waitFor(() => (stdout.includes('functions 1 trigger from ') ? true : null));

    activeObserver = await connectRemoteSandbox({ url: serveUrl, cwd });

    await writeHostedDoc(activeObserver, 'tenants/acme/orders/ord-500', {
      amount: 8800,
      createdAt: new RulesTimestamp(1_730_000_000, 750_000_000),
      origin: new RulesLatLng(37.7749, -122.4194),
      checksum: new RulesBytes(new Uint8Array([0xfe, 0xed])),
      owner: new RulesReference('users/u-acme'),
    });

    const stampedOrder = await waitFor(async () => {
      const doc = await readHostedDoc(activeObserver as RemoteSandbox, 'tenants/acme/orders/ord-500');
      if (doc !== null && doc.hostedStamped === true) return doc;
      return null;
    });

    expect(stampedOrder.tenantParam).toBe('acme');
    expect(stampedOrder.orderParam).toBe('ord-500');
    expect(stampedOrder.isTimestamp).toBe(true);
    expect(stampedOrder.isGeoPoint).toBe(true);
    expect(stampedOrder.isBuffer).toBe(true);
    expect(stampedOrder.ownerPath).toBe('users/u-acme');

    const summary = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'summaries/ord-500'),
    );
    expect(summary).toEqual({ tenantId: 'acme', amount: 8800 });

    await waitFor(() => {
      const loggedRun =
        stdout.includes('stampHostedOrder') && stdout.includes('tenants/acme/orders/ord-500');
      if (loggedRun) return true;
      return null;
    });

    activeObserver.close();
    activeObserver = undefined;

    const exitCode = await new Promise<number | null>((resolveExit) => {
      activeProcess?.once('close', (code) => resolveExit(code));
      activeProcess?.kill('SIGTERM');
    });
    activeProcess = undefined;

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('uncaught');
  }, 25_000);

  test('executes onDocumentUpdated, onDocumentDeleted, and onDocumentWritten under pyric sandbox --hosted', async () => {
    if (!existsSync(cliEntry)) {
      throw new Error(`Build packages/cli first: ${cliEntry}`);
    }

    const cwd = tempDirs.makeTempDir();
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>hosted</body>');
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-project' } }),
    );
    writeFileSync(
      join(cwd, 'firestore.rules'),
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /{document=**} {',
        '      allow read, write: if false;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        hosting: { public: 'public' },
        firestore: { rules: 'firestore.rules' },
        functions: { source: 'functions' },
      }),
    );
    writeFileSync(
      join(cwd, 'functions/package.json'),
      JSON.stringify({
        name: 'hosted-firestore-lifecycle',
        private: true,
        type: 'commonjs',
        main: 'index.cjs',
      }),
    );
    writeFileSync(
      join(cwd, 'functions/index.cjs'),
      [
        "const { onDocumentUpdated, onDocumentDeleted, onDocumentWritten } = require('firebase-functions/v2/firestore');",
        "const { getApps, initializeApp } = require('firebase-admin/app');",
        "const { getFirestore } = require('firebase-admin/firestore');",
        '',
        'function db() {',
        '  if (getApps().length === 0) initializeApp();',
        '  return getFirestore();',
        '}',
        '',
        'exports.onJobUpdated = onDocumentUpdated(',
        "  'jobs/{jobId}',",
        '  async (event) => {',
        '    await db().doc(`audit/updated-${event.params.jobId}`).set({',
        '      beforeState: event.data.before.data().state,',
        '      afterState: event.data.after.data().state,',
        '    });',
        '  },',
        ');',
        '',
        'exports.onJobDeleted = onDocumentDeleted(',
        "  'jobs/{jobId}',",
        '  async (event) => {',
        '    await db().doc(`audit/deleted-${event.params.jobId}`).set({',
        '      deletedState: event.data.data().state,',
        '    });',
        '  },',
        ');',
        '',
        'let writtenSeq = 0;',
        'exports.onJobWritten = onDocumentWritten(',
        "  'jobs/{jobId}',",
        '  async (event) => {',
        '    writtenSeq += 1;',
        '    await db().doc(`audit/written-${writtenSeq}`).set({',
        '      beforeExists: event.data.before.exists,',
        '      afterExists: event.data.after.exists,',
        '    });',
        '  },',
        ');',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    let stdout = '';
    let stderr = '';
    activeProcess = spawn(
      process.env.PYRIC_TEST_NODE ?? 'node',
      [cliEntry, 'sandbox', '--hosted', '--bridge', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeProcess.stdout?.setEncoding('utf8');
    activeProcess.stderr?.setEncoding('utf8');
    activeProcess.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    activeProcess.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const serveUrl = await waitFor(() => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      return match !== null ? match[0] : null;
    });
    await waitFor(() => (stdout.includes('functions 3 triggers from ') ? true : null));

    activeObserver = await connectRemoteSandbox({ url: serveUrl, cwd });

    await writeHostedDoc(activeObserver, 'jobs/job-9', { state: 'queued' });
    await writeHostedDoc(activeObserver, 'jobs/job-9', { state: 'queued' });
    await writeHostedDoc(activeObserver, 'jobs/job-9', { state: 'done' });
    await activeObserver.channel.op({
      method: 'deleteDoc',
      path: 'jobs/job-9',
      actAs: { mode: 'admin' },
    });

    const updatedDoc = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'audit/updated-job-9'),
    );
    expect(updatedDoc).toEqual({ beforeState: 'queued', afterState: 'done' });

    const deletedDoc = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'audit/deleted-job-9'),
    );
    expect(deletedDoc).toEqual({ deletedState: 'done' });

    const written3 = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'audit/written-3'),
    );
    expect(written3).toEqual({ beforeExists: true, afterExists: false });
    expect(await readHostedDoc(activeObserver, 'audit/written-4')).toBeNull();

    activeObserver.close();
    activeObserver = undefined;

    const exitCode = await new Promise<number | null>((resolveExit) => {
      activeProcess?.once('close', (code) => resolveExit(code));
      activeProcess?.kill('SIGTERM');
    });
    activeProcess = undefined;

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('uncaught');
  }, 25_000);

  test('propagates *WithAuthContext principals and serializes handler/uncaught errors without crashing sibling triggers under pyric sandbox --hosted', async () => {
    if (!existsSync(cliEntry)) {
      throw new Error(`Build packages/cli first: ${cliEntry}`);
    }

    const cwd = tempDirs.makeTempDir();
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>hosted</body>');
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-project' } }),
    );
    writeFileSync(
      join(cwd, 'firestore.rules'),
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /notes/{noteId} {',
        '      allow read, write: if true;',
        '    }',
        '    match /audit/{docId} {',
        '      allow read, write: if false;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        hosting: { public: 'public' },
        firestore: { rules: 'firestore.rules' },
        functions: { source: 'functions' },
      }),
    );
    writeFileSync(
      join(cwd, 'functions/package.json'),
      JSON.stringify({
        name: 'hosted-firestore-auth-and-errors',
        private: true,
        type: 'commonjs',
        main: 'index.cjs',
      }),
    );
    writeFileSync(
      join(cwd, 'functions/index.cjs'),
      [
        'const {',
        '  onDocumentCreated,',
        '  onDocumentWrittenWithAuthContext,',
        '  onDocumentCreatedWithAuthContext,',
        "} = require('firebase-functions/v2/firestore');",
        "const { getApps, initializeApp } = require('firebase-admin/app');",
        "const { getFirestore } = require('firebase-admin/firestore');",
        '',
        'function db() {',
        '  if (getApps().length === 0) initializeApp();',
        '  return getFirestore();',
        '}',
        '',
        'let seq = 0;',
        'exports.auditNoteAuth = onDocumentWrittenWithAuthContext(',
        "  'notes/{noteId}',",
        '  async (event) => {',
        '    seq += 1;',
        '    await db().doc(`audit/auth-${seq}`).set({',
        '      noteId: event.params.noteId,',
        '      authType: event.authType,',
        '      authId: event.authId ?? null,',
        '    });',
        '  },',
        ');',
        '',
        "exports.failingNoteHandler = onDocumentCreated('notes/{noteId}', async (event) => {",
        "  if (event.params.noteId === 'boom') {",
        '    setImmediate(() => {',
        "      throw new Error('EXPECTED_HOSTED_UNCAUGHT_TIMER');",
        '    });',
        "    throw new Error('EXPECTED_HOSTED_HANDLER_REJECTION');",
        '  }',
        '});',
        '',
        'exports.analyticsOnlyAuth = onDocumentCreatedWithAuthContext(',
        "  { document: 'notes/{noteId}', database: 'analytics' },",
        '  async () => {',
        "    await db().doc('audit/wrong-db').set({ fired: true });",
        '  },',
        ');',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    let stdout = '';
    let stderr = '';
    activeProcess = spawn(
      process.env.PYRIC_TEST_NODE ?? 'node',
      [cliEntry, 'sandbox', '--hosted', '--bridge', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeProcess.stdout?.setEncoding('utf8');
    activeProcess.stderr?.setEncoding('utf8');
    activeProcess.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    activeProcess.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const serveUrl = await waitFor(() => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      return match !== null ? match[0] : null;
    });
    await waitFor(() => (stdout.includes('functions 3 triggers from ') ? true : null));

    activeObserver = await connectRemoteSandbox({ url: serveUrl, cwd });

    const aliceEncoded = serializeDocData({ text: 'from alice' }, DOC_VALUE_ENCODING);
    await activeObserver.channel.op({
      method: 'setDoc',
      path: 'notes/boom',
      data: JSON.parse(aliceEncoded.json) as unknown,
      valueEncoding: DOC_VALUE_ENCODING,
      actAs: { mode: 'as', uid: 'uid-alice' },
    });

    const anonEncoded = serializeDocData({ text: 'from anon' }, DOC_VALUE_ENCODING);
    await activeObserver.channel.op({
      method: 'setDoc',
      path: 'notes/ok-after-error',
      data: JSON.parse(anonEncoded.json) as unknown,
      valueEncoding: DOC_VALUE_ENCODING,
      actAs: { mode: 'anon' },
    });

    await writeHostedDoc(activeObserver, 'notes/from-admin', { text: 'admin write' });

    const auth1 = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'audit/auth-1'),
    );
    const auth2 = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'audit/auth-2'),
    );
    const auth3 = await waitFor(async () =>
      readHostedDoc(activeObserver as RemoteSandbox, 'audit/auth-3'),
    );

    expect(auth1).toEqual({ noteId: 'boom', authType: 'unknown', authId: 'uid-alice' });
    expect(auth2).toEqual({ noteId: 'ok-after-error', authType: 'unauthenticated', authId: null });
    expect(auth3).toEqual({ noteId: 'from-admin', authType: 'service_account', authId: null });
    expect(await readHostedDoc(activeObserver, 'audit/wrong-db')).toBeNull();

    await waitFor(() => {
      const hasBothErrors =
        stderr.includes('EXPECTED_HOSTED_HANDLER_REJECTION') &&
        stderr.includes('EXPECTED_HOSTED_UNCAUGHT_TIMER');
      if (hasBothErrors) return true;
      return null;
    });

    activeObserver.close();
    activeObserver = undefined;

    const exitCode = await new Promise<number | null>((resolveExit) => {
      activeProcess?.once('close', (code) => resolveExit(code));
      activeProcess?.kill('SIGTERM');
    });
    activeProcess = undefined;

    expect(exitCode).toBe(0);
  }, 25_000);
});
