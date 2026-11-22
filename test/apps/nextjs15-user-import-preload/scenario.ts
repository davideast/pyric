/**
 * #1470: Next 15 (`parseNodeArgs` + `formatNodeOptions` in
 * `next/dist/server/lib/utils.js`) folds duplicate `--import <file>` flags in
 * `NODE_OPTIONS` into a single space-joined path and overwrites `--import=x`
 * with the last occurrence. When a developer already has `--import <file>` (or
 * `--import=<file>`) in `NODE_OPTIONS` and runs `pyric sandbox -- next dev`,
 * both `@pyric/cli/register` and the developer's preload must run in Next's
 * server child, swap `firebase-admin` inside the preload and route handler,
 * and serve the page in Chromium.
 *
 * `package.json` matches `nextjs-template` so the runner shares one Next 15.5.28
 * dependency-store entry.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scenario, type App } from '../driver.ts';
import {
  PROJECT_ID,
  escapedConnections,
  readSafetyLog,
  waitForNext,
} from '../nextjs-firebase-imports.ts';

const USER_IMPORT_PRELOAD = `import net from 'node:net';
import { appendFileSync } from 'node:fs';

const LOG = process.env.SCENARIO_SAFETY_LOG;
const SINK_PORT = Number(process.env.SCENARIO_SINK_PORT);
const registered = process.env.PYRIC_SANDBOX !== undefined;

function record(kind, detail) {
  if (!LOG) return;
  appendFileSync(LOG, JSON.stringify({ pid: process.pid, registered, kind, detail }) + '\\n');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isPort(value) {
  return typeof value === 'number' || (typeof value === 'string' && /^\\d+$/.test(value));
}

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

let adminSwapped = false;
if (registered) {
  const adminApp = await import('firebase-admin/app');
  adminSwapped = adminApp.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target');
}
const registerActive = globalThis[Symbol.for('pyric.register.active')] === true;
globalThis.__PYRIC_USER_IMPORT_PRELOAD__ = {
  ran: true,
  adminSwapped,
  registerActive,
};
if (!adminSwapped && registered) {
  record('real-firebase', 'firebase-admin/app in user --import preload');
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

const PRELOAD_ROUTE = `import * as adminApp from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { id, title } = await request.json();
  const app = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: '${PROJECT_ID}' });
  const ref = getFirestore(app).collection('items').doc(id);
  await ref.set({ title });
  const read = await ref.get();
  return Response.json({
    preload: globalThis.__PYRIC_USER_IMPORT_PRELOAD__ ?? null,
    routeSwapped: adminApp.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target'),
    title: read.get('title') ?? null,
  });
}
`;

const APP_FILES: Readonly<Record<string, string>> = {
  'next.config.mjs': NEXT_CONFIG,
  'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2),
  'firestore.rules': FIRESTORE_RULES,
  'src/app/layout.jsx': LAYOUT,
  'src/app/page.jsx': PAGE,
  'src/app/api/preload/route.js': PRELOAD_ROUTE,
};

async function listenSink(): Promise<Server> {
  const sink = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  return sink;
}

function writeAppAndPreload(app: App): { preloadUrl: string; emptyGcloud: string } {
  for (const [relPath, contents] of Object.entries(APP_FILES)) {
    mkdirSync(dirname(join(app.dir, relPath)), { recursive: true });
    app.writeFile(relPath, contents);
  }
  const workDir = dirname(app.dir);
  const preloadFile = join(workDir, 'user-import-preload.mjs');
  const emptyGcloud = join(workDir, 'empty-gcloud');
  mkdirSync(emptyGcloud, { recursive: true });
  app.writeFile(join('..', 'user-import-preload.mjs'), USER_IMPORT_PRELOAD);
  return { preloadUrl: pathToFileURL(preloadFile).href, emptyGcloud };
}

async function runImportPreloadCase(
  app: App,
  input: {
    readonly label: string;
    readonly slug: string;
    readonly nodeOptions: string;
    readonly sinkPort: number;
    readonly emptyGcloud: string;
  },
): Promise<void> {
  const sandboxPort = await app.freePort();
  const nextPort = await app.freePort();
  const nextUrl = `http://127.0.0.1:${nextPort}`;
  const safetyLog = join(dirname(app.dir), `safety-${input.slug}.log`);
  const env: Record<string, string> = {
    PATH: `${join(app.dir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
    NODE_OPTIONS: input.nodeOptions,
    SCENARIO_SINK_PORT: String(input.sinkPort),
    SCENARIO_SAFETY_LOG: safetyLog,
    CLOUDSDK_CONFIG: input.emptyGcloud,
    NEXT_TELEMETRY_DISABLED: '1',
  };

  const sandbox = await app.step(`${input.label}: Next 15 starts and serves the app`, async () => {
    const child = app.pyricProcess(
      [
        'sandbox',
        '--no-open',
        '--port',
        String(sandboxPort),
        '--',
        'next',
        'dev',
        '--port',
        String(nextPort),
        '--hostname',
        '127.0.0.1',
      ],
      { env },
    );
    await waitForNext(nextUrl, () => child.running);
    return child;
  });

  try {
    const page = await app.step(`${input.label}: Chromium connects to the sandbox`, async () => {
      const opened = await app.page(`${nextUrl}/`);
      await opened.waitForFunction(
        () => document.querySelector('#items-status')?.textContent === 'Listening',
        undefined,
        { timeout: 60_000 },
      );
      return opened;
    });

    try {
      const itemTitle = `loaded with ${input.slug}`;
      await app.step(
        `${input.label}: both preloads ran in Next's server child with firebase-admin swapped`,
        async () => {
          const res = await fetch(`${nextUrl}/api/preload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: input.slug, title: itemTitle }),
            signal: AbortSignal.timeout(120_000),
          });
          assert.equal(res.status, 200);
          const body = (await res.json()) as Record<string, unknown>;
          assert.deepEqual(body, {
            preload: { ran: true, adminSwapped: true, registerActive: true },
            routeSwapped: true,
            title: itemTitle,
          });
        },
      );

      await app.step(`${input.label}: the page renders the document written by the route`, async () => {
        await page.waitForFunction(
          (expected) => document.querySelector('#items')?.textContent?.includes(expected) === true,
          itemTitle,
          { timeout: 30_000 },
        );
      });

      await app.step(`${input.label}: no real Firebase SDK ran and nothing left loopback`, () => {
        const records = readSafetyLog(safetyLog);
        const realFirebase = records
          .filter((entry) => entry.kind === 'real-firebase')
          .map((entry) => entry.detail);
        assert.deepEqual(
          { realFirebase, connections: escapedConnections(records) },
          { realFirebase: [], connections: [] },
        );
      });
    } finally {
      await page.close();
    }
  } finally {
    await sandbox.stop();
  }
}

export default scenario(async (app) => {
  const { preloadUrl, emptyGcloud } = await app.step('write the Next 15 app and user --import preload', () =>
    writeAppAndPreload(app),
  );
  const sink = await listenSink();
  try {
    const sinkPort = (sink.address() as AddressInfo).port;
    await runImportPreloadCase(app, {
      label: 'NODE_OPTIONS="--import <file>"',
      slug: 'import-space',
      nodeOptions: `--import ${preloadUrl}`,
      sinkPort,
      emptyGcloud,
    });
    await runImportPreloadCase(app, {
      label: 'NODE_OPTIONS="--import=<file>"',
      slug: 'import-equals',
      nodeOptions: `--import=${preloadUrl}`,
      sinkPort,
      emptyGcloud,
    });
  } finally {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
});
