#!/usr/bin/env bun
/**
 * Capture B (issue #2114, step 6): what production bills as bytes down and up
 * for each RTDB operation an app makes, read from `firebase database:profile`
 * on the default instance while this script runs a fixed sequence, to
 * calibrate live mode's RTDB download estimate.
 *
 * Operations: a 10 KB initial onValue, a 100 B child update with that
 * listener attached, get with and without an active listener, push, a
 * transaction two clients contend on, and onDisconnect. Each one is followed
 * by a pause, and each profile event is attributed to the operation whose path
 * it touched and whose time window holds it. The client's own wire bytes per
 * operation, from the same recording WebSocket as capture A, sit beside the
 * profiler's numbers.
 *
 * Safety: writes only under /pyric-live-capture/<run id> (about 11 KB). It
 * snapshots the instance rules, adds the run path to them, and afterwards
 * removes the run path and restores the exact prior rules text, reading both
 * back; the recording is written only when both hold and the profiler saw the
 * start marker. Both anonymous users are deleted.
 *
 * Inert unless PYRIC_STAGING_RTDB names the default instance. Data and rules
 * calls use the oracle credential (PYRIC_ORACLE_PROJECT_ID with Application
 * Default Credentials); the profiler runs as the Firebase CLI login.
 *
 *   PYRIC_ORACLE_PROJECT_ID=<oracle project> \
 *   PYRIC_STAGING_RTDB=https://<default instance>.firebaseio.com \
 *     bun run packages/conformance/src/capture/rtdb-live/capture-b-bandwidth.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously, type Auth } from 'firebase/auth';
import type { Database } from 'firebase/database';
import { resolvedFirebaseVersion } from '../../package-version.ts';
import {
  adminRest,
  DEFAULT_INSTANCE_VARIABLE,
  importRecordedDatabase,
  instanceFromEnv,
  loadLiveContext,
  pause,
  redactorFor,
  withCaptureRules,
  withTimeout,
  WireRecorder,
  writeRecording,
} from './live-capture.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'recordings', 'capture-b-bandwidth.json');
const FIREBASE_BIN = process.env.FIREBASE_BIN ?? 'firebase';
/** Profiler run time; the sequence must finish well inside it. */
const PROFILE_SECONDS = 75;
/** Time for the CLI to start and open the profile stream before the first operation. */
const PROFILE_WARMUP_MS = 10_000;
/** Gap after each operation so its events and the next operation's do not overlap. */
const GAP_MS = 2_500;

const instance = instanceFromEnv(process.env, DEFAULT_INSTANCE_VARIABLE, 'default');
if (!instance) {
  console.log(`[rtdb-live:capture-b] inert: set ${DEFAULT_INSTANCE_VARIABLE} to the default instance URL to capture.`);
  process.exit(0);
}

const ctx = await loadLiveContext();
const recorder = new WireRecorder();
const rtdb = await importRecordedDatabase(recorder);
const redactor = redactorFor(ctx, [instance]);
const rest = adminRest(instance, ctx);
const epochStart = Date.now() - recorder.now();

interface OperationWindow {
  op: string;
  description: string;
  /** Paths below the run path whose profile events belong to this operation. */
  paths: string[];
  startMs: number;
  endMs: number;
  detail?: unknown;
}

const windows: OperationWindow[] = [];

async function operation(op: string, description: string, paths: string[], run: () => Promise<unknown>): Promise<void> {
  recorder.op = op;
  const startMs = recorder.now();
  const detail = await withTimeout(op, run());
  const endMs = recorder.now();
  windows.push({ op, description, paths, startMs, endMs, ...(detail === undefined ? {} : { detail }) });
  await pause(GAP_MS);
  recorder.op = 'between';
}

interface Client {
  app: FirebaseApp;
  auth: Auth;
  db: Database;
}

async function signedInClient(index: number): Promise<Client> {
  const app = initializeApp(ctx.webConfig, `rtdb-live-b-${ctx.runId}-${index}`);
  const auth = getAuth(app);
  await signInAnonymously(auth);
  const user = auth.currentUser!;
  redactor.add(user.uid, `<uid-${index}>`);
  redactor.add(await user.getIdToken(), '<id-token>');
  redactor.add(user.refreshToken, '<refresh-token>');
  return { app, auth, db: rtdb.getDatabase(app, instance!.url) };
}

type ProfilerOutcome = { code: number | null } | { error: Error };

interface Profiler {
  /** Settles once with the exit code or the spawn error; never rejects. */
  outcome: Promise<ProfilerOutcome>;
  /** Kill the child when it is still running. */
  stop(): void;
}

function startProfiler(file: string): Profiler {
  const child = spawn(FIREBASE_BIN, [
    'database:profile', '--project', ctx.projectId, '--instance', instance!.name,
    '--raw', '--output', file, '--duration', String(PROFILE_SECONDS),
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const outcome = new Promise<ProfilerOutcome>((resolve) => {
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (code) => resolve({ code }));
  });
  return {
    outcome,
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}

const KILOBYTE_CHILD = 'k'.repeat(1_000);
const BIG = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, KILOBYTE_CHILD]));

async function sequence(one: Client, two: Client): Promise<void> {
  const at = (client: Client, path: string) => rtdb.ref(client.db, `${ctx.runPath}/${path}`);
  await operation('marker', 'Admin REST write the profiler must show, to prove the stream was open and to measure clock offset.', ['marker'], async () => {
    const r = await rest.request('PUT', `${ctx.runPath}/marker`, '"m"', '?print=silent');
    if (r.status !== 204 && r.status !== 200) throw new Error(`marker write failed: ${r.status}`);
  });
  await operation('seed-10kb', 'Admin REST write of 10 children of 1,000 characters each.', ['big'], async () => {
    const r = await rest.request('PUT', `${ctx.runPath}/big`, JSON.stringify(BIG), '?print=silent');
    if (r.status !== 204 && r.status !== 200) throw new Error(`seed write failed: ${r.status}`);
  });
  for (const client of [one, two]) {
    recorder.op = 'connect';
    const connected = new Promise<void>((resolve) => {
      const stop = rtdb.onValue(rtdb.ref(client.db, '.info/connected'), (s) => { if (s.val() === true) { stop(); resolve(); } });
    });
    await withTimeout('connect', connected);
  }
  await pause(GAP_MS);

  let events = 0;
  let latest: Record<string, string> = {};
  let stopListener = () => {};
  await operation('onValue-initial-10kb', 'onValue on the 10 KB node: the initial snapshot.', ['big'], async () => {
    stopListener = rtdb.onValue(at(one, 'big'), (snapshot) => { events++; latest = snapshot.val() as Record<string, string>; });
    while (events === 0) await pause(25);
    return { children: Object.keys(latest).length };
  });
  await operation('child-update-100b-with-listener', 'set of a 100-character child under the listened node.', ['big'], async () => {
    const before = events;
    await rtdb.set(at(one, 'big/c100'), 'u'.repeat(100));
    while (events === before) await pause(25);
    return { listenerEvents: events - before };
  });
  await operation('get-with-listener', 'get of the listened node while the onValue listener is attached.', ['big'], async () => {
    const snapshot = await rtdb.get(at(one, 'big'));
    return { children: Object.keys(snapshot.val() as object).length };
  });
  await operation('unlisten', 'Detach the onValue listener.', ['big'], async () => { stopListener(); });
  await operation('get-without-listener', 'get of the same node with no listener attached.', ['big'], async () => {
    const snapshot = await rtdb.get(at(one, 'big'));
    return { children: Object.keys(snapshot.val() as object).length };
  });
  await operation('push', 'push of a 100-character value.', ['list'], async () => {
    await rtdb.push(at(one, 'list'), 'p'.repeat(100));
  });
  await operation('transaction-contended', 'runTransaction on one counter from two clients at once.', ['counter'], async () => {
    const calls = [0, 0];
    const increment = (index: number) => (current: number | null) => { calls[index]!++; return (current ?? 0) + 1; };
    const outcomes = await Promise.all([
      rtdb.runTransaction(at(one, 'counter'), increment(0)),
      rtdb.runTransaction(at(two, 'counter'), increment(1)),
    ]);
    return {
      updateFunctionCalls: calls,
      committed: outcomes.map((o) => o.committed),
      final: (await rtdb.get(at(one, 'counter'))).val(),
    };
  });
  await operation('onDisconnect', 'set, onDisconnect().set, close the connection, then an admin read until the server ran the queued write.', ['presence'], async () => {
    await rtdb.set(at(one, 'presence'), 'online');
    await rtdb.onDisconnect(at(one, 'presence')).set('offline');
    rtdb.goOffline(one.db);
    for (let attempt = 0; attempt < 40; attempt++) {
      const r = await rest.request('GET', `${ctx.runPath}/presence`);
      if (r.text === '"offline"') return { readBack: 'offline' };
      await pause(250);
    }
    throw new Error('the onDisconnect write never landed');
  });
  rtdb.goOffline(two.db);
}

interface ProfileEvent {
  name: string;
  path?: string[] | string;
  bytes?: number;
  millis?: number;
  timestamp: number;
  [key: string]: unknown;
}

const DOWN = new Set(['realtime-read', 'listener-listen', 'listener-broadcast', 'rest-read']);
const UP = new Set(['realtime-write', 'realtime-transaction', 'realtime-update', 'rest-write', 'rest-update']);

function segments(event: ProfileEvent): string[] {
  if (Array.isArray(event.path)) return event.path;
  return (event.path ?? '').split('/').filter(Boolean);
}

function attribute(events: ProfileEvent[], offsetMs: number) {
  const runPrefix = ctx.runPath.split('/');
  const below = (event: ProfileEvent): string | null => {
    const path = segments(event);
    if (runPrefix.some((segment, i) => path[i] !== segment)) return null;
    return path.slice(runPrefix.length).join('/');
  };
  const operations = windows.map((w) => ({ ...w, events: [] as Array<Record<string, unknown>>, bytesDown: 0, bytesUp: 0 }));
  const unattributed: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const t = Math.round(event.timestamp - epochStart - offsetMs);
    const summary = {
      name: event.name,
      path: `/${segments(event).join('/')}`,
      bytes: event.bytes ?? null,
      millis: event.millis ?? null,
      t,
      otherFields: Object.keys(event).filter((k) => !['name', 'path', 'bytes', 'millis', 'timestamp'].includes(k)).sort(),
    };
    const sub = below(event);
    const candidates = sub === null ? [] : operations.filter((o) => o.paths.some((p) => sub === p || sub.startsWith(`${p}/`)));
    const distance = (o: OperationWindow) => (t < o.startMs ? o.startMs - t : t > o.endMs ? t - o.endMs : 0);
    const owner = candidates.sort((a, b) => distance(a) - distance(b))[0];
    if (!owner || distance(owner) > GAP_MS) {
      unattributed.push(summary);
      continue;
    }
    owner.events.push(summary);
    if (DOWN.has(event.name)) owner.bytesDown += event.bytes ?? 0;
    if (UP.has(event.name)) owner.bytesUp += event.bytes ?? 0;
  }
  return {
    operations: operations.map(({ paths, events: evs, ...rest }) => ({
      ...rest,
      paths: paths.map((p) => `/${ctx.runPath}/${p}`),
      events: evs,
      wire: recorder.bytes(rest.op),
    })),
    unattributed,
  };
}

const profileDir = mkdtempSync(join(tmpdir(), 'rtdb-live-profile-'));
const profileFile = join(profileDir, 'profile.ndjson');
const toolsVersion = spawnSync(FIREBASE_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim();
const one = await signedInClient(1);
const two = await signedInClient(2);

let profiler: Profiler | undefined;

/**
 * Stop the profiler and close and delete both clients before cleanup, so no
 * queued onDisconnect or in-flight write lands after the run path is removed.
 * Every step runs; the failures are rethrown together at the end.
 */
async function shutdown(): Promise<void> {
  const errors: string[] = [];
  profiler?.stop();
  for (const client of [one, two]) {
    try {
      rtdb.goOffline(client.db);
    } catch (e) {
      errors.push(`goOffline: ${String(e)}`);
    }
  }
  for (const client of [one, two]) {
    if (client.auth.currentUser) await deleteUser(client.auth.currentUser).catch((e) => errors.push(`delete user: ${String(e)}`));
    await deleteApp(client.app).catch((e) => errors.push(`delete app: ${String(e)}`));
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

const run = await withCaptureRules(instance, ctx, async () => {
  profiler = startProfiler(profileFile);
  try {
    await pause(PROFILE_WARMUP_MS);
    await sequence(one, two);
    if (recorder.now() > PROFILE_WARMUP_MS + (PROFILE_SECONDS - 10) * 1_000) throw new Error('the sequence ran too close to the end of the profile');
    const outcome = await withTimeout('profiler exit', profiler.outcome, (PROFILE_SECONDS + 60) * 1_000);
    if ('error' in outcome) throw new Error(`firebase database:profile did not start: ${outcome.error.message}`);
    if (outcome.code !== 0) throw new Error(`firebase database:profile exited ${outcome.code}`);
  } catch (e) {
    profiler.stop();
    throw e;
  }
}, { shutdown, settleMs: 2_000, handleSignals: true });
if (!run.invariants.dataRemoved || !run.invariants.rulesRestored) {
  console.error('[rtdb-live:capture-b] an invariant failed; nothing written. Read the rules and run path back by hand.');
  process.exit(3);
}
if (run.error) {
  console.error(`[rtdb-live:capture-b] capture failed; nothing written: ${run.error.message}`);
  process.exit(1);
}

const events = readFileSync(profileFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ProfileEvent);
const marker = events.find((e) => segments(e).join('/') === `${ctx.runPath}/marker`);
const markerWindow = windows.find((w) => w.op === 'marker')!;
if (!marker) {
  console.error(`[rtdb-live:capture-b] the profiler did not record the start marker (${events.length} events); nothing written.`);
  process.exit(1);
}
const offsetMs = Math.round(marker.timestamp - epochStart - (markerWindow.startMs + markerWindow.endMs) / 2);
const { operations, unattributed } = attribute(events, offsetMs);

writeRecording(OUT, {
  name: 'rtdb-live-capture-b-bandwidth',
  description: 'Per-operation bytes from firebase database:profile on the default instance. bytesDown sums realtime-read, listener-listen, listener-broadcast and rest-read events; bytesUp sums realtime-write, realtime-transaction, realtime-update, rest-write and rest-update events. wire is the client\'s own WebSocket frame bytes for the same operation. t, startMs and endMs are milliseconds since the capture started, profile timestamps corrected by clockOffsetMs (measured on the marker write).',
  observedAt: new Date().toISOString(),
  sdkVersion: resolvedFirebaseVersion(),
  firebaseToolsVersion: toolsVersion,
  instance: instance.placeholder,
  runPath: `/${ctx.runPath}`,
  clockOffsetMs: offsetMs,
  profileEventCount: events.length,
  operations,
  unattributed,
  invariants: { ...run.invariants, markerSeen: true },
}, redactor);
console.log(`[rtdb-live:capture-b] ${events.length} profile events, ${unattributed.length} unattributed; wrote ${OUT}`);
for (const o of operations) console.log(`  ${o.op.padEnd(34)} down ${String(o.bytesDown).padStart(6)}  up ${String(o.bytesUp).padStart(6)}  wire ${o.wire.received}/${o.wire.sent}`);
process.exit(0);
