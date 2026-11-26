import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend } from 'pyric/sandbox';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerDist = join(cliRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;

const PROBE_SCRIPT = `
import { deleteApp, initializeApp } from 'firebase/app';
import {
  FieldValue,
  doc,
  getDoc,
  getFirestore,
  maximum,
  minimum,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

const app = initializeApp({ projectId: 'demo-reg-minmax', apiKey: 'test-key' });
const db = getFirestore(app);
const ref = doc(db, 'stats/s1');
await setDoc(ref, { high: maximum(10), low: minimum(10), wrongType: 'text' });
await updateDoc(ref, { high: maximum(25), low: minimum(3), wrongType: maximum(-2) });
await updateDoc(ref, { high: maximum(12), low: minimum(9) });
const snap = await getDoc(ref);
console.log(JSON.stringify({
  isFv: maximum(1) instanceof FieldValue && minimum(1) instanceof FieldValue,
  eq: maximum(4).isEqual(FieldValue.maximum(4)) && minimum(Number.NaN).isEqual(minimum(Number.NaN)),
  data: snap.data(),
}));
await deleteApp(app);
`;

function makeMemoryHostedPersistence(): HostedPersistence {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    seed: async () => false,
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  } as unknown as HostedPersistence;
}

function runRegisteredNode(
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (!existsSync(registerDist)) {
    throw new Error(`dist/register/index.js missing -- run \`bun run --cwd packages/cli build\` first (${registerDist})`);
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', ['--import', registerUrl, '--input-type=module', '-e', PROBE_SCRIPT], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: undefined,
        PYRIC_SANDBOX: undefined,
        PYRIC_SANDBOX_INSTANCE: undefined,
        PYRIC_SANDBOX_FORCE: undefined,
        ...env,
      },
    });
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
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`node child timed out; stderr=${stderr}`));
    }, 20_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ status: code, stdout, stderr });
    });
  });
}

describe('registered Node firebase/firestore maximum() and minimum() (#1672)', () => {
  it('supports maximum() and minimum() in local in-process registered mode (PYRIC_SANDBOX=local)', async () => {
    const res = await runRegisteredNode({ PYRIC_SANDBOX: 'local' });
    expect(res.status, res.stderr).toBe(0);
    const line = res.stdout.trim().split('\n').find((item) => item.startsWith('{')) ?? '{}';
    expect(JSON.parse(line)).toEqual({
      isFv: true,
      eq: true,
      data: { high: 25, low: 3, wrongType: -2 },
    });
  });

  it('supports maximum() and minimum() over the remote hosted bridge (PYRIC_SANDBOX=remote:...)', async () => {
    const sockets = new Map<string, { send(data: string): void }>();
    let baseOrigin = 'http://127.0.0.1:0';
    const runtime = await createHostedRuntime(
      {
        rules: null,
        rulesHash: null,
        databaseRules: null,
        databaseRulesHash: null,
        bridgeUrl: '/__pyric/sandbox',
        seed: null,
        capture: false,
        hosted: true,
        permissive: true,
        projectKey: 'reg-minmax-remote',
        appOptions: { projectId: 'demo-reg-minmax' },
      },
      () => baseOrigin,
      (frame) => {
        const forwards =
          frame.type === 'worker-message-result'
          || frame.type === 'worker-res'
          || frame.type === 'worker-snap';
        if (!forwards || typeof frame.clientSessionId !== 'string') return;
        const sock = sockets.get(frame.clientSessionId);
        if (sock !== undefined) sock.send(JSON.stringify(frame));
      },
      repoRoot,
      { persistence: makeMemoryHostedPersistence(), record: false },
    );

    let nextSession = 0;
    const server = Bun.serve<{ sessionId: string }>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, bunServer) {
        const url = new URL(req.url);
        if (url.pathname === '/__pyric/health') {
          return Response.json({
            ok: true,
            instanceId: runtime.instanceId,
            projectKey: 'reg-minmax-remote',
            mode: 'sandbox',
          });
        }
        if (url.pathname === '/__pyric/init.json') {
          return Response.json({
            hosted: true,
            bridgeUrl: '/__pyric/sandbox',
            projectKey: 'reg-minmax-remote',
            instanceId: runtime.instanceId,
          });
        }
        const sessionId = `reg-minmax-${++nextSession}`;
        if (bunServer.upgrade(req, { data: { sessionId } })) return undefined;
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          sockets.set(ws.data.sessionId, ws);
        },
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as BridgeMessage;
          if (msg.type === 'attach') {
            ws.send(JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: ws.data.sessionId,
              projectKey: 'reg-minmax-remote',
              hostInstanceId: runtime.instanceId,
              capabilities: ['worker-port', 'worker-relay'],
            } satisfies BridgeMessage));
            return;
          }
          if (msg.type === 'worker-message') {
            runtime.receive({
              type: 'worker-message',
              clientSessionId: ws.data.sessionId,
              message: msg.message,
              platform: 'node',
            });
          }
        },
        close(ws) {
          sockets.delete(ws.data.sessionId);
          runtime.receive({
            type: 'worker-client-disconnect',
            clientSessionId: ws.data.sessionId,
          });
        },
      },
    });
    baseOrigin = `http://127.0.0.1:${server.port}`;

    try {
      const res = await runRegisteredNode({
        PYRIC_SANDBOX: `remote:${baseOrigin}`,
        PYRIC_SANDBOX_INSTANCE: runtime.instanceId,
      });
      expect(res.status, res.stderr).toBe(0);
      const line = res.stdout.trim().split('\n').find((item) => item.startsWith('{')) ?? '{}';
      expect(JSON.parse(line)).toEqual({
        isFv: true,
        eq: true,
        data: { high: 25, low: 3, wrongType: -2 },
      });
    } finally {
      await runtime.close();
      await server.stop(true);
    }
  });
});
