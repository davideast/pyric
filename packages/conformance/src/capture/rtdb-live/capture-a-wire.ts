#!/usr/bin/env bun
/**
 * Capture A (issue #2114, step 2): every WebSocket frame the modular
 * `firebase/database` client sends and receives for a fixed sequence of
 * operations, on the default instance and on one named instance, for the
 * live-mode RTDB replay server.
 *
 * Operations, per instance: connect, set, get, update, push, runTransaction
 * (uncontended), onValue (with a change from a second client), onChildAdded
 * (with a push from a second client), a read and a write of the denied path
 * /secret, and onDisconnect (set, then close the connection, then read the
 * value back from a second client).
 *
 * The frames come from wrapping faye-websocket's `Client`, the constructor the
 * SDK's Node build opens its socket with; the SDK itself is not touched. Each
 * frame carries its offset in milliseconds and the operation it belongs to.
 * Tokens, the API key, app id, uids, session ids, the project id, the instance
 * names and the run id are replaced with fixed placeholders, and the file is
 * written only when no token-shaped string remains.
 *
 * Safety: writes only under /pyric-live-capture/<run id>. Per instance it
 * snapshots the rules, adds the run path and a denied /secret to them, and
 * afterwards removes the run path and restores the exact prior rules text,
 * reading both back; the recording is written only when both hold. Both
 * anonymous users are deleted.
 *
 * Inert unless PYRIC_STAGING_RTDB and PYRIC_STAGING_RTDB_NAMED name the
 * default and the named instance. The credential is the oracle credential
 * (PYRIC_ORACLE_PROJECT_ID with Application Default Credentials).
 *
 *   PYRIC_ORACLE_PROJECT_ID=<oracle project> \
 *   PYRIC_STAGING_RTDB=https://<default instance>.firebaseio.com \
 *   PYRIC_STAGING_RTDB_NAMED=https://<named instance>.firebaseio.com \
 *     bun run packages/conformance/src/capture/rtdb-live/capture-a-wire.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously, type Auth } from 'firebase/auth';
import type { Database, DataSnapshot } from 'firebase/database';
import { resolvedFirebaseVersion } from '../../package-version.ts';
import {
  DEFAULT_INSTANCE_VARIABLE,
  DENIED_PATH,
  importRecordedDatabase,
  NAMED_INSTANCE_VARIABLE,
  instanceFromEnv,
  loadLiveContext,
  pause,
  redactorFor,
  withCaptureRules,
  withTimeout,
  WireRecorder,
  writeRecording,
  type LiveInstance,
  type RunInvariants,
} from './live-capture.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'recordings', 'capture-a-wire.json');
const OPERATIONS = [
  'connect', 'set', 'get', 'update', 'push', 'runTransaction', 'onValue', 'onChildAdded',
  'denied-read', 'denied-write', 'onDisconnect', 'teardown',
] as const;
type Operation = (typeof OPERATIONS)[number];
/** Time after an operation settles for its trailing frames (acks, events) to arrive under its label. */
const SETTLE_MS = 750;

const defaultInstance = instanceFromEnv(process.env, DEFAULT_INSTANCE_VARIABLE, 'default');
const namedInstance = instanceFromEnv(process.env, NAMED_INSTANCE_VARIABLE, 'named');
if (!defaultInstance || !namedInstance) {
  console.log(`[rtdb-live:capture-a] inert: set ${DEFAULT_INSTANCE_VARIABLE} and ${NAMED_INSTANCE_VARIABLE} to the default and a named instance URL to capture.`);
  process.exit(0);
}
const instances = [defaultInstance, namedInstance];

const ctx = await loadLiveContext();
const recorder = new WireRecorder();
const rtdb = await importRecordedDatabase(recorder);
const redactor = redactorFor(ctx, instances);

interface Client {
  app: FirebaseApp;
  auth: Auth;
  name: string;
}

async function signedInClient(name: string, index: number): Promise<Client> {
  const app = initializeApp(ctx.webConfig, `rtdb-live-a-${ctx.runId}-${name}`);
  const auth = getAuth(app);
  await signInAnonymously(auth);
  const user = auth.currentUser!;
  redactor.add(user.uid, `<uid-${index}>`);
  redactor.add(await user.getIdToken(), '<id-token>');
  redactor.add(user.refreshToken, '<refresh-token>');
  return { app, auth, name };
}

async function step<T>(op: Operation, client: Client, run: () => Promise<T>): Promise<T> {
  recorder.op = op;
  recorder.client = client.name;
  const value = await withTimeout(op, run());
  await pause(SETTLE_MS);
  return value;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.split(':')[0]!.trim() : String(error);
}

async function denied(task: () => Promise<unknown>): Promise<{ denied: boolean; message: string }> {
  try {
    await task();
    return { denied: false, message: 'allowed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { denied: /permission/i.test(message), message: errorCode(error) };
  }
}

function nextValue(db: Database, path: string, predicate: (snapshot: DataSnapshot) => boolean): {
  ready: Promise<void>;
  stop: () => void;
} {
  let stop = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    stop = rtdb.onValue(rtdb.ref(db, path), (snapshot) => { if (predicate(snapshot)) resolve(); }, reject);
  });
  return { ready, stop };
}

/** The operation sequence against one instance, with client 1 driving and client 2 as the other party. */
async function driveInstance(instance: LiveInstance, one: Client, two: Client): Promise<Record<string, unknown>> {
  const db1 = rtdb.getDatabase(one.app, instance.url);
  const db2 = rtdb.getDatabase(two.app, instance.url);
  const at = (db: Database, path: string) => rtdb.ref(db, `${ctx.runPath}/${path}`);
  const results: Record<string, unknown> = {};

  await step('connect', one, async () => {
    const connected = nextValue(db1, '.info/connected', (s) => s.val() === true);
    await connected.ready;
    connected.stop();
  });
  await step('connect', two, async () => {
    const connected = nextValue(db2, '.info/connected', (s) => s.val() === true);
    await connected.ready;
    connected.stop();
  });
  await step('set', one, () => rtdb.set(at(db1, 'items/a'), { n: 1, s: 'alpha' }));
  results.get = await step('get', one, async () => (await rtdb.get(at(db1, 'items/a'))).val());
  await step('update', one, () => rtdb.update(at(db1, 'items/a'), { n: 2, flag: true }));
  results.push = await step('push', one, async () => (await rtdb.push(at(db1, 'list'), { v: 1 })).key !== null);
  results.runTransaction = await step('runTransaction', one, async () => {
    const outcome = await rtdb.runTransaction(at(db1, 'counter'), (current: number | null) => (current ?? 0) + 1);
    return { committed: outcome.committed, value: outcome.snapshot.val() };
  });

  results.onValue = await step('onValue', one, async () => {
    const values: unknown[] = [];
    let changed: () => void = () => {};
    const sawChange = new Promise<void>((resolve) => { changed = resolve; });
    const stop = rtdb.onValue(at(db1, 'items/a'), (snapshot) => {
      values.push(snapshot.val());
      if (values.length === 2) changed();
    });
    await withTimeout('onValue first event', (async () => { while (values.length === 0) await pause(50); })());
    recorder.client = two.name;
    await rtdb.set(at(db2, 'items/a/n'), 3);
    await withTimeout('onValue change', sawChange);
    recorder.client = one.name;
    stop();
    return values;
  });

  results.onChildAdded = await step('onChildAdded', one, async () => {
    const keys: string[] = [];
    const stop = rtdb.onChildAdded(at(db1, 'list'), (snapshot) => { keys.push(snapshot.key!); });
    await withTimeout('onChildAdded existing child', (async () => { while (keys.length === 0) await pause(50); })());
    recorder.client = two.name;
    await rtdb.push(at(db2, 'list'), { v: 2 });
    await withTimeout('onChildAdded new child', (async () => { while (keys.length < 2) await pause(50); })());
    recorder.client = one.name;
    stop();
    return { children: keys.length };
  });

  results['denied-read'] = await step('denied-read', one, () => denied(() => rtdb.get(rtdb.ref(db1, DENIED_PATH))));
  results['denied-write'] = await step('denied-write', one, () => denied(() => rtdb.set(rtdb.ref(db1, DENIED_PATH), 'x')));

  await step('onDisconnect', one, async () => {
    await rtdb.set(at(db1, 'presence'), 'online');
    await rtdb.onDisconnect(at(db1, 'presence')).set('offline');
    rtdb.goOffline(db1);
  });
  results.onDisconnect = await step('onDisconnect', two, async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = (await rtdb.get(at(db2, 'presence'))).val();
      if (value === 'offline') return { readBack: value };
      await pause(250);
    }
    return { readBack: (await rtdb.get(at(db2, 'presence'))).val() };
  });
  await step('teardown', two, async () => rtdb.goOffline(db2));
  return results;
}

/** Time after the clients close for the server to run any onDisconnect write still queued. */
const SHUTDOWN_SETTLE_MS = 2_000;
const failures: string[] = [];

/**
 * Close every connection and delete each client before cleanup, so nothing a
 * client queued (an onDisconnect write, an unacknowledged set) lands after the
 * run path is removed. Every step runs; the first failure is rethrown at the end.
 */
async function shutdownClients(instance: LiveInstance, clients: Client[]): Promise<void> {
  const errors: string[] = [];
  for (const client of clients) {
    try {
      rtdb.goOffline(rtdb.getDatabase(client.app, instance.url));
    } catch (e) {
      errors.push(`goOffline: ${String(e)}`);
    }
  }
  for (const client of clients) {
    if (client.auth.currentUser) await deleteUser(client.auth.currentUser).catch((e) => errors.push(`delete user: ${String(e)}`));
    await deleteApp(client.app).catch((e) => errors.push(`delete app: ${String(e)}`));
  }
  failures.push(...errors);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

const recordingsByInstance: Record<string, unknown> = {};
let allHeld = true;

for (const [index, instance] of instances.entries()) {
  console.log(`[rtdb-live:capture-a] ${instance.label} instance: deploying capture rules`);
  const one = await signedInClient(`client-1-${instance.label}`, index * 2 + 1);
  const two = await signedInClient(`client-2-${instance.label}`, index * 2 + 2);
  const firstConnection = recorder.connections.length;
  const firstFrame = recorder.frames.length;
  const run = await withCaptureRules(instance, ctx, () => driveInstance(instance, one, two), {
    shutdown: () => shutdownClients(instance, [one, two]),
    settleMs: SHUTDOWN_SETTLE_MS,
    handleSignals: true,
  });
  if (run.error) failures.push(`${instance.label}: ${run.error.message}`);
  allHeld &&= run.invariants.dataRemoved && run.invariants.rulesRestored;
  if (!allHeld) break;
  const connections = recorder.connections.slice(firstConnection).map((c) => ({ ...c, client: c.client.replace(`-${instance.label}`, '') }));
  const frames = recorder.frames.slice(firstFrame).map((f) => ({ ...f, client: f.client.replace(`-${instance.label}`, '') }));
  recordingsByInstance[instance.label] = {
    instance: instance.placeholder,
    connections,
    frames,
    results: run.result ?? {},
    invariants: run.invariants satisfies RunInvariants,
  };
  console.log(`[rtdb-live:capture-a] ${instance.label}: ${frames.length} frames over ${connections.length} connections, invariants ${JSON.stringify(run.invariants)}`);
}

for (const [label, value] of Object.entries(recordingsByInstance)) {
  const results = (value as { results: Record<string, { denied?: boolean } | undefined> }).results;
  for (const op of ['denied-read', 'denied-write']) {
    if (results[op]?.denied !== true) failures.push(`${label}: ${op} was not denied`);
  }
  if (JSON.stringify(results.onDisconnect) !== JSON.stringify({ readBack: 'offline' })) failures.push(`${label}: onDisconnect did not read back offline`);
}

if (!allHeld) {
  console.error('[rtdb-live:capture-a] an invariant failed; nothing written. Read the rules and run path back by hand.');
  process.exit(3);
}
if (failures.length > 0) {
  console.error(`[rtdb-live:capture-a] capture failed; nothing written:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

writeRecording(OUT, {
  name: 'rtdb-live-capture-a-wire',
  description: 'Every WebSocket frame the modular firebase/database client sent and received, per instance, for connect, set, get, update, push, an uncontended runTransaction, onValue and onChildAdded with a change from a second client, a denied read and write of /secret, and onDisconnect read back from a second client. t is milliseconds since the capture started; op is the operation running when the frame was sent or received.',
  observedAt: new Date().toISOString(),
  sdkVersion: resolvedFirebaseVersion(),
  runPath: `/${ctx.runPath}`,
  operations: OPERATIONS,
  placeholders: ['<project>', '<default-instance>', '<named-instance>', '<run>', '<uid-N>', '<id-token>', '<refresh-token>', '<api-key>', '<app-id>', '<session>'],
  instances: recordingsByInstance,
} satisfies Record<string, unknown> & { instances: Record<string, unknown> }, redactor);
console.log(`[rtdb-live:capture-a] wrote ${OUT}`);
process.exit(0);

