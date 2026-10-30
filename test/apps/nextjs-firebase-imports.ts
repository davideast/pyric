// The Next.js scenarios behind #1443, shared by `nextjs16-firebase-imports`
// and `nextjs15-firebase-imports`. A small App Router app under `withPyric`
// has a route handler that writes and reads a document through
// `firebase-admin`, a route handler that reads it through the client
// `firebase` SDK, and a client component that lists it in Chromium. Each case
// runs it under `pyric sandbox -- next dev` with one bundler.
//
// Next 16's Turbopack keeps server externals external but renames them
// (`firebase-admin-<16 hex>/app`). Before #1443 the register let the renamed
// import through, and the route ran the real `firebase-admin`.
//
// Nothing can leave the machine, before or after the fix. A preload, loaded
// through NODE_OPTIONS ahead of the register the launcher appends, sends every
// connection to a host other than loopback to a sink this scenario runs on
// 127.0.0.1, which closes it at once, and records it. In each registered
// process it also records any import that resolves into a real
// `firebase-admin` or `firebase` package. The app
// processes run with a fresh HOME, CLOUDSDK_CONFIG pointed at an empty folder,
// no GOOGLE_APPLICATION_CREDENTIALS, and a `demo-` project id.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { sleep, type App } from './driver.ts';
import { PROBE_ROUTE, runRefusals } from './nextjs-refuses-without-register.ts';

export interface FirebaseImportsCase {
  name: string;
  /** Extra `next dev` flags, such as `--webpack` or `--turbopack`. */
  nextFlags: readonly string[];
  hosted: boolean;
}

export const PROJECT_ID = 'demo-firebase-imports';

/**
 * Loaded with `--require`, which Node runs before the register's `--import`.
 * Not a second `--import`: Next 15 rewrites NODE_OPTIONS for its child and
 * folds two `--import` flags into one path that does not exist.
 */
const SAFETY_PRELOAD = `'use strict';
const net = require('node:net');
const { appendFileSync } = require('node:fs');

const LOG = process.env.SCENARIO_SAFETY_LOG;
const SINK_PORT = Number(process.env.SCENARIO_SINK_PORT);
const registered = process.env.PYRIC_SANDBOX !== undefined;
const record = (kind, detail) =>
  appendFileSync(LOG, JSON.stringify({ pid: process.pid, registered, kind, detail }) + '\\n');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const isPort = (value) => typeof value === 'number' || (typeof value === 'string' && /^\\d+$/.test(value));

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  const isIpc = typeof first === 'object' && first !== null && first.path !== undefined && first.port === undefined;
  if (typeof first === 'object' && first !== null && !isIpc) {
    const host = first.host ?? 'localhost';
    if (!LOOPBACK.has(host)) {
      record('connection', host + ':' + first.port);
      list[0] = { ...first, host: '127.0.0.1', port: SINK_PORT, lookup: undefined };
    }
  } else if (isPort(first)) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    if (!LOOPBACK.has(host)) {
      record('connection', host + ':' + first);
      list[0] = SINK_PORT;
      list[1] = '127.0.0.1';
    }
  }
  return connect.apply(this, args);
};

// Records the URL each import finally resolves to. Registered right after the
// register's own hook, so it runs first and its nextResolve returns the
// register's answer: a renamed import the register checks and then maps never
// shows here as the real package. A resolve hook, not a load hook: on Node
// 22.15 a load hook breaks require() of CommonJS inside Next.
const REAL_FIREBASE = /\\/node_modules\\/(firebase-admin|firebase)(-[0-9a-f]{16})?\\//;
const spy = {
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (REAL_FIREBASE.test(result.url)) record('real-firebase', result.url);
    return result;
  },
};
const moduleApi = require('node:module');
const registerHooks = moduleApi.registerHooks;
if (registered && typeof registerHooks === 'function') {
  moduleApi.registerHooks = function (hooks) {
    const handle = registerHooks.call(this, hooks);
    moduleApi.registerHooks = registerHooks;
    registerHooks.call(this, spy);
    return handle;
  };
}
`;

const NEXT_CONFIG = `import { fileURLToPath } from 'node:url';
import { withPyric } from '@pyric/cli/next';

export default withPyric({
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
});
`;

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{item} { allow read: if true; }
  }
}
`;

const CLIENT_CONFIG = `{ apiKey: 'demo-api-key', projectId: '${PROJECT_ID}' }`;

const LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const PAGE = `'use client';
import { useEffect, useState } from 'react';
import { getApps, initializeApp } from 'firebase/app';
import { collection, getFirestore, onSnapshot } from 'firebase/firestore';

export default function Page() {
  const [titles, setTitles] = useState(null);
  useEffect(() => {
    const app = getApps()[0] ?? initializeApp(${CLIENT_CONFIG});
    return onSnapshot(collection(getFirestore(app), 'items'), (snapshot) => {
      setTitles(snapshot.docs.map((doc) => doc.get('title')));
    });
  }, []);
  if (titles === null) return <p id="items-status">Loading</p>;
  return (
    <main>
      <p id="items-status">Listening</p>
      <ul id="items">{titles.map((title) => <li key={title}>{title}</li>)}</ul>
    </main>
  );
}
`;

/** Writes a document through `firebase-admin` and reads it back. */
const ADMIN_ROUTE = `import * as adminApp from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { title } = await request.json();
  try {
    const app = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: '${PROJECT_ID}' });
    const ref = getFirestore(app).collection('items').doc('from-admin');
    await ref.set({ title });
    const read = await ref.get();
    return Response.json({
      sandbox: adminApp.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target'),
      title: read.get('title'),
    });
  } catch (error) {
    return Response.json({ code: error?.code ?? null, message: String(error?.message ?? error) }, { status: 500 });
  }
}
`;

/** Reads the document through the client SDK, as server code may. */
const CLIENT_ROUTE = `import { getApps, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore } from 'firebase/firestore';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const app = getApps()[0] ?? initializeApp(${CLIENT_CONFIG});
    const snapshot = await getDoc(doc(getFirestore(app), 'items/from-admin'));
    return Response.json({ title: snapshot.get('title') ?? null });
  } catch (error) {
    return Response.json({ code: error?.code ?? null, message: String(error?.message ?? error) }, { status: 500 });
  }
}
`;

/**
 * Loads the real firebase-admin by absolute path, a load no import map can
 * recognize, then calls Firestore's REST endpoint as it would. `require` comes
 * from `process.getBuiltinModule` so neither bundler sees the load and Node
 * resolves it at run time, through the register's hook. The Firestore URL
 * comes from the environment: a route file that names a Firebase host makes
 * `pyric sandbox` refuse the directory as one that bundles the real SDK.
 */
const REAL_ADMIN_ROUTE = `export const dynamic = 'force-dynamic';

export async function GET() {
  const { createRequire } = process.getBuiltinModule('node:module');
  const { join } = process.getBuiltinModule('node:path');
  const load = createRequire(join(process.cwd(), 'package.json'));
  try {
    load(join(process.cwd(), 'node_modules', 'firebase-admin', 'lib', 'app', 'index.js'));
  } catch (error) {
    return Response.json({ load: error?.code ?? String(error) });
  }
  try {
    await fetch(process.env.SCENARIO_FIRESTORE_URL);
    return Response.json({ load: 'loaded', fetch: 'sent' });
  } catch (error) {
    return Response.json({ load: 'loaded', fetch: error?.cause?.code ?? error?.code ?? String(error) });
  }
}
`;

const APP_FILES: Record<string, string> = {
  'next.config.mjs': NEXT_CONFIG,
  'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2),
  'firestore.rules': FIRESTORE_RULES,
  'src/app/layout.jsx': LAYOUT,
  'src/app/page.jsx': PAGE,
  'src/app/api/admin/route.js': ADMIN_ROUTE,
  'src/app/api/client/route.js': CLIENT_ROUTE,
  'src/app/api/real-admin/route.js': REAL_ADMIN_ROUTE,
  'src/app/api/probe/route.js': PROBE_ROUTE,
};

/** The preload and the empty gcloud folder sit outside the project, so Next never watches them. */
export interface Safety {
  preload: string;
  sinkPort: number;
  emptyGcloud: string;
}

function writeApp(app: App): Omit<Safety, 'sinkPort'> {
  for (const [path, text] of Object.entries(APP_FILES)) {
    mkdirSync(dirname(join(app.dir, path)), { recursive: true });
    app.writeFile(path, text);
  }
  const work = dirname(app.dir);
  const preload = join(work, 'safety-preload.cjs');
  const emptyGcloud = join(work, 'empty-gcloud');
  mkdirSync(emptyGcloud, { recursive: true });
  app.writeFile(join('..', 'safety-preload.cjs'), SAFETY_PRELOAD);
  return { preload, emptyGcloud };
}

/**
 * `next dev` asks the npm registry for Next's latest version (its staleness
 * badge), with no setting to turn it off. The trap keeps it on this machine
 * too; it is the one connection a case may record.
 */
const NEXT_VERSION_CHECK = 'registry.npmjs.org:443';

interface SafetyRecord {
  pid: number;
  registered: boolean;
  kind: 'connection' | 'real-firebase';
  detail: string;
}

/** The trapped connections a case may not have. */
export function escapedConnections(records: readonly SafetyRecord[]): string[] {
  return records
    .filter((record) => record.kind === 'connection' && record.detail !== NEXT_VERSION_CHECK)
    .map((record) => record.detail);
}

export function readSafetyLog(path: string): SafetyRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
  return lines.map((line) => JSON.parse(line) as SafetyRecord);
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForNext(url: string, running: () => boolean): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    assert.ok(running(), `pyric sandbox exited before Next served ${url}`);
    if (await answers(`${url}/__pyric/init.json`) && await answers(`${url}/`)) return;
    assert.ok(Date.now() < deadline, `Next did not serve ${url}/ and ${url}/__pyric/init.json within 180s`);
    await sleep(500);
  }
}

async function jsonFrom(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { status: response.status, body: text.slice(0, 500) };
  }
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

/** The env each Next process runs with: the safety preload, the sink, and no credentials. */
export function nextEnv(app: App, safety: Safety): Record<string, string> {
  return {
    PATH: `${join(app.dir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
    NODE_OPTIONS: `--require ${safety.preload}`,
    SCENARIO_SINK_PORT: String(safety.sinkPort),
    CLOUDSDK_CONFIG: safety.emptyGcloud,
    NEXT_TELEMETRY_DISABLED: '1',
    SCENARIO_FIRESTORE_URL: `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/items/from-admin`,
  };
}

/** What the safety log recorded that a case may not have. */
function escapes(log: string): { realFirebase: string[]; connections: string[] } {
  const records = readSafetyLog(log);
  const realFirebase = records.filter((record) => record.kind === 'real-firebase').map((record) => record.detail);
  return { realFirebase, connections: escapedConnections(records) };
}

async function runCase(app: App, safety: Safety, testCase: FirebaseImportsCase): Promise<void> {
  const sandboxPort = await app.freePort();
  const nextPort = await app.freePort();
  const nextUrl = `http://127.0.0.1:${nextPort}`;
  const safetyLog = join(dirname(app.dir), `safety-${slug(testCase.name)}.log`);
  const sandboxArgs = ['sandbox', '--no-open', '--port', String(sandboxPort)];
  if (testCase.hosted) sandboxArgs.push('--hosted');
  const nextArgs = ['next', 'dev', ...testCase.nextFlags, '--port', String(nextPort), '--hostname', '127.0.0.1'];
  const env = { ...nextEnv(app, safety), SCENARIO_SAFETY_LOG: safetyLog };

  const sandbox = await app.step(`${testCase.name}: Next serves the app`, async () => {
    const child = app.pyricProcess([...sandboxArgs, '--', ...nextArgs], { env });
    await waitForNext(nextUrl, () => child.running);
    return child;
  });

  const page = await app.step(`${testCase.name}: the page listens to the sandbox`, async () => {
    const opened = await app.page(`${nextUrl}/`);
    await opened.waitForFunction(
      () => document.querySelector('#items-status')?.textContent === 'Listening',
      undefined,
      { timeout: 60_000 },
    );
    return opened;
  });

  const title = `written under ${testCase.name}`;
  await app.step(`${testCase.name}: the firebase-admin route writes and reads the sandbox`, async () => {
    const response = await fetch(`${nextUrl}/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await jsonFrom(response);
    const loaded = readSafetyLog(safetyLog).map((record) => `${record.kind} ${record.detail}`);
    assert.deepEqual(body, { sandbox: true, title }, `the route answered ${JSON.stringify(body)}; safety log:\n${loaded.join('\n')}`);
  });

  await app.step(`${testCase.name}: the page lists the document firebase-admin wrote`, async () => {
    await page.waitForFunction(
      (expected) => document.querySelector('#items')?.textContent?.includes(expected) === true,
      title,
      { timeout: 30_000 },
    );
  });

  await app.step(`${testCase.name}: the client SDK route answers as get-started/nextjs.md says`, async () => {
    const response = await fetch(`${nextUrl}/api/client`, { signal: AbortSignal.timeout(120_000) });
    const body = await jsonFrom(response);
    if (testCase.hosted) {
      assert.deepEqual(body, { title });
      return;
    }
    assert.equal(body.code, 'failed-precondition', JSON.stringify(body));
  });

  await app.step(`${testCase.name}: no real Firebase SDK loaded and nothing left the machine`, async () => {
    const records = readSafetyLog(safetyLog);
    const realFirebase = records.filter((record) => record.kind === 'real-firebase').map((record) => record.detail);
    const connections = escapedConnections(records);
    assert.deepEqual({ realFirebase, connections }, { realFirebase: [], connections: [] });
  });

  // ADR 0022: a load the register can't map stops before the real firebase-admin runs.
  await app.step(`${testCase.name}: the real firebase-admin stops at load, and nothing runs or leaves`, async () => {
    const response = await fetch(`${nextUrl}/api/real-admin`, { signal: AbortSignal.timeout(120_000) });
    const body = await jsonFrom(response);
    const records = readSafetyLog(safetyLog);
    const realFirebase = records.filter((record) => record.kind === 'real-firebase').map((record) => record.detail);
    const connections = escapedConnections(records);
    assert.deepEqual(
      { body, realFirebase, connections },
      { body: { load: 'PYRIC_REAL_SDK_STOPPED' }, realFirebase: [], connections: [] },
    );
    // The stop reaches stderr through Next and the launcher, so it can land
    // just after the response does.
    await sandbox.waitForLog(/code: PYRIC_REAL_SDK_STOPPED/, { timeoutMs: 10_000 });
    assert.match(sandbox.output, /stopped loading the real firebase-admin/);
    assert.match(sandbox.output, /found {2}file:\/\/\S+\/firebase-admin\/lib\/app\/index\.js/);
    await page.close();
    await sandbox.stop();
  });
}

/** Accepts each trapped connection and closes it at once. */
async function listenSink(): Promise<Server> {
  const sink = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  return sink;
}

/** A case with its own steps, run after the Firestore cases on the same app and safety preload. */
export type ExtraCase = (app: App, safety: Safety) => Promise<void>;

/**
 * Writes the app, then runs each case in turn. With `refusals`, it then runs
 * the cases where `withPyric` has to refuse to start (#1625), and then each
 * of `extraCases`.
 */
export async function runFirebaseImports(
  app: App,
  cases: readonly FirebaseImportsCase[],
  options: { refusals?: boolean; extraCases?: readonly ExtraCase[] } = {},
): Promise<void> {
  // The rewrite keeps the Next origin, which the host's origin guard refuses (#1194).
  app.expectHostError(/^403 POST \/__pyric\/diagnostics$/);
  const files = await app.step('write the Next app and the safety preload', () => writeApp(app));
  const sink = await listenSink();
  try {
    const safety = { ...files, sinkPort: (sink.address() as AddressInfo).port };
    for (const testCase of cases) await runCase(app, safety, testCase);
    if (options.refusals === true) await runRefusals(app, { env: nextEnv(app, safety), escapes });
    for (const extraCase of options.extraCases ?? []) await extraCase(app, safety);
  } finally {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
}
