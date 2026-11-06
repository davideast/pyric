#!/usr/bin/env node
/**
 * Capture A (Admin) (issue #2304, step C-1): one recorded production run of
 * firebase-admin's Auth, Firestore, RTDB and Storage calls, for the replay
 * server's Admin handlers. The run spec is in the #2304 plan, "Capture A
 * (Admin): run spec".
 *
 * The wires come from the recorders in `./live-capture.ts`: gRPC for
 * Firestore, `https.request` for Auth, the cert fetch and Storage, and the
 * RTDB connection's data messages. The SDK is not otherwise touched.
 *
 * Safety:
 *   - Inert unless PYRIC_ORACLE_PROJECT_ID and PYRIC_STAGING_RTDB are both set.
 *     Refuses to run in CI, with FIRESTORE_PREFER_REST, or with an emulator
 *     variable set.
 *   - The credential is the oracle credential through Application Default
 *     Credentials (`src/oracle-credential.ts`). Nothing here names a project
 *     or a key path.
 *   - Prints the run id and its `--cleanup <run id>` command before it creates
 *     anything, and appends both to `pyric-capture-admin-run-ids.log` in the
 *     OS temp folder.
 *   - Writes only under pyric_oracle/<run id> in Firestore, RTDB and Storage,
 *     and one Auth user, pyric-admin-capture-<run id>@example.com, with a
 *     random password held in memory. Deploys no rules and changes no setting.
 *   - Cleanup, on success, on any failure and on SIGINT, deletes the user,
 *     every document under the run path, the RTDB run path and every object
 *     under the run prefix, and reads each back. A failed delete or read-back
 *     fails the run, and nothing is written. `--cleanup <run id>` runs only
 *     the cleanup.
 *   - The recording is written only when every case got its expected answer,
 *     and only when no credential pattern remains in it.
 *
 * One run by hand, on Node 24:
 *
 *   PYRIC_ORACLE_PROJECT_ID=<oracle project> PYRIC_STAGING_RTDB=<instance url> \
 *     node packages/conformance/src/capture/admin-live/capture-admin-wire.ts
 *
 *   ... capture-admin-wire.ts --cleanup <run id>
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import type { Database } from 'firebase-admin/database';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { resolvedAdminVersion } from '../../package-version.ts';
import {
  DEFAULT_INSTANCE_VARIABLE,
  instanceFromEnv,
  loadLiveContext,
  redactorFor,
  withTimeout,
  writeRecording,
  type LiveContext,
} from '../rtdb-live/live-capture.ts';
import {
  allHeld,
  announceRunId,
  captureRefusal,
  cleanupAdminRun,
  firestoreGrpcClient,
  GrpcRecorder,
  HttpRecorder,
  newStamp,
  persistentConnectionOf,
  Placeholders,
  RtdbRecorder,
  RUN_ROOT,
  runPathFor,
  runWithAdminCleanup,
  userEmailFor,
  type AdminRunState,
  runIdProblem,
  cleanupCommand,
  type RunControl,
  type Stamp,
} from './live-capture.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'recordings', 'capture-admin-wire.json');
const STEP_TIMEOUT_MS = 30_000;
const OK = 'ok';

/** One case of the run spec: the answer it expects is `ok` or the error code. */
export interface Step {
  op: string;
  expect: string;
  run: () => Promise<unknown>;
}

export interface Clients {
  app: App;
  auth: Auth;
  firestore: Firestore;
  database: Database;
  bucket: ReturnType<Storage['bucket']>;
}

/** What the steps share: the run, the client sign-in's tokens, and the listeners still open. */
interface RunValues {
  ctx: LiveContext;
  runPath: string;
  email: string;
  password: string;
  uid: string;
  idToken: string;
  closers: Array<() => void>;
  onSecret: (value: string, placeholder: string) => void;
}

export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return error instanceof Error ? error.message : String(error);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ─── Client sign-in (not recorded) ────────────────────────────────────────

/** The client side of the run: one password sign-in with the web API key. Global fetch, which no recorder sees. */
async function signInWithPassword(values: RunValues): Promise<{ idToken: string; refreshToken: string }> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(values.ctx.webConfig.apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: values.email, password: values.password, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`client sign-in answered ${response.status}`);
  return (await response.json()) as { idToken: string; refreshToken: string };
}

/** An RS256 token shaped like a pyric sandbox token (`kid: pyric-sandbox`), signed with a throwaway key. */
function sandboxShapedToken(projectId: string, uid: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' });
  const payload = encode({
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    auth_time: now,
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

// ─── The run spec ─────────────────────────────────────────────────────────

function authSteps(c: Clients, v: RunValues): Step[] {
  return [
    { op: 'auth.createUser', expect: OK, run: async () => {
      const user = await c.auth.createUser({ email: v.email, password: v.password });
      v.uid = user.uid;
      v.onSecret(user.uid, '<uid-1>');
    } },
    { op: 'auth.clientSignIn', expect: OK, run: async () => {
      const tokens = await signInWithPassword(v);
      v.idToken = tokens.idToken;
      v.onSecret(tokens.idToken, '<id-token>');
      v.onSecret(tokens.refreshToken, '<refresh-token>');
    } },
    { op: 'auth.verifyIdToken', expect: OK, run: () => c.auth.verifyIdToken(v.idToken) },
    { op: 'auth.verifyIdToken-checkRevoked', expect: OK, run: () => c.auth.verifyIdToken(v.idToken, true) },
    { op: 'auth.getUser', expect: OK, run: () => c.auth.getUser(v.uid) },
    { op: 'auth.getUserByEmail', expect: OK, run: () => c.auth.getUserByEmail(v.email) },
    { op: 'auth.setCustomUserClaims', expect: OK, run: () => c.auth.setCustomUserClaims(v.uid, { role: 'capture' }) },
    { op: 'auth.updateUser', expect: OK, run: () => c.auth.updateUser(v.uid, { displayName: 'Capture' }) },
    // Revocation compares whole seconds, so the sign-in has to be at least a second older than the revoke.
    { op: 'auth.revokeRefreshTokens', expect: OK, run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await c.auth.revokeRefreshTokens(v.uid);
    } },
    { op: 'auth.verifyIdToken-revoked', expect: 'auth/id-token-revoked', run: () => c.auth.verifyIdToken(v.idToken, true) },
    // firebase-admin answers an unknown kid itself, after fetching production's certs.
    { op: 'auth.verifyIdToken-sandbox-token', expect: 'auth/argument-error', run: () => c.auth.verifyIdToken(sandboxShapedToken(v.ctx.projectId, v.uid)) },
    { op: 'auth.deleteUser', expect: OK, run: () => c.auth.deleteUser(v.uid) },
    { op: 'auth.getUser-deleted', expect: 'auth/user-not-found', run: () => c.auth.getUser(v.uid) },
  ];
}

async function firstSnapshotThenChange(c: Clients, v: RunValues): Promise<void> {
  const notes = c.firestore.collection(`${v.runPath}/notes`);
  await new Promise<void>((resolve, reject) => {
    let snapshots = 0;
    const unsubscribe = notes.onSnapshot((snapshot) => {
      snapshots += 1;
      if (snapshots === 1) {
        notes.doc('d').set({ n: 4 }).catch(reject);
        return;
      }
      if (snapshot.docChanges().length === 0) return;
      unsubscribe();
      resolve();
    }, reject);
    v.closers.push(unsubscribe);
  });
}

function firestoreSteps(c: Clients, v: RunValues): Step[] {
  const notes = () => c.firestore.collection(`${v.runPath}/notes`);
  const a = () => notes().doc('a');
  const missing = () => notes().doc('missing');
  let added = '';
  return [
    { op: 'firestore.set', expect: OK, run: () => a().set({ n: 1 }) },
    { op: 'firestore.get', expect: OK, run: async () => check((await a().get()).exists, 'the document does not exist') },
    { op: 'firestore.get-missing', expect: OK, run: async () => check(!(await missing().get()).exists, 'the missing document exists') },
    { op: 'firestore.update', expect: OK, run: () => a().update({ n: 2 }) },
    { op: 'firestore.update-missing', expect: '5', run: () => missing().update({ n: 2 }) },
    { op: 'firestore.create-existing', expect: '6', run: () => a().create({ n: 1 }) },
    { op: 'firestore.add', expect: OK, run: async () => { added = (await notes().add({ n: 3 })).id; } },
    { op: 'firestore.query', expect: OK, run: async () => check((await notes().where('n', '>=', 1).get()).size === 2, 'the query did not see two documents') },
    { op: 'firestore.count', expect: OK, run: async () => check((await notes().count().get()).data().count === 2, 'count is not 2') },
    { op: 'firestore.getAll', expect: OK, run: () => c.firestore.getAll(a(), notes().doc(added)) },
    { op: 'firestore.batch', expect: OK, run: () => c.firestore.batch().set(notes().doc('c'), { n: 5 }).update(a(), { batched: true }).commit() },
    { op: 'firestore.runTransaction', expect: OK, run: () => c.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(a());
      tx.update(a(), { n: (snapshot.get('n') as number) + 1 });
    }) },
    { op: 'firestore.onSnapshot', expect: OK, run: () => firstSnapshotThenChange(c, v) },
    { op: 'firestore.delete', expect: OK, run: () => a().delete() },
  ];
}

async function firstValueThenChange(c: Clients, v: RunValues): Promise<void> {
  const watched = c.database.ref(`${v.runPath}/watch`);
  await new Promise<void>((resolve, reject) => {
    let values = 0;
    const listener = watched.on('value', () => {
      values += 1;
      if (values === 1) {
        watched.set(1).catch(reject);
        return;
      }
      watched.off('value', listener);
      resolve();
    }, reject);
    v.closers.push(() => watched.off('value', listener));
  });
}

function rtdbSteps(c: Clients, v: RunValues): Step[] {
  const run = () => c.database.ref(v.runPath);
  return [
    { op: 'rtdb.set', expect: OK, run: () => run().set({ a: 1 }) },
    { op: 'rtdb.get', expect: OK, run: async () => check((await run().get()).exists(), 'the run path is empty') },
    { op: 'rtdb.update', expect: OK, run: () => run().update({ b: 2 }) },
    { op: 'rtdb.push', expect: OK, run: async () => {
      const pushed = run().child('list').push({ c: 3 });
      v.onSecret(pushed.key!, '<push-id-1>');
      await pushed;
    } },
    { op: 'rtdb.transaction', expect: OK, run: async () => {
      const outcome = await run().child('counter').transaction((n: number | null) => (n ?? 0) + 1);
      check(outcome.committed, 'the transaction did not commit');
    } },
    { op: 'rtdb.on-value', expect: OK, run: () => firstValueThenChange(c, v) },
    { op: 'rtdb.once-missing', expect: OK, run: async () => check((await run().child('missing').once('value')).val() === null, 'the missing path has a value') },
    { op: 'rtdb.remove', expect: OK, run: () => run().remove() },
  ];
}

function storageSteps(c: Clients, v: RunValues): Step[] {
  const note = () => c.bucket.file(`${v.runPath}/note.txt`);
  const text = 'capture text';
  return [
    { op: 'storage.save', expect: OK, run: () => note().save(text, { resumable: false, contentType: 'text/plain' }) },
    { op: 'storage.getMetadata', expect: OK, run: () => note().getMetadata() },
    { op: 'storage.exists', expect: OK, run: async () => check((await note().exists())[0], 'the object does not exist') },
    { op: 'storage.download', expect: OK, run: async () => check((await note().download())[0].toString() === text, 'the download differs') },
    { op: 'storage.getFiles', expect: OK, run: async () => check((await c.bucket.getFiles({ prefix: `${v.runPath}/` }))[0].length === 1, 'the prefix does not hold one file') },
    { op: 'storage.setMetadata', expect: OK, run: () => note().setMetadata({ metadata: { capture: 'admin' } }) },
    { op: 'storage.download-missing', expect: '404', run: () => c.bucket.file(`${v.runPath}/missing.txt`).download() },
    { op: 'storage.delete', expect: OK, run: () => note().delete() },
  ];
}

export function runSpec(c: Clients, v: RunValues): Step[] {
  return [...authSteps(c, v), ...firestoreSteps(c, v), ...rtdbSteps(c, v), ...storageSteps(c, v)];
}

/**
 * Runs every step in order; each outcome is a result, never a throw. Stops
 * before the next step once `control` aborts. Each step's own promise is
 * tracked, so a step a timeout abandoned is still waited for before cleanup.
 * Returns each case that missed its answer.
 */
export async function drive(
  steps: readonly Step[],
  stamp: Stamp,
  settle: () => Promise<void>,
  control: RunControl,
): Promise<{ results: Record<string, string>; misses: string[] }> {
  const results: Record<string, string> = {};
  const misses: string[] = [];
  for (const step of steps) {
    if (control.signal.aborted) {
      misses.push(`stopped before ${step.op}: the run was aborted`);
      break;
    }
    stamp.op = step.op;
    stamp.paused = step.op === 'auth.clientSignIn';
    let outcome: string;
    try {
      const running = step.run();
      control.track(running);
      await withTimeout(step.op, running, STEP_TIMEOUT_MS);
      outcome = OK;
    } catch (error) {
      outcome = codeOf(error);
    }
    stamp.paused = false;
    await settle();
    results[step.op] = outcome;
    if (outcome !== step.expect) misses.push(`${step.op}: expected ${step.expect}, got ${outcome}`);
  }
  return { results, misses };
}

// ─── Production state for cleanup, through the script's own clients ──────

export function adminRunState(c: Clients): AdminRunState {
  return {
    users: {
      async find(email) {
        try {
          return (await c.auth.getUserByEmail(email)).uid;
        } catch (error) {
          if (codeOf(error) === 'auth/user-not-found') return null;
          throw error;
        }
      },
      remove: (uid) => c.auth.deleteUser(uid),
    },
    documents: {
      async list(runPath) {
        const paths: string[] = [];
        const walk = async (doc: DocumentReference): Promise<void> => {
          for (const collection of await doc.listCollections()) {
            for (const child of await collection.listDocuments()) {
              paths.push(child.path);
              await walk(child);
            }
          }
        };
        await walk(c.firestore.doc(runPath));
        return paths;
      },
      remove: async (path) => { await c.firestore.doc(path).delete(); },
    },
    rtdb: {
      read: async (path) => (await c.database.ref(path).get()).val() as unknown,
      remove: (path) => c.database.ref(path).remove(),
    },
    objects: {
      list: async (prefix) => (await c.bucket.getFiles({ prefix }))[0].map((file) => file.name),
      remove: async (name) => { await c.bucket.file(name).delete(); },
    },
  };
}

async function adminClients(ctx: LiveContext, databaseURL: string, bucket: string): Promise<Clients> {
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getDatabaseWithUrl } = await import('firebase-admin/database');
  const { getStorage } = await import('firebase-admin/storage');
  const app = initializeApp({ credential: ctx.serviceAccount.credential, projectId: ctx.projectId, databaseURL, storageBucket: bucket }, `capture-admin-${ctx.runId}`);
  return {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
    database: getDatabaseWithUrl(databaseURL, app),
    bucket: getStorage(app).bucket(bucket),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

const RECORDING_DESCRIPTION =
  'Every exchange firebase-admin made against production for the #2304 run spec: Auth user management and ID token checks, ' +
  'Firestore over gRPC, RTDB data messages, and the Storage JSON API. t is milliseconds since the capture started; op is the case running ' +
  'when the request was sent. Token exchanges, the gauth frame and its answer, and cert bodies are never recorded.';

function serviceAccountEmail(ctx: LiveContext): string {
  return ctx.serviceAccount.kind === 'key-file' ? ctx.serviceAccount.key.client_email : ctx.serviceAccount.client_email;
}

async function cleanupOnly(ctx: LiveContext, databaseURL: string, bucket: string, runId: string): Promise<never> {
  const clients = await adminClients(ctx, databaseURL, bucket);
  const { invariants } = await cleanupAdminRun('capture A (Admin) cleanup', adminRunState(clients), { runId });
  const { deleteApp } = await import('firebase-admin/app');
  await deleteApp(clients.app);
  console.log(`[capture-admin] cleanup of ${runId}: ${JSON.stringify(invariants)}`);
  if (!allHeld(invariants)) {
    console.error(`[capture-admin] cleanup did not read back clean; run it again: ${cleanupCommand(runId)}`);
    process.exit(3);
  }
  process.exit(0);
}

/** The run id once it is printed, so a throw after that still prints its cleanup command. */
let announcedRun: string | null = null;

async function main(): Promise<void> {
  const refusal = captureRefusal(process.env);
  if (refusal) {
    console.error(`[capture-admin] ${refusal}`);
    process.exit(2);
  }
  // Checked before any credential or client: a bad id must never reach the run root.
  const cleanupAt = process.argv.indexOf('--cleanup');
  const cleanupRun = cleanupAt === -1 ? null : (process.argv[cleanupAt + 1] ?? '');
  const runProblem = cleanupRun === null ? null : runIdProblem(cleanupRun);
  if (runProblem) {
    console.error(`[capture-admin] --cleanup: ${runProblem}. Nothing was touched.`);
    process.exit(2);
  }
  const instance = instanceFromEnv(process.env, DEFAULT_INSTANCE_VARIABLE, 'default');
  if (!process.env.PYRIC_ORACLE_PROJECT_ID || instance === null) {
    console.log(`[capture-admin] inert: set PYRIC_ORACLE_PROJECT_ID (Application Default Credentials) and ${DEFAULT_INSTANCE_VARIABLE} to capture.`);
    process.exit(0);
  }
  const ctx = await loadLiveContext();
  const bucket = ctx.webConfig.storageBucket;
  if (!bucket) throw new Error('the oracle web config has no storageBucket; Storage is not enabled on the project');
  if (cleanupRun !== null) await cleanupOnly(ctx, instance.url, bucket, cleanupRun);

  const redactor = redactorFor(ctx, [instance]);
  redactor.add(bucket, '<bucket>');
  redactor.add(serviceAccountEmail(ctx), '<service-account>');
  const values: RunValues = {
    ctx,
    runPath: runPathFor(ctx.runId),
    email: userEmailFor(ctx.runId),
    password: randomBytes(18).toString('base64url'),
    uid: '',
    idToken: '',
    closers: [],
    onSecret: (value, placeholder) => redactor.add(value, placeholder),
  };
  redactor.add(values.email, '<email>');
  redactor.add(values.password, '<password>');

  const stamp = newStamp();
  const placeholders = new Placeholders(redactor);
  const http = new HttpRecorder(stamp, placeholders);
  const grpc = new GrpcRecorder(stamp, placeholders);
  const rtdb = new RtdbRecorder(stamp);
  http.install();
  grpc.install(firestoreGrpcClient());
  const clients = await adminClients(ctx, instance.url, bucket);
  rtdb.install(persistentConnectionOf(clients.database));

  announceRunId(ctx.runId);
  announcedRun = ctx.runId;
  stamp.paused = true;
  const run = await runWithAdminCleanup('capture A (Admin)', adminRunState(clients), { runId: ctx.runId }, async (control) => {
    stamp.paused = false;
    const driven = await drive(runSpec(clients, values), stamp, () => http.settled(), control);
    stamp.paused = true;
    return driven;
  }, {
    quiesce: async () => {
      stamp.paused = true;
      for (const close of values.closers.splice(0)) close();
    },
    handleSignals: true,
  });
  const { deleteApp } = await import('firebase-admin/app');
  await deleteApp(clients.app);

  if (!allHeld(run.invariants)) {
    console.error(`[capture-admin] an invariant failed; nothing written. Clean the run up with: ${cleanupCommand(ctx.runId)}`);
    process.exit(3);
  }
  const failures = [...(run.error ? [run.error.message] : []), ...run.failures, ...(run.result?.misses ?? [])];
  if (failures.length > 0) {
    console.error(`[capture-admin] capture failed; nothing written:\n  ${failures.join('\n  ')}`);
    console.error(`[capture-admin] cleanup read back clean; to check again: ${cleanupCommand(ctx.runId)}`);
    process.exit(1);
  }

  // git keeps no empty directory, so the first recording creates its own.
  mkdirSync(dirname(OUT), { recursive: true });
  writeRecording(OUT, {
    name: 'admin-live-capture-admin-wire',
    description: RECORDING_DESCRIPTION,
    observedAt: new Date().toISOString(),
    adminVersion: resolvedAdminVersion(),
    runPath: `${RUN_ROOT}/<run>`,
    results: run.result?.results,
    invariants: run.invariants,
    grpc: grpc.exchanges,
    http: http.exchanges,
    rtdb: rtdb.messages,
  }, redactor);
  console.log(`[capture-admin] wrote ${OUT}: ${grpc.exchanges.length} gRPC, ${http.exchanges.length} HTTP, ${rtdb.messages.length} RTDB messages`);
  process.exit(0);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[capture-admin] ${error instanceof Error ? error.message : String(error)}`);
    if (announcedRun !== null) console.error(`[capture-admin] nothing written. Clean the run up with: ${cleanupCommand(announcedRun)}`);
    process.exit(1);
  }
}
