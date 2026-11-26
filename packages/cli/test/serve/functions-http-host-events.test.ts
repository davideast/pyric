import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { initializeSandbox, type LocalSandbox, type SandboxEvent } from 'pyric/sandbox';
import { listExecutions } from '../../src/functions/execution-log.js';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';
import {
  createFunctionsHttpGateway,
  type AppOriginCheck,
  type FunctionsHttpGateway,
  type FunctionsHttpRecord,
} from '../../src/functions/http/gateway.js';
import { hostingRewrites } from '../../src/functions/http/rewrites.js';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const TOKEN = 'test-token';
const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const { makeTempDir, cleanupTempDirs } = trackTempDirs('pyric-http-host-events-');

const appOriginOnly: AppOriginCheck = (req) =>
  req.headers.origin === undefined || req.headers.origin === 'http://localhost:5173';

function httpFn(
  exportName: string,
  options: { privateInvoker?: boolean; timeoutSeconds?: number | null; kind?: 'http' | 'callable' } = {},
): HttpFunctionInfo {
  const fn: HttpFunctionInfo = {
    exportName,
    regions: ['us-central1'],
    platform: 'gcfv2',
    privateInvoker: options.privateInvoker ?? false,
    timeoutSeconds: options.timeoutSeconds ?? null,
  };
  if (options.kind !== undefined) {
    fn.kind = options.kind;
  }
  return fn;
}

const servers: Server[] = [];

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolveListen(`http://127.0.0.1:${address.port}`);
    }),
  );
}

async function plane(gateway: FunctionsHttpGateway): Promise<string> {
  return listen(
    createServer((req, res) => {
      void gateway.handle(req, res, appOriginOnly).then((handled) => {
        if (!handled) res.writeHead(404).end('static');
      });
    }),
  );
}

function functionsEvents(sandbox: LocalSandbox): Array<SandboxEvent & { op: string; path?: string; detail?: Record<string, unknown> }> {
  return sandbox
    .history()
    .filter((event) => event.kind === 'service_mutation' && event.service === 'functions') as Array<
    SandboxEvent & { op: string; path?: string; detail?: Record<string, unknown> }
  >;
}

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

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

afterAll(() => {
  cleanupTempDirs();
});

describe('functions onRequest Node host event stream (#1768)', () => {
  test('emits one execution_finished event per served onRequest on the Node host, stripping query tokens', async () => {
    const child = await listen(
      createServer((req, res) => {
        if (req.url?.startsWith('/fail')) {
          res.writeHead(500).end('boom');
          return;
        }
        if (req.url?.includes('/slow')) {
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      }),
    );
    const childPort = Number(new URL(child).port);
    const sandbox = initializeSandbox();
    const liveEvents: SandboxEvent[] = [];
    const unsub = sandbox.onEvent((event) => liveEvents.push(event));
    const served: FunctionsHttpRecord[] = [];

    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: {
        kind: 'ready',
        http: {
          port: childPort,
          token: TOKEN,
          functions: [
            httpFn('api', { timeoutSeconds: 1 }),
            httpFn('privateFn', { privateInvoker: true }),
            httpFn('echoCallable', { kind: 'callable' }),
          ],
        },
      },
      rewrites: hostingRewrites({
        hosting: { rewrites: [{ source: '/api/**', function: 'api' }] },
      }),
      hostingRewriteTimeoutSeconds: 0.1,
      sandbox,
      onServed: (record) => served.push(record),
      plane: 'pyric-sandbox',
    });
    const base = await plane(gateway);

    try {
      const created = await fetch(`${base}/api/messages?token=secret-query-token&page=2#frag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(created.status).toBe(201);

      const failed = await fetch(`${base}/demo-app/us-central1/api/fail?key=secret-2`);
      expect(failed.status).toBe(500);

      const timedOut = await fetch(`${base}/api/slow`);
      expect(timedOut.status).toBe(504);

      // Refused foreign origin, unknown function, and callable calls do not emit onRequest events.
      const forbidden = await fetch(`${base}/demo-app/us-central1/privateFn`, {
        headers: { origin: 'https://attacker.example' },
      });
      expect(forbidden.status).toBe(403);

      const unknown = await fetch(`${base}/demo-app/us-central1/missingFn`, {
        method: 'POST',
        body: 'x',
      });
      expect(unknown.status).toBe(404);

      const callable = await fetch(`${base}/demo-app/us-central1/echoCallable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: {} }),
      });
      expect(callable.status).toBe(201);

      expect(served).toHaveLength(4);
      const events = functionsEvents(sandbox);
      expect(events).toHaveLength(3);
      expect(liveEvents.filter((e) => e.kind === 'service_mutation' && e.service === 'functions')).toHaveLength(3);

      const serializedHistory = JSON.stringify(sandbox.history());
      expect(serializedHistory).not.toContain('secret-query-token');
      expect(serializedHistory).not.toContain('secret-2');
      expect(serializedHistory).not.toContain('frag');

      expect(events[0]?.op).toBe('execution_finished');
      expect(events[0]?.path).toBe('/api/messages');
      expect(events[0]?.detail?.function).toBe('api');
      expect(events[0]?.detail?.trigger).toBe('api');
      expect(events[0]?.detail?.method).toBe('POST');
      expect(events[0]?.detail?.path).toBe('/api/messages');
      expect(events[0]?.detail?.httpStatus).toBe(201);
      expect(events[0]?.detail?.status).toBe('fulfilled');
      expect(typeof events[0]?.detail?.durationMs).toBe('number');

      expect(events[1]?.path).toBe('/fail');
      expect(events[1]?.detail?.method).toBe('GET');
      expect(events[1]?.detail?.httpStatus).toBe(500);
      expect(events[1]?.detail?.status).toBe('rejected');
      expect(String(events[1]?.detail?.error)).toContain('GET /fail responded 500');

      expect(events[2]?.path).toBe('/api/slow');
      expect(events[2]?.detail?.httpStatus).toBe(504);
      expect(events[2]?.detail?.status).toBe('timeout');

      const executions = listExecutions(sandbox);
      expect(executions).toHaveLength(3);
      expect(executions[0]).toMatchObject({
        id: '1',
        trigger: 'api',
        cause: {
          ref: '/api/messages',
          params: { method: 'POST', path: '/api/messages', status: '201' },
        },
        status: 'fulfilled',
        result: { method: 'POST', path: '/api/messages', status: 201 },
      });
      expect(executions[1]?.status).toBe('rejected');
      expect(executions[2]?.status).toBe('timeout');
    } finally {
      unsub();
    }
  });

  test('keeps browser mode log-line-only when no host sandbox is attached and never fails HTTP delivery on emit errors', async () => {
    const child = await listen(
      createServer((_req, res) => {
        res.writeHead(200).end('ok');
      }),
    );
    const childPort = Number(new URL(child).port);
    const tabSandbox = initializeSandbox();
    const browserServed: FunctionsHttpRecord[] = [];

    const browserGateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: {
        kind: 'ready',
        http: { port: childPort, token: TOKEN, functions: [httpFn('api')] },
      },
      onServed: (record) => browserServed.push(record),
      plane: 'pyric-sandbox',
    });
    const browserBase = await plane(browserGateway);
    const browserRes = await fetch(`${browserBase}/demo-app/us-central1/api/hello`);
    expect(browserRes.status).toBe(200);
    expect(browserServed).toHaveLength(1);
    expect(tabSandbox.history()).toEqual([]);

    const brokenSandbox = { history: () => [] } as unknown as LocalSandbox;
    const resilientGateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: {
        kind: 'ready',
        http: { port: childPort, token: TOKEN, functions: [httpFn('api')] },
      },
      sandbox: brokenSandbox,
      plane: 'pyric-sandbox',
    });
    const resilientBase = await plane(resilientGateway);
    const resilientRes = await fetch(`${resilientBase}/demo-app/us-central1/api/hello`);
    expect(resilientRes.status).toBe(200);
    expect(await resilientRes.text()).toBe('ok');
  });

  test('pyric sandbox --hosted streams served onRequest records to Studio WS subscribers and pyric functions executions', async () => {
    expect(existsSync(cliEntry)).toBe(true);
    const dir = makeTempDir('pyric-hosted-onrequest-stream-');
    mkdirSync(join(dir, 'public'), { recursive: true });
    mkdirSync(join(dir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(dir, 'public/index.html'), '<!doctype html><title>hosted</title>');
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-hosted-http' } }));
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        functions: { source: 'functions' },
        hosting: {
          public: 'public',
          rewrites: [{ source: '/api/**', function: 'api' }],
        },
      }),
    );
    writeFileSync(
      join(dir, 'functions/package.json'),
      JSON.stringify({ name: 'hosted-http-fn', private: true, main: 'index.cjs' }),
    );
    writeFileSync(
      join(dir, 'functions/index.cjs'),
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        'exports.api = onRequest((req, res) => {',
        '  res.status(201).json({ method: req.method, url: req.url });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(dir, 'functions/node_modules/firebase-functions'),
    );

    let output = '';
    const child: ChildProcess = spawn(
      'node',
      [cliEntry, 'sandbox', '--hosted', '--no-run', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.stderr?.on('data', (chunk: string) => { output += chunk; });

    let ws: WebSocket | null = null;
    try {
      const pointer = await waitFor(() => {
        const pointerPath = join(dir, '.pyric/serve.json');
        if (!existsSync(pointerPath) || !output.includes('1 onRequest function:')) return null;
        return JSON.parse(readFileSync(pointerPath, 'utf8')) as { url: string; token?: string };
      }, 20_000);
      expect(pointer).not.toBeNull();
      const baseUrl = (pointer?.url ?? '').replace(/\/$/, '');
      const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/__pyric/sandbox`;

      const streamedEvents: Array<Record<string, unknown>> = [];
      ws = new WebSocket(wsUrl, {
        headers: pointer?.token !== undefined ? { 'x-pyric-session-token': pointer.token } : {},
      });
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws?.once('open', () => resolveOpen());
        ws?.once('error', rejectOpen);
      });
      let initialSnapshotDelivered = false;
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          type?: string;
          message?: { t?: string; events?: Array<Record<string, unknown>> };
        };
        if (frame.type === 'attach-ack') {
          ws?.send(
            JSON.stringify({
              type: 'worker-message',
              message: { t: 'sub', subId: 'studio-ev-1', target: 'events' },
            }),
          );
          return;
        }
        if (frame.type === 'worker-message-result' && frame.message?.t === 'event') {
          initialSnapshotDelivered = true;
          for (const ev of frame.message.events ?? []) {
            streamedEvents.push(ev);
          }
        }
      });
      ws.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
      expect(await waitFor(() => (initialSnapshotDelivered ? true : null), 5_000)).toBe(true);

      const response = await fetch(`${baseUrl}/api/messages?token=never-emit-me`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(response.status).toBe(201);

      const liveHttpEvent = await waitFor(() => {
        const found = streamedEvents.find(
          (ev) =>
            ev.kind === 'service_mutation' &&
            ev.service === 'functions' &&
            ev.op === 'execution_finished',
        );
        return found ?? null;
      }, 5_000);
      expect(liveHttpEvent).not.toBeNull();
      expect(liveHttpEvent?.path).toBe('/api/messages');
      expect(liveHttpEvent?.detail).toMatchObject({
        function: 'api',
        trigger: 'api',
        method: 'POST',
        path: '/api/messages',
        httpStatus: 201,
        status: 'fulfilled',
      });
      expect(JSON.stringify(liveHttpEvent)).not.toContain('never-emit-me');

      // Terminal log line is preserved alongside the host event stream emission.
      expect(
        await waitFor(
          () => (output.includes('POST /api/messages 201') ? true : null),
          5_000,
        ),
      ).toBe(true);

      // Agent CLI surface (`pyric functions executions`) reads the folded execution off the Node host.
      const rawExecutions = execFileSync('node', [cliEntry, 'functions', 'executions', '--json'], {
        cwd: dir,
        encoding: 'utf8',
      });
      const parsedExecutions = JSON.parse(rawExecutions) as {
        ok: boolean;
        data: {
          executions: Array<{
            trigger: string;
            cause: { ref: string; params: Record<string, string> };
            durationMs: number;
            status: string;
          }>;
        };
      };
      expect(parsedExecutions.ok).toBe(true);
      expect(parsedExecutions.data.executions).toHaveLength(1);
      expect(parsedExecutions.data.executions[0]).toMatchObject({
        trigger: 'api',
        cause: {
          ref: '/api/messages',
          params: { method: 'POST', path: '/api/messages', status: '201' },
        },
        status: 'fulfilled',
      });
      expect(parsedExecutions.data.executions[0]?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      ws?.close();
      const cliPid = child.pid;
      const fnChildren = cliPid === undefined ? [] : functionsChildrenOf(cliPid);
      if (child.exitCode === null) child.kill('SIGKILL');
      for (const pid of fnChildren) {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }, 30_000);
});
