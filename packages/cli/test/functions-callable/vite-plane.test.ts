/**
 * The Vite plane of `functions-callable`: a real Vite dev server with
 * `pyric()` serves the unchanged capture fixture (`firebase.json`,
 * `fixture/index.cjs`, `public/`) through its middleware stack, answering 503
 * before a peer connects and serving v2/v1 `onCall`, token checks, unbuffered
 * SSE streaming, `firebase-admin` writes, and execution lines once connected.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import {
  callableBody,
  functionsCallableCaptureDir,
  reportOf,
  sendProbeRequest,
} from '@pyric/conformance/functions-callable-fixture';
import { doc, getDoc } from 'pyric/firestore';
import { mintAppCheckToken, mintIdToken } from 'pyric/sandbox/internal';
import { bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { connectFunctionsWorkerPeer, createFunctionsWorkerHostCtx } from '../functions-rtdb/worker-peer.js';
import { killFunctionsChildren } from '../functions-http/children.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const builtChild = join(cliRoot, 'dist/functions/child.js');
const PROJECT_ID = 'demo-functions-callable';
const APP_ID = '1:000000000000:web:0000000000000000';
const ALLOW_ALL_FIRESTORE =
  "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{document=**} { allow read, write: if true; } } }";

let server: ViteDevServer | undefined;
let peer: { close(): Promise<void> } | undefined;
let stagedDir: string | undefined;

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      let port = 0;
      if (address && typeof address === 'object') port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(read: () => Promise<boolean>, timeoutMs: number, logs: readonly string[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out; dev server logs:\n${logs.slice(-30).join('\n')}`);
}

type ParsedFrame =
  | { kind: 'data'; json: unknown }
  | { kind: 'comment'; text: string };

function parseSseFrames(body: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const rawBlock of body.split(/\n\n/)) {
    const block = rawBlock.trim();
    if (block.length === 0) continue;
    if (block.startsWith(':')) {
      frames.push({ kind: 'comment', text: block.slice(1).trim() });
    } else if (block.startsWith('data: ')) {
      frames.push({ kind: 'data', json: JSON.parse(block.slice('data: '.length)) });
    }
  }
  return frames;
}

function stageFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-callable-vite-'));
  cpSync(join(functionsCallableCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsCallableCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsCallableCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  return cwd;
}

afterAll(async () => {
  await peer?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  killFunctionsChildren(process.pid);
  if (stagedDir) {
    rmSync(stagedDir, { recursive: true, force: true });
  }
});

describe('functions-callable on the Vite plane', () => {
  test('pyric() serves onCall functions at the emulator path and Hosting rewrite, 503 before a peer connects', async () => {
    if (!existsSync(builtChild)) throw new Error(`build the CLI first: ${builtChild}`);
    await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
    const cwd = stageFixture();
    stagedDir = cwd;
    const logs: string[] = [];
    const record = (message: string): void => { logs.push(message); };
    const { createServer } = await import('vite');
    server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      root: cwd,
      plugins: [pyric({ ui: false })],
      server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
      optimizeDeps: { noDiscovery: true },
      customLogger: {
        info: record,
        warn: record,
        warnOnce: record,
        error: record,
        clearScreen: () => {},
        hasErrorLogged: () => false,
        hasWarned: false,
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    let port = 0;
    if (address && typeof address === 'object') port = address.port;
    const base = `http://127.0.0.1:${port}`;
    const echoUrl = `${base}/${PROJECT_ID}/us-central1/pyricCallableEcho`;

    for (const target of [echoUrl, `${base}/pyricCallableEcho`]) {
      const beforePeer = await sendProbeRequest(target, {
        id: 'before-peer',
        function: 'pyricCallableEcho',
        via: 'cloudfunctions',
        ...callableBody({}),
      });
      expect(beforePeer.status).toBe(503);
      expect(beforePeer.body).toMatch(/browser tab/);
    }

    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-callable-vite',
      instanceId: 'functions-callable-vite',
      firestoreRules: ALLOW_ALL_FIRESTORE,
    });
    peer = await connectFunctionsWorkerPeer({
      url: `${base.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-callable-vite-peer',
    });

    await waitFor(async () => {
      const probe = await sendProbeRequest(echoUrl, {
        id: 'ready',
        function: 'pyricCallableEcho',
        via: 'cloudfunctions',
        ...callableBody({}),
      });
      return probe.status === 200;
    }, 30_000, logs);

    expect(logs.some((line) => line.includes('functions 5 onCall functions:'))).toBe(true);

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = mintIdToken({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      auth_time: nowSec - 7200,
      user_id: 'vite-user',
      sub: 'vite-user',
      iat: nowSec - 7200,
      exp: nowSec - 3600,
      firebase: { identities: {}, sign_in_provider: 'custom' },
    });
    const expiredRes = await sendProbeRequest(echoUrl, {
      id: 'expired',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      ...callableBody({}),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${expired}` },
    });
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.json).toEqual({ error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' } });

    const appCheck = await mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 300);
    const consumeUrl = `${base}/${PROJECT_ID}/us-central1/pyricCallableConsume`;
    const firstConsume = await sendProbeRequest(consumeUrl, {
      id: 'c1',
      function: 'pyricCallableConsume',
      via: 'cloudfunctions',
      ...callableBody({}),
      headers: { 'content-type': 'application/json', 'x-firebase-appcheck': appCheck.token },
    });
    const secondConsume = await sendProbeRequest(consumeUrl, {
      id: 'c2',
      function: 'pyricCallableConsume',
      via: 'cloudfunctions',
      ...callableBody({}),
      headers: { 'content-type': 'application/json', 'x-firebase-appcheck': appCheck.token },
    });
    expect(reportOf(firstConsume)?.app.alreadyConsumed).toBe(false);
    expect(reportOf(secondConsume)?.app.alreadyConsumed).toBe(true);

    const rewritten = await sendProbeRequest(`${base}/pyricCallableEcho`, {
      id: 'rewrite',
      function: 'pyricCallableEcho',
      via: 'hosting',
      ...callableBody({ mode: 'admin-write', id: 'vite-item-1' }),
    });
    expect(rewritten.status).toBe(200);
    const written = await getDoc(doc(ctx.db, 'pyric_oracle_callable/vite-item-1'));
    expect(written.data()).toEqual({ writtenBy: 'pyricCallableEcho', id: 'vite-item-1' });

    const streamUrl = `${base}/${PROJECT_ID}/us-central1/pyricCallableStream`;
    const streamed = await sendProbeRequest(streamUrl, {
      id: 'stream',
      function: 'pyricCallableStream',
      via: 'cloudfunctions',
      ...callableBody({ pauseMs: 1200 }),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    });
    expect(streamed.status).toBe(200);
    const frames = parseSseFrames(streamed.body);
    expect(frames.some((frame) => frame.kind === 'comment' && frame.text === 'ping')).toBe(true);
    expect(frames.filter((frame) => frame.kind === 'data').length).toBe(4);

    await waitFor(
      async () => logs.some((line) => line.includes('function  pyricCallableStream <- callable 200')),
      5_000,
      logs,
    );
  }, 240_000);
});
