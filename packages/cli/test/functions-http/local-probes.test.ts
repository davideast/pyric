/**
 * End-to-end local verification of the functions-http probes against live
 * `pyric sandbox` before production observations land. Exercises the exact
 * unchanged capture fixture (`packages/conformance/src/capture/functions-http`)
 * through `sendProbe` so every local serving behavior across rows #2-#17 is
 * pinned and regression-guarded in CI.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  functionsHttpCaptureDir,
  functionsHttpProbes,
  sendProbe,
  sendProbeRequest,
  type ProbeTargets,
} from '@pyric/conformance/functions-http-fixture';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import { functionsChildrenOf, isAlive } from './children.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const PROJECT_ID = 'demo-functions-http';
const SERVING_TIMEOUT_MS = 30_000;
const SLOW_PROBES = new Set([
  'functions-http-onrequest-headers-sent-failure',
  'functions-http-onrequest-no-response-timeout',
  'functions-http-onrequest-uncaught-async',
]);

interface LocalSession {
  cwd: string;
  url: string;
  command: ChildProcess;
  output(): string;
  targets: ProbeTargets;
}

const tempDirs = trackTempDirs('pyric-fn-http-probes-');
let sessionPromise: Promise<LocalSession> | undefined;
let fastBehaviorsPromise: Promise<Record<string, Record<string, any>>> | undefined;
let closePeer: (() => Promise<void>) | undefined;

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

function functionPath(name: string, region = 'us-central1'): string {
  return `/${PROJECT_ID}/${region}/${name}`;
}

function stageFixture(): string {
  const cwd = tempDirs.makeTempDir();
  cpSync(join(functionsHttpCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsHttpCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsHttpCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  return cwd;
}

async function startSession(): Promise<LocalSession> {
  if (!existsSync(cliEntry)) {
    throw new Error(`build the CLI first: ${cliEntry}`);
  }
  const cwd = stageFixture();
  let output = '';
  const command = spawn(
    'node',
    [cliEntry, 'sandbox', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
    {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  command.stdout?.setEncoding('utf8');
  command.stderr?.setEncoding('utf8');
  command.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  command.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });

  const pointer = await waitFor(() => {
    const pointerPath = join(cwd, '.pyric/serve.json');
    if (!existsSync(pointerPath)) return null;
    return JSON.parse(readFileSync(pointerPath, 'utf8')) as { url: string };
  }, 15_000);
  if (!pointer) {
    throw new Error(`pyric sandbox did not start:\n${output}`);
  }
  const url = pointer.url.replace(/\/$/, '');

  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-http-local-probes',
    instanceId: 'functions-http-local-probes',
  });
  const peer = await connectFunctionsWorkerPeer({
    url: `${url.replace(/^http/, 'ws')}/__pyric/sandbox`,
    ctx,
    sandboxId: 'functions-http-local-probes-peer',
  });
  closePeer = peer.close;

  const ready = await waitFor(async () => {
    const response = await sendProbeRequest(`${url}${functionPath('pyricHttpEcho')}`, {
      id: 'ready',
      function: 'pyricHttpEcho',
      via: 'cloudfunctions',
      clientTimeoutMs: 2_000,
    });
    if (response.status === 200) return true;
    return null;
  }, SERVING_TIMEOUT_MS);
  if (ready !== true) {
    throw new Error(`pyric sandbox did not serve pyricHttpEcho:\n${output.slice(-2_000)}`);
  }

  return {
    cwd,
    url,
    command,
    output: () => output,
    targets: {
      functionBase: (region) => `${url}/${PROJECT_ID}/${region}`,
      runBase: (name, region) => `${url}${functionPath(name, region)}`,
      hostingBase: () => url,
    },
  };
}

function getSession(): Promise<LocalSession> {
  if (!sessionPromise) {
    sessionPromise = startSession();
  }
  return sessionPromise;
}

async function runFastProbes(): Promise<Record<string, Record<string, any>>> {
  const started = await getSession();
  const behaviors: Record<string, Record<string, any>> = {};
  for (const probe of functionsHttpProbes) {
    if (SLOW_PROBES.has(probe.name)) continue;
    const responses = await sendProbe(probe.requests, started.targets);
    behaviors[probe.name] = probe.behavior(responses) as Record<string, any>;
  }
  return behaviors;
}

function getFastBehaviors(): Promise<Record<string, Record<string, any>>> {
  if (!fastBehaviorsPromise) {
    fastBehaviorsPromise = runFastProbes();
  }
  return fastBehaviorsPromise;
}

afterAll(async () => {
  if (closePeer) {
    await closePeer().catch(() => undefined);
  }
  let started: LocalSession | undefined;
  if (sessionPromise) {
    started = await sessionPromise.catch(() => undefined);
  }
  const cliPid = started?.command.pid;
  let children: number[] = [];
  if (cliPid !== undefined) {
    children = functionsChildrenOf(cliPid);
  }
  if (started && started.command.exitCode === null) {
    started.command.kill('SIGKILL');
  }
  for (const pid of children) {
    if (isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  tempDirs.cleanupTempDirs();
});

describe('functions-http local probe execution on pyric sandbox', () => {
  test('serves v1 https.onRequest root, nested path, and JSON POST', async () => {
    const v1 = (await getFastBehaviors())['functions-http-onrequest-v1'];
    expect(v1.root).toEqual({
      status: 200,
      method: 'GET',
      path: '/',
      url: '/?v=1',
      query: { v: '1' },
      body: {},
    });
    expect(v1.nested).toEqual({
      status: 200,
      method: 'GET',
      path: '/a/b',
      url: '/a/b?x=1',
      query: { x: '1' },
      body: {},
    });
    expect(v1.postJson).toEqual({
      status: 200,
      method: 'POST',
      path: '/',
      url: '/',
      query: {},
      body: { v: 1 },
    });
  }, 60_000);

  test('delivers method, repeated and bracketed query keys, request headers, and subpaths', async () => {
    const behaviors = await getFastBehaviors();
    const basic = behaviors['functions-http-onrequest-basic-get'];
    expect(basic.get.status).toBe(200);
    expect(basic.get.method).toBe('GET');
    expect(basic.get.query).toEqual({
      alpha: '1',
      list: ['a', 'b'],
      nested: { k: 'v' },
    });
    expect(basic.get.headerValues['x-pyric-probe']).toBe('basic-get');
    expect(basic.put).toEqual({ status: 200, method: 'PUT', query: { verb: 'put' } });
    expect(basic.delete).toEqual({ status: 200, method: 'DELETE' });

    const subpath = behaviors['functions-http-onrequest-subpath'];
    expect(subpath['cloudfunctions-bare']).toMatchObject({ status: 200, path: '/', url: '/' });
    expect(subpath['cloudfunctions-nested']).toMatchObject({ status: 200, path: '/a/b', url: '/a/b' });
    expect(subpath['cloudfunctions-trailing']).toMatchObject({ status: 200, path: '/a/b/', url: '/a/b/?x=1' });
    expect(subpath['cloudfunctions-encoded']).toMatchObject({
      status: 200,
      path: '/%E2%9C%93/space%20here',
      url: '/%E2%9C%93/space%20here',
    });
  });

  test('parses JSON, text, urlencoded, and raw bodies with rawBody bytes, and refuses malformed JSON with 400', async () => {
    const behaviors = await getFastBehaviors();
    const body = behaviors['functions-http-onrequest-body-parsing'];
    expect(body.json).toMatchObject({
      status: 200,
      bodyType: 'object',
      body: { a: 1, b: [true, null], c: { d: 'e' } },
      rawBody: Buffer.from('{"a":1,"b":[true,null],"c":{"d":"e"}}').toString('base64'),
    });
    expect(body['cloudevents-json']).toMatchObject({
      status: 200,
      bodyType: 'object',
      body: { specversion: '1.0' },
    });
    expect(body.text).toMatchObject({
      status: 200,
      bodyType: 'string',
      body: 'hello text',
      rawBody: Buffer.from('hello text').toString('base64'),
    });
    expect(body.urlencoded).toMatchObject({
      status: 200,
      bodyType: 'object',
      body: { a: { b: '1' }, c: ['2', '3'], d: ' space' },
    });
    expect(body['octet-stream']).toMatchObject({
      status: 200,
      bodyType: 'buffer',
      body: 'AAEC/w==',
      rawBody: 'AAEC/w==',
    });
    expect(body['unknown-type']).toMatchObject({
      status: 200,
      bodyType: 'buffer',
      body: Buffer.from('opaque').toString('base64'),
    });

    const malformed = behaviors['functions-http-onrequest-malformed-json'];
    expect(malformed.truncated.status).toBe(400);
    expect(malformed.truncated.reachedHandler).toBe(false);
    expect(malformed.notJson.status).toBe(400);
    expect(malformed.notJson.reachedHandler).toBe(false);
  });

  test('preserves response shapes, omits x-powered-by, and maps sync/async throws before and after headers', async () => {
    const behaviors = await getFastBehaviors();
    const shapes = behaviors['functions-http-onrequest-response-shapes'];
    expect(shapes.json).toMatchObject({
      status: 201,
      custom: 'yes',
      poweredBy: null,
      body: '{"ok":true,"shape":"json"}',
    });
    expect(shapes.redirect).toMatchObject({
      status: 302,
      location: '/elsewhere?from=redirect',
      poweredBy: null,
    });
    expect(shapes.status).toMatchObject({ status: 418, body: 'teapot', poweredBy: null });
    expect(shapes.empty).toMatchObject({ status: 204, body: '', poweredBy: null });
    expect(shapes.cookies.setCookie).toContain('pyric_a=1');
    expect(shapes.cookies.setCookie).toContain('pyric_b=2');
    expect(shapes.stream).toMatchObject({
      status: 200,
      body: 'chunk-1\nchunk-2\nchunk-3\n',
      poweredBy: null,
    });

    const failure = behaviors['functions-http-onrequest-handler-failure'];
    expect(failure.sync.status).toBe(500);
    expect(failure.sync.body).toBe('Internal Server Error');
    expect(failure.reject.status).toBe(500);
    expect(failure.reject.body).toBe('Internal Server Error');

    // In firebase-functions 7.2.5, `withErrorHandler` catches a throw or
    // rejection after headers are sent without calling `res.end()`, so the
    // streamed chunk arrives and the connection stays open until timeout.
    const session = await getSession();
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 400);
    let streamedChunk = '';
    let initialStatus = 0;
    try {
      const partialRes = await fetch(
        `${session.url}${functionPath('pyricHttpThrowAfterHeaders')}?mode=sync`,
        { signal: abortController.signal },
      );
      initialStatus = partialRes.status;
      const reader = partialRes.body?.getReader();
      if (reader) {
        const firstRead = await reader.read();
        if (firstRead.value) {
          streamedChunk = Buffer.from(firstRead.value).toString('utf8');
        }
      }
    } finally {
      clearTimeout(abortTimer);
      abortController.abort();
    }
    expect(initialStatus).toBe(200);
    expect(streamedChunk).toBe('partial');
  });

  test('honors unset vs configured CORS, warns once on private invoker, and routes hosting rewrites', async () => {
    const behaviors = await getFastBehaviors();
    const corsUnset = behaviors['functions-http-onrequest-cors-unset'];
    expect(corsUnset.preflight.allowOrigin).toBeNull();
    expect(corsUnset.preflight.reachedHandlerAs).toBe('OPTIONS');
    expect(corsUnset.get.allowOrigin).toBeNull();
    expect(corsUnset.get.reachedHandlerAs).toBe('GET');

    const corsConfigured = behaviors['functions-http-onrequest-cors-configured'];
    expect(corsConfigured['true-preflight-allowed']).toMatchObject({
      status: 204,
      allowOrigin: 'https://allowed.example',
      reachedHandlerAs: null,
    });
    expect(corsConfigured['true-preflight-denied']).toMatchObject({
      status: 204,
      allowOrigin: 'https://denied.example',
      reachedHandlerAs: null,
    });
    expect(corsConfigured['list-preflight-allowed']).toMatchObject({
      status: 204,
      allowOrigin: 'https://allowed.example',
      reachedHandlerAs: null,
    });
    // firebase-functions 7.2.5 (`lib/v2/providers/https.js:58-60`) unwraps a
    // single-element `cors` array to a static string, so `cors` sets that
    // fixed Access-Control-Allow-Origin while a RegExp omits it on mismatch.
    expect(corsConfigured['list-get-denied'].allowOrigin).toBe('https://allowed.example');
    expect(corsConfigured['regex-get-allowed'].allowOrigin).toBe('https://allowed.example');
    expect(corsConfigured['regex-get-denied'].allowOrigin).toBeNull();

    const priv = behaviors['functions-http-onrequest-invoker-private'];
    expect(priv.cloudfunctions.status).toBe(200);
    expect(priv.cloudfunctions.reachedHandler).toBe(true);
    const session = await getSession();
    const warnings = session
      .output()
      .split('\n')
      .filter((line) => /pyricHttpPrivate/.test(line) && /invoker/i.test(line));
    expect(warnings).toHaveLength(1);

    const notFound = behaviors['functions-http-onrequest-not-found'];
    expect(notFound.missing.status).toBe(404);
    expect(notFound.missingSubpath.status).toBe(404);

    const rewrite = behaviors['functions-http-hosting-rewrite'];
    expect(rewrite.api).toMatchObject({
      status: 200,
      path: '/api/items/42',
      url: '/api/items/42?x=1',
      query: { x: '1' },
      cookie: '__session=pyric-session',
      forwardedHostPresent: true,
      originalUrl: '/api/items/42?x=1',
    });
    expect(rewrite.apiPost).toMatchObject({
      status: 200,
      path: '/api/items',
      body: { via: 'hosting' },
    });
    expect(rewrite.regional).toMatchObject({
      status: 200,
      path: '/east/here',
    });
    expect(rewrite.legacy).toMatchObject({
      status: 200,
      path: '/legacy/old',
      url: '/legacy/old?y=2',
      query: { y: '2' },
    });
  });
});
