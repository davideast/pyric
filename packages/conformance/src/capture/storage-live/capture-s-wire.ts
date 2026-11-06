#!/usr/bin/env bun
/**
 * Capture S (issue #2114, Storage plan PR 1): every HTTP exchange the Node
 * builds of `firebase/storage` and `firebase/auth` make for a fixed sequence of
 * operations on the default bucket, for the live-mode Storage replay server.
 *
 * Operations: two anonymous sign-ins; uploadBytes (6 bytes); uploadString raw
 * and base64; uploadBytesResumable of 600 KiB; a second one paused after its
 * first chunk and resumed (its `query`); getMetadata, getDownloadURL,
 * getBytes, getStream and updateMetadata; list with maxResults 2 and its
 * second page; listAll over a nested prefix; a read by the second account;
 * deleteObject on each object; getMetadata and deleteObject on a missing
 * object (404); a denied upload, getBytes and list under the denied prefix,
 * and an upload from a client that never signed in (403).
 *
 * getBlob is not in the sequence: the Node build throws before it sends any
 * request, and the browser build sends getBytes's request (`alt=media`).
 *
 * The exchanges come from a recording `globalThis.fetch` installed before the
 * SDKs load; the SDKs themselves are not touched. Each exchange keeps its
 * method, path and query, the `X-Goog-Upload-*` and `Content-Type` headers,
 * request bytes as length and SHA-256, and the status, headers and body of the
 * answer. Authorization values are never written: the header becomes the
 * account it names. Download tokens, upload sessions, page tokens,
 * generations and times become placeholders, as do the project, bucket, run
 * and uids, and the file is written only when no token-shaped string remains.
 *
 * Safety: deploys no rules and restores none. It reads the bucket's released
 * rules first and refuses unless the oracle namespace rule (`pyric_oracle/*`,
 * allowed when signed in) is in place and nothing names the denied prefix.
 * It writes only under pyric_oracle/<run id>, deletes every object there at
 * the end (and on SIGINT), lists the prefix back, and deletes both anonymous
 * accounts; the recording is written only when the prefix reads back empty
 * and both accounts were deleted. It refuses to run in CI.
 *
 * Inert unless the oracle credential is configured (PYRIC_ORACLE_PROJECT_ID
 * with Application Default Credentials, or PYRIC_ORACLE_SA_PATH):
 *
 *   PYRIC_ORACLE_PROJECT_ID=<oracle project> \
 *     bun run packages/conformance/src/capture/storage-live/capture-s-wire.ts
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { FirebaseStorage, StorageReference, UploadTask } from 'firebase/storage';
import { oracleCredentialConfigured } from '../../oracle-credential.ts';
import { resolvedFirebaseVersion } from '../../package-version.ts';
import { loadLiveContext, withTimeout, writeRecording } from '../rtdb-live/live-capture.ts';
import {
  captureRefusal,
  DENIED_ROOT,
  FetchRecorder,
  installFetchRecorder,
  namespaceRulesRefusal,
  readBucketRules,
  RUN_ROOT,
  runWithStorageCleanup,
  storageRedactor,
  type Exchange,
  type RunObjects,
  type StorageInvariants,
} from './live-capture.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'recordings', 'capture-s-wire.json');

export const OPERATIONS = [
  'signIn', 'preflight', 'uploadBytes', 'uploadString-raw', 'uploadString-base64', 'uploadBytesResumable',
  'uploadBytesResumable-paused', 'getMetadata', 'getDownloadURL', 'getBytes', 'getStream',
  'updateMetadata', 'setup-nested', 'list', 'listAll', 'getMetadata-second-account', 'deleteObject',
  'getMetadata-missing', 'deleteObject-missing', 'denied-upload', 'denied-getBytes', 'denied-list',
  'signed-out-upload', 'cleanup', 'teardown',
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The operations production must deny, and the operations on an object that does not exist. */
export const DENIED: readonly Operation[] = ['denied-upload', 'denied-getBytes', 'denied-list', 'signed-out-upload'];
export const MISSING: readonly Operation[] = ['getMetadata-missing', 'deleteObject-missing'];

/** Every object the sequence uploads, relative to the run prefix; the sequence deletes each one. */
const OBJECTS = ['a.bin', 'raw.txt', 'b64.bin', 'big.bin', 'paused.bin', 'nested/x/one.txt', 'nested/two.txt'];
const SIX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
/** Over the SDK's 256 KiB resumable threshold, so the upload takes a start and at least two chunks. */
const RESUMABLE_BYTES = Uint8Array.from({ length: 600 * 1024 }, (_, i) => i % 251);
const STEP_TIMEOUT_MS = 60_000;

export type StorageModule = typeof import('firebase/storage');

export interface Client {
  name: string;
  app: FirebaseApp;
  auth: Auth;
  storage: FirebaseStorage;
}

export interface Result {
  ok: boolean;
  code?: string;
}

export interface Sequence {
  storage: StorageModule;
  recorder: FetchRecorder;
  one: Client;
  two: Client;
  signedOut: Client;
  runPath: string;
  deniedPath: string;
  /** Called with every upload task, so cleanup can cancel one still running. */
  track(task: UploadTask): void;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : String(error);
}

/**
 * Pause after the first chunk, in the turn after the SDK has created the next
 * chunk's request but before that request is sent. The Node build cannot abort
 * a request in flight, so only this pause cancels a request and makes the
 * resume ask production for the session's size (`X-Goog-Upload-Command: query`).
 */
async function pausedUpload(seq: Sequence, ref: StorageReference): Promise<void> {
  const task = seq.storage.uploadBytesResumable(ref, RESUMABLE_BYTES);
  seq.track(task);
  let pauseScheduled = false;
  let resumed = false;
  task.on('state_changed', (snapshot) => {
    if (!pauseScheduled && snapshot.bytesTransferred > 0 && snapshot.state === 'running') {
      pauseScheduled = true;
      setTimeout(() => task.pause(), 0);
    }
    if (pauseScheduled && !resumed && snapshot.state === 'paused') {
      resumed = true;
      task.resume();
    }
  });
  await task;
}

async function readStream(stream: ReadableStream): Promise<number> {
  return (await new Response(stream).arrayBuffer()).byteLength;
}

/** The capture's operation sequence; each step's outcome is a result, never a throw. */
export async function driveCapture(seq: Sequence): Promise<Partial<Record<Operation, Result>>> {
  const m = seq.storage;
  const results: Partial<Record<Operation, Result>> = {};
  const step = async (op: Operation, client: Client, run: () => Promise<unknown>): Promise<void> => {
    seq.recorder.op = op;
    seq.recorder.client = client.name;
    try {
      await withTimeout(op, run(), STEP_TIMEOUT_MS);
      results[op] = { ok: true };
    } catch (error) {
      results[op] = { ok: false, code: codeOf(error) };
    }
    await seq.recorder.settled();
  };
  const run = (client: Client, path: string) => m.ref(client.storage, `${seq.runPath}/${path}`);
  const denied = (client: Client, path: string) => m.ref(client.storage, `${seq.deniedPath}/${path}`);
  const { one, two, signedOut } = seq;

  await step('uploadBytes', one, () => m.uploadBytes(run(one, 'a.bin'), SIX_BYTES));
  await step('uploadString-raw', one, () => m.uploadString(run(one, 'raw.txt'), 'capture s', 'raw'));
  await step('uploadString-base64', one, () => m.uploadString(run(one, 'b64.bin'), 'Y2FwdHVyZSBz', 'base64'));
  await step('uploadBytesResumable', one, async () => {
    const task = m.uploadBytesResumable(run(one, 'big.bin'), RESUMABLE_BYTES);
    seq.track(task);
    await task;
  });
  await step('uploadBytesResumable-paused', one, () => pausedUpload(seq, run(one, 'paused.bin')));
  await step('getMetadata', one, () => m.getMetadata(run(one, 'a.bin')));
  await step('getDownloadURL', one, () => m.getDownloadURL(run(one, 'a.bin')));
  await step('getBytes', one, async () => {
    const bytes = await m.getBytes(run(one, 'a.bin'));
    if (bytes.byteLength !== SIX_BYTES.length) throw new Error(`getBytes read ${bytes.byteLength} bytes`);
  });
  await step('getStream', one, async () => {
    const length = await readStream(m.getStream(run(one, 'a.bin')));
    if (length !== SIX_BYTES.length) throw new Error(`getStream read ${length} bytes`);
  });
  await step('updateMetadata', one, () => m.updateMetadata(run(one, 'a.bin'), { cacheControl: 'no-store', customMetadata: { capture: 's' } }));
  await step('setup-nested', one, async () => {
    await m.uploadString(run(one, 'nested/x/one.txt'), 'one', 'raw');
    await m.uploadString(run(one, 'nested/two.txt'), 'two', 'raw');
  });
  await step('list', one, async () => {
    const root = m.ref(one.storage, seq.runPath);
    const first = await m.list(root, { maxResults: 2 });
    if (!first.nextPageToken) throw new Error('list returned no page token');
    await m.list(root, { maxResults: 2, pageToken: first.nextPageToken });
  });
  await step('listAll', one, async () => {
    const nested = await m.listAll(run(one, 'nested'));
    if (nested.prefixes.length !== 1 || nested.items.length !== 1) throw new Error('listAll did not see the nested prefix');
  });
  await step('getMetadata-second-account', two, () => m.getMetadata(run(two, 'a.bin')));
  await step('deleteObject', one, async () => {
    for (const path of OBJECTS) await m.deleteObject(run(one, path));
  });
  await step('getMetadata-missing', one, () => m.getMetadata(run(one, 'missing.bin')));
  await step('deleteObject-missing', one, () => m.deleteObject(run(one, 'missing.bin')));
  await step('denied-upload', two, async () => {
    const ref = denied(two, 'forbidden.bin');
    await m.uploadBytes(ref, SIX_BYTES);
    // Allowed after all: cleanup lists only the run prefix, so remove the object here; the run then fails.
    await m.deleteObject(ref);
  });
  await step('denied-getBytes', two, () => m.getBytes(denied(two, 'forbidden.bin')));
  await step('denied-list', two, () => m.list(denied(two, '')));
  await step('signed-out-upload', signedOut, () => m.uploadBytes(run(signedOut, 'signed-out.bin'), SIX_BYTES));
  return results;
}

/** Every reason the run cannot be written: an operation that did not answer as production should. */
export function sequenceFailures(results: Partial<Record<Operation, Result>>, exchanges: Exchange[]): string[] {
  const failures: string[] = [];
  for (const op of OPERATIONS) {
    const result = results[op];
    const expected = DENIED.includes(op) ? 'storage/unauthorized' : MISSING.includes(op) ? 'storage/object-not-found' : null;
    if (expected === null && result?.ok !== true) failures.push(`${op}: ${result?.code ?? 'no result'}`);
    if (expected !== null && result?.code !== expected) failures.push(`${op}: expected ${expected}, got ${result?.ok ? 'ok' : result?.code}`);
    if (!exchanges.some((e) => e.op === op)) failures.push(`${op}: no exchange recorded`);
  }
  const paused = exchanges.filter((e) => e.op === 'uploadBytesResumable-paused');
  if (!paused.some((e) => e.request.headers['x-goog-upload-command'] === 'query')) failures.push('uploadBytesResumable-paused: no query after the pause');
  for (const exchange of exchanges) {
    if (exchange.account === '<unknown-account>') failures.push(`exchange ${exchange.seq}: an ID token the capture did not sign in`);
    if (exchange.response.status === 0) failures.push(`exchange ${exchange.seq}: no answer`);
  }
  return failures;
}

async function main(): Promise<void> {
  const refusal = captureRefusal(process.env);
  if (refusal) {
    console.error(`[storage-live:capture-s] ${refusal}`);
    process.exit(2);
  }
  if (!oracleCredentialConfigured(process.env)) {
    console.log('[storage-live:capture-s] inert: set PYRIC_ORACLE_PROJECT_ID (Application Default Credentials) or PYRIC_ORACLE_SA_PATH to capture.');
    process.exit(0);
  }

  const ctx = await loadLiveContext();
  const bucket = ctx.webConfig.storageBucket;
  if (!bucket) throw new Error('the oracle web config has no storageBucket; Storage is not enabled on the project');
  const rulesRefusal = namespaceRulesRefusal(await readBucketRules(ctx, bucket));
  if (rulesRefusal) {
    console.error(`[storage-live:capture-s] refusing: ${rulesRefusal}. Nothing was written.`);
    process.exit(1);
  }

  const runPath = `${RUN_ROOT}/${ctx.runId}`;
  const deniedPath = `${DENIED_ROOT}/${ctx.runId}`;
  const redactor = storageRedactor(ctx, bucket);
  const recorder = new FetchRecorder(redactor);
  installFetchRecorder(recorder);
  const { deleteApp, initializeApp } = await import('firebase/app');
  const auth = await import('firebase/auth');
  const storage = await import('firebase/storage');

  const clients: Client[] = [];
  const client = (name: string): Client => {
    const app = initializeApp(ctx.webConfig, `storage-live-s-${ctx.runId}-${name}`);
    const made = { name, app, auth: auth.getAuth(app), storage: storage.getStorage(app) };
    clients.push(made);
    return made;
  };
  const signedIn = async (name: string, index: number): Promise<Client> => {
    const made = client(name);
    recorder.client = name;
    const { user } = await auth.signInAnonymously(made.auth);
    const token = await user.getIdToken();
    redactor.add(user.uid, `<uid-${index}>`);
    redactor.add(token, '<id-token>');
    redactor.add(user.refreshToken, '<refresh-token>');
    recorder.account(token, `<uid-${index}>`);
    return made;
  };
  /** Deletes both accounts and every app; throws when an account was not deleted. */
  const shutdown = async (): Promise<void> => {
    recorder.op = 'teardown';
    const errors: string[] = [];
    for (const made of clients) {
      recorder.client = made.name;
      const user = made.auth.currentUser;
      if (user) await auth.deleteUser(user).catch((e: unknown) => errors.push(`delete ${made.name} account: ${codeOf(e)}`));
    }
    for (const made of clients) await deleteApp(made.app).catch((e: unknown) => errors.push(`delete ${made.name} app: ${codeOf(e)}`));
    await recorder.settled();
    if (errors.length > 0) throw new Error(errors.join('; '));
  };

  let one: Client;
  let two: Client;
  try {
    one = await signedIn('client-1', 1);
    two = await signedIn('client-2', 2);
  } catch (error) {
    await shutdown().catch((e: unknown) => console.error(`[storage-live:capture-s] ${String(e)}`));
    throw error;
  }
  const signedOut = client('signed-out');

  const tasks: UploadTask[] = [];
  const objects: RunObjects = {
    async list(prefix) {
      const paths: string[] = [];
      const walk = async (ref: StorageReference): Promise<void> => {
        const page = await storage.listAll(ref);
        paths.push(...page.items.map((item) => item.fullPath));
        for (const child of page.prefixes) await walk(child);
      };
      recorder.client = one.name;
      await walk(storage.ref(one.storage, prefix));
      await recorder.settled();
      return paths;
    },
    async remove(path) {
      recorder.client = one.name;
      await storage.deleteObject(storage.ref(one.storage, path));
    },
  };

  recorder.op = 'preflight';
  let run;
  try {
    run = await runWithStorageCleanup('capture S', objects, runPath, async () => {
      const results = await driveCapture({ storage, recorder, one, two, signedOut, runPath, deniedPath, track: (task) => tasks.push(task) });
      recorder.op = 'cleanup';
      return results;
    }, {
      quiesce: async () => {
        recorder.op = 'cleanup';
        for (const task of tasks) {
          const state = task.snapshot.state;
          if (state === 'running' || state === 'paused') task.cancel();
        }
      },
      settleMs: 2_000,
      shutdown,
      handleSignals: true,
    });
  } catch (error) {
    await shutdown().catch((e: unknown) => console.error(`[storage-live:capture-s] ${String(e)}`));
    throw error;
  }
  await recorder.settled();

  const invariants: StorageInvariants = run.invariants;
  const results: Partial<Record<Operation, Result>> = {
    signIn: { ok: true },
    preflight: { ok: true },
    ...run.result,
    cleanup: { ok: invariants.runPrefixEmpty },
    teardown: { ok: invariants.accountsDeleted },
  };
  if (!invariants.runPrefixEmpty || !invariants.accountsDeleted) {
    console.error('[storage-live:capture-s] an invariant failed; nothing written. List the run prefix and the accounts by hand.');
    process.exit(3);
  }
  const failures = [
    ...(run.error ? [run.error.message] : []),
    ...run.failures,
    ...sequenceFailures(results, recorder.exchanges),
  ];
  if (failures.length > 0) {
    console.error(`[storage-live:capture-s] capture failed; nothing written:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  // git keeps no empty directory, so the first recording creates its own.
  mkdirSync(dirname(OUT), { recursive: true });
  writeRecording(OUT, {
    name: 'storage-live-capture-s-wire',
    description: 'Every HTTP exchange the Node builds of firebase/storage and firebase/auth made against the default bucket for two anonymous sign-ins, uploadBytes, uploadString raw and base64, a resumable upload and a second one paused after its first chunk and resumed, getMetadata, getDownloadURL, getBytes, getStream, updateMetadata, list with maxResults 2 and its second page, listAll over a nested prefix, a read by the second account, deleteObject on each object, getMetadata and deleteObject on a missing object, a denied upload, getBytes and list, and an upload with no signed-in user. t is milliseconds since the capture started; op is the operation running when the request was sent; account is the uid the Authorization header named.',
    observedAt: new Date().toISOString(),
    sdkVersion: resolvedFirebaseVersion(),
    bucket: '<bucket>',
    runPath: `${RUN_ROOT}/<run>`,
    deniedPath: `${DENIED_ROOT}/<run>`,
    operations: OPERATIONS,
    accounts: ['<uid-1>', '<uid-2>'],
    placeholders: [
      '<project>', '<bucket>', '<run>', '<uid-N>', '<id-token>', '<refresh-token>', '<api-key>', '<app-id>',
      '<boundary>', '<upload-session>', '<download-token>', '<page-token>', '<generation>', '<time-created>',
      '<time-updated>', '<etag>',
    ],
    results,
    invariants,
    exchanges: recorder.exchanges,
  }, redactor);
  console.log(`[storage-live:capture-s] wrote ${OUT}: ${recorder.exchanges.length} exchanges, invariants ${JSON.stringify(invariants)}`);
  process.exit(0);
}

if (import.meta.main) await main();
