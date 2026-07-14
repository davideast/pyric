import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  isBridgeMessage,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../src/serve/worker/protocol.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');

let command: ChildProcess | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;

async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `functions-dev-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'functions-dev-e2e',
    subs: new Map(),
  };
}

async function connectWorkerPeer(url: string): Promise<{ close(): Promise<void> }> {
  const ctx = await makeWorkerCtx();
  const ws = new WebSocket(url);
  const port: PortLike = {
    postMessage(raw: unknown) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const message = raw as OutboundMessage;
      if (message.t === 'res') {
        ws.send(JSON.stringify(message.ok
          ? { type: 'worker-res', id: message.id, ok: true, value: message.value }
          : { type: 'worker-res', id: message.id, ok: false, error: message.error }));
      } else if (message.t === 'snap') {
        ws.send(JSON.stringify({
          type: 'worker-snap',
          subId: message.subId,
          value: message.value,
        } satisfies BridgeMessage));
      }
    },
  };

  await new Promise<void>((resolveConnected, rejectConnected) => {
    ws.once('open', () => ws.send(JSON.stringify({
      type: 'hello',
      protocol: 1,
      tools: [],
      sandboxId: 'functions-dev-peer',
      capabilities: [WORKER_RELAY_CAPABILITY],
    } satisfies BridgeMessage)));
    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isBridgeMessage(message)) return;
      if (message.type === 'hello-ack') resolveConnected();
      else if (message.type === 'worker-op') {
        void handleMessage(ctx, port, {
          ...message.op,
          t: 'op',
          id: message.id,
        } as InboundMessage);
      } else if (message.type === 'worker-sub') {
        void handleMessage(ctx, port, {
          ...message.sub,
          t: 'sub',
          subId: message.subId,
        } as InboundMessage);
      } else if (message.type === 'worker-unsub') {
        void handleMessage(ctx, port, {
          t: 'unsub',
          subId: message.subId,
        } satisfies InboundMessage);
      }
    });
    ws.once('error', rejectConnected);
  });

  return {
    close: () => new Promise<void>((resolveClosed) => {
      if (ws.readyState === WebSocket.CLOSED) return resolveClosed();
      ws.once('close', () => resolveClosed());
      ws.close();
    }),
  };
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error('timed out waiting for pyric dev Functions outcome');
}

afterAll(async () => {
  observer?.close();
  if (peer) await peer.close();
  if (command?.exitCode === null) command.kill('SIGKILL');
});

describe('pyric dev Functions RTDB integration', () => {
  test('discovers unchanged source, executes it in one sandbox, and stops cleanly', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-dev-'));
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({
      hosting: { public: 'public' },
      functions: { source: 'functions' },
    }));
    writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({
      name: 'unchanged-functions',
      private: true,
      type: 'commonjs',
      main: 'index.cjs',
    }));
    writeFileSync(join(cwd, 'functions/index.cjs'), `
const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase')
    .set(event.data.val().toUpperCase()),
);
`);
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    let stdout = '';
    let stderr = '';
    command = spawn('node', [
      cliEntry,
      'dev',
      '--port=0',
      '--host=127.0.0.1',
      '--no-open',
      '--no-capture',
    ], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    command.stdout?.setEncoding('utf8');
    command.stderr?.setEncoding('utf8');
    command.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    command.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    const pointer = await waitFor(() => {
      const path = join(cwd, '.pyric/serve.json');
      return existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8')) as { url: string }
        : null;
    });
    peer = await connectWorkerPeer(`${pointer.url.replace(/^http/, 'ws')}/__pyric/sandbox`);
    observer = await connectRemoteSandbox({ url: pointer.url });
    await waitFor(() => stdout.includes('✔ functions 1 onValueCreated trigger') ? true : null);

    await observer.rtdb.set('messages/id/original', 'hello');
    await waitFor(async () =>
      (await observer!.rtdb.get('messages/id/uppercase')) === 'HELLO' ? true : null);
    await waitFor(() =>
      stdout.includes('✔ function  makeUppercase ← /messages/id/original') ? true : null);

    command.kill('SIGTERM');
    const code = await Promise.race([
      new Promise<number>((resolveExit) => command!.once('exit', (exit) => resolveExit(exit ?? 1))),
      Bun.sleep(5_000).then(() => -1),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('Shutting down...');
    expect(stderr).not.toContain('Functions child exited unexpectedly');
  }, 20_000);
});
