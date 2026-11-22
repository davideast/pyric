import 'fake-indexeddb/auto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getDatabase as getAdminDatabase, type Database as AdminDatabase } from 'pyric-admin/database';
import { createMemoryBackend } from 'pyric/sandbox';
import { WebSocket } from 'ws';
import type { AdminWritesObservation } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-writes-sentinels-and-validation.ts';
import type { RulesVerdictOutcome } from '../../../../../conformance/probes/rtdb/rtdb-rules-cascade-bindings-and-auth-context.ts';
import { openStorageBackend } from '../../../../../pyric/src/storage/persistence.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../../src/remote/index.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import { resolveNodeExecutable } from '../../require-node-on-path.js';

const CLI_ROOT = resolve(import.meta.dir, '../../../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const REGISTER_URL = pathToFileURL(join(CLI_ROOT, 'dist/register/index.js')).href;
const OBSERVATIONS_DIR = join(REPO_ROOT, 'packages/conformance/observations');
const OPEN_FIRESTORE_RULES = "rules_version = '2'; service cloud.firestore { match /{document=**} { allow read, write: if true; } }";

export interface CascadeAuthBehavior {
  ancestorCascadeOverridesChildFalse: Record<string, RulesVerdictOutcome>;
  pathVariableBindings: Record<string, RulesVerdictOutcome>;
  authNullVsBoundToken: Record<string, RulesVerdictOutcome>;
}

export interface CleanDisconnectBehavior {
  repeatCount: number;
  events: unknown[];
  beforeDisconnect: Record<string, unknown>;
  afterDisconnect: Record<string, unknown>;
  terminalAfterReconnect: Record<string, unknown>;
  secondDisconnectControlFired: boolean;
}

export interface AbruptExitBehavior {
  repeatCount: number;
  acknowledgement: { registered: boolean };
  events: Array<Record<string, unknown>>;
  terminal: Record<string, unknown>;
  exitWasForced: boolean;
}

function readObservationBehavior<T>(relativePath: string): T {
  const fullPath = join(OBSERVATIONS_DIR, relativePath);
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as { behavior: T };
  return parsed.behavior;
}

export function loadCascadeAuthBehavior(): CascadeAuthBehavior {
  return readObservationBehavior<CascadeAuthBehavior>(
    'rtdb/rtdb-rules-cascade-bindings-and-auth-context.json',
  );
}

export function loadCleanDisconnectBehavior(): CleanDisconnectBehavior {
  return readObservationBehavior<CleanDisconnectBehavior>(
    'rtdb-modular/rtdb-modular-ondisconnect-clean-set.json',
  );
}

export function loadAbruptExitBehavior(): AbruptExitBehavior {
  return readObservationBehavior<AbruptExitBehavior>(
    'rtdb-modular/rtdb-modular-ondisconnect-abrupt-exit.json',
  );
}

export function loadAdminWritesBehavior(): AdminWritesObservation {
  return readObservationBehavior<AdminWritesObservation>(
    'rtdb-modular/rtdb-modular-admin-writes-sentinels-and-validation.json',
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
let adminSeq = 0;

export async function cleanupServerProcessFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}

export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 15));
  }
}

function resolvePackageDir(pkgName: string): string {
  return realpathSync(dirname(Bun.resolveSync(`${pkgName}/package.json`, CLI_ROOT)));
}

function linkWorkspacePackages(projectDir: string): void {
  const nm = join(projectDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'packages/pyric'), join(nm, 'pyric'), 'dir');
  symlinkSync(join(REPO_ROOT, 'packages/pyric-admin'), join(nm, 'pyric-admin'), 'dir');
  symlinkSync(CLI_ROOT, join(nm, '@pyric/cli'), 'dir');
  symlinkSync(join(REPO_ROOT, 'packages/conformance'), join(nm, '@pyric/conformance'), 'dir');
  symlinkSync(resolvePackageDir('firebase'), join(nm, 'firebase'), 'dir');
  symlinkSync(resolvePackageDir('firebase-admin'), join(nm, 'firebase-admin'), 'dir');
  symlinkSync(resolvePackageDir('vite'), join(nm, 'vite'), 'dir');
}

function writeServePointer(projectDir: string, serveUrl: string, instanceId: string): void {
  const pyricDir = join(projectDir, '.pyric');
  mkdirSync(pyricDir, { recursive: true });
  writeFileSync(
    join(pyricDir, 'serve.json'),
    JSON.stringify({
      url: serveUrl,
      mcpUrl: `${serveUrl}/__pyric/mcp`,
      instanceId,
      pid: process.pid,
    }),
  );
}

export interface RegisteredServerHost {
  projectDir: string;
  serveUrl: string;
  instanceId: string;
  openAdminObserver(): Promise<AdminDatabase>;
}

export async function openRegisteredServerHost(options: {
  databaseRules: Record<string, unknown>;
  hosted?: boolean;
}): Promise<RegisteredServerHost> {
  let isHosted = true;
  if (options.hosted === false) {
    isHosted = false;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-rs1-host-'));
  linkWorkspacePackages(projectDir);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'rs1-fixture', type: 'module', private: true }));
  cleanups.push(() => rmSync(projectDir, { recursive: true, force: true }));

  if (!isHosted) {
    const offHostId = 'off-host-instance';
    const offServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === '/__pyric/health') {
          return Response.json({ mode: 'sandbox', instanceId: offHostId, sandboxConnected: false });
        }
        if (pathname === '/__pyric/init.json') {
          return Response.json({ hosted: false, projectKey: null, bridgeUrl: null });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const offUrl = `http://127.0.0.1:${offServer.port}`;
    writeServePointer(projectDir, offUrl, offHostId);
    cleanups.push(() => {
      void offServer.stop(true);
    });
    return {
      projectDir,
      serveUrl: offUrl,
      instanceId: offHostId,
      openAdminObserver() {
        return Promise.reject(new Error('Admin observer unavailable on off-host server'));
      },
    };
  }

  const sockets = new Map<string, { send(data: string): void }>();
  const clientClosers: Array<() => void> = [];
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-rs1-${Math.random()}`),
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };

  const runtime = await createHostedRuntime(
    {
      rules: OPEN_FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: options.databaseRules,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: 'demo-oracle-default-rtdb',
        rules: { 'demo-oracle-default-rtdb': options.databaseRules },
        projectId: 'demo-oracle',
      },
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: 'oracle-rs1',
      appOptions: {
        projectId: 'demo-oracle',
        databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
      },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const isReply =
        frame.type === 'worker-message-result'
        || frame.type === 'worker-res'
        || frame.type === 'worker-snap';
      if (!isReply) return;
      const sessionId = frame.clientSessionId;
      if (typeof sessionId !== 'string') return;
      const socket = sockets.get(sessionId);
      if (socket !== undefined) {
        socket.send(JSON.stringify(frame));
      }
    },
    projectDir,
    { persistence: persistence as never, record: false },
  );

  let nextSession = 0;
  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, bunServer) {
      const { pathname } = new URL(req.url);
      if (pathname === '/__pyric/health') {
        return Response.json({ mode: 'sandbox', instanceId: runtime.instanceId, sandboxConnected: true });
      }
      if (pathname === '/__pyric/init.json') {
        return Response.json({
          hosted: true,
          projectKey: 'oracle-rs1',
          bridgeUrl: '/__pyric/sandbox',
          instanceId: runtime.instanceId,
          appOptions: {
            projectId: 'demo-oracle',
            databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
          },
        });
      }
      const sessionId = `rs1-session-${++nextSession}`;
      if (bunServer.upgrade(req, { data: { sessionId } })) return undefined;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.set(socket.data.sessionId, socket);
      },
      message(socket, raw) {
        const msg = JSON.parse(String(raw)) as BridgeMessage & { ts?: number };
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: msg.ts ?? Date.now() }));
          return;
        }
        if (msg.type === 'attach') {
          socket.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: socket.data.sessionId,
              projectKey: 'oracle-rs1',
              hostInstanceId: runtime.instanceId,
              capabilities: ['worker-port', 'worker-relay'],
            } satisfies BridgeMessage),
          );
          return;
        }
        if (msg.type === 'worker-message') {
          runtime.receive({
            type: 'worker-message',
            clientSessionId: socket.data.sessionId,
            message: msg.message,
            platform: 'node',
          });
          return;
        }
        if (msg.type === 'worker-op' || msg.type === 'worker-sub' || msg.type === 'worker-unsub') {
          runtime.receive({ ...msg, clientSessionId: socket.data.sessionId });
        }
      },
      close(socket) {
        sockets.delete(socket.data.sessionId);
        runtime.receive({ type: 'worker-client-disconnect', clientSessionId: socket.data.sessionId });
      },
    },
  });

  const serveUrl = `http://127.0.0.1:${server.port}`;
  const wsUrl = `ws://127.0.0.1:${server.port}/__pyric/sandbox`;
  writeServePointer(projectDir, serveUrl, runtime.instanceId);

  cleanups.push(async () => {
    for (const closeClient of clientClosers.splice(0)) {
      closeClient();
    }
    await runtime.close();
    await server.stop(true);
  });

  const openAdminObserver = async (): Promise<AdminDatabase> => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.once('open', () => resolveOpen());
      ws.once('error', rejectOpen);
    });
    const core = createRemoteSandboxCore(
      {
        send(outMsg) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(outMsg));
          }
        },
      },
      { serveUrl },
    );
    ws.on('message', (data) => {
      core.handleMessage(JSON.parse(String(data)) as BridgeMessage);
    });
    core.start();
    await core.ready;
    const handle = createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl,
      close() {
        core.dispose('closed');
        ws.close();
      },
    });
    adminSeq += 1;
    const app = initializeAdminApp({ sandbox: handle, projectId: 'demo-oracle' }, `rs1-obs-admin-${adminSeq}`);
    clientClosers.push(() => {
      void deleteAdminApp(app);
      handle.close();
    });
    return getAdminDatabase(app);
  };

  return { projectDir, serveUrl, instanceId: runtime.instanceId, openAdminObserver };
}

export function createViteSsrProjectDir(databaseRules: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rs-vite-ssr-'));
  linkWorkspacePackages(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'vite-ssr-fixture', type: 'module', private: true }));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
  writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(databaseRules, null, 2));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface NodeScriptResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function collectChildProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<NodeScriptResult> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`Node child timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolveExit({ status, signal, stdout, stderr });
    });
  });
}

export function runRegisteredNodeScript(
  projectDir: string,
  scriptName: string,
  source: string,
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
): Promise<NodeScriptResult> {
  const scriptPath = join(projectDir, scriptName);
  writeFileSync(scriptPath, source);
  const nodeBin = resolveNodeExecutable();
  const child = spawn(nodeBin, ['--import', REGISTER_URL, scriptPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_SANDBOX_FORCE: undefined,
      PYRIC_SANDBOX_INSTANCE: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  return collectChildProcess(child, timeoutMs);
}

export function spawnRegisteredNodeChild(
  projectDir: string,
  scriptName: string,
  source: string,
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
): {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  waitExit: () => Promise<NodeScriptResult>;
} {
  const scriptPath = join(projectDir, scriptName);
  writeFileSync(scriptPath, source);
  const nodeBin = resolveNodeExecutable();
  const child = spawn(nodeBin, ['--import', REGISTER_URL, scriptPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_SANDBOX_FORCE: undefined,
      PYRIC_SANDBOX_INSTANCE: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  let out = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    out += String(chunk);
  });
  const exitPromise = collectChildProcess(child, timeoutMs);
  return {
    child,
    stdout: () => out,
    waitExit: () => exitPromise,
  };
}

export function runPlainNodeScript(
  projectDir: string,
  scriptName: string,
  source: string,
  env: Record<string, string | undefined> = {},
  timeoutMs = 30_000,
): Promise<NodeScriptResult> {
  const scriptPath = join(projectDir, scriptName);
  writeFileSync(scriptPath, source);
  const nodeBin = resolveNodeExecutable();
  const child = spawn(nodeBin, [scriptPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_SANDBOX_FORCE: undefined,
      PYRIC_SANDBOX_INSTANCE: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  return collectChildProcess(child, timeoutMs);
}
