/**
 * Regression tests for `pyric bridge` SIGINT shutdown.
 *
 * The reported bug (user, 2026-05-25):
 *   $ npx pyric bridge
 *   ...
 *   ^C
 *   pyric: received SIGINT, stopping bridge...
 *   pyric: received SIGINT, stopping bridge...   ← duplicated
 *   [pyric] bridge stopped
 *   [pyric] bridge stopped                       ← also duplicated
 *
 * Two root causes:
 *   1. npx forwards SIGINT to its child AND the terminal sends SIGINT
 *      to the process group, so one Ctrl-C delivers SIGINT TWICE to
 *      the bridge process. Without idempotency, the handler ran twice.
 *   2. `handle.stop()` awaited `http.close()`, which only resolves
 *      once every existing connection drains naturally. With an MCP
 *      client or browser peer holding a keep-alive, shutdown HUNG
 *      until the peer disconnected on its own.
 *
 * Fix: idempotent CLI handler with a force-exit safety timer +
 * server-side `closeAllConnections()` and `ws.terminate()` before
 * awaiting `http.close()`.
 *
 * These tests pin both behaviors by spawning the real CLI as a child
 * process — the only way to exercise actual signal handling.
 */

import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const CLEAN_SHUTDOWN_BUDGET_MS = 1500;
const BRIDGE_READY_TIMEOUT_MS = 7_500;
const TEST_TIMEOUT_MS = 30_000;
const BRIDGE_START_ATTEMPTS = 3;

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'cli',
  'index.js',
);

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (port === null) throw new Error('failed to allocate bridge test port');
  return port;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

async function waitForReady(
  child: ChildProcess,
  out: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let readyTimer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(readyTimer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const checkReady = () => {
      const log = out.join('');
      if (log.includes('pyric bridge') && log.includes('ready')) finish();
    };
    const onData = () => checkReady();
    const onExit = () => fail(new Error(`bridge exited before ready: ${out.join('')}`));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    readyTimer = setTimeout(
      () => fail(new Error(`bridge ready timeout: ${out.join('')}`)),
      BRIDGE_READY_TIMEOUT_MS,
    );
    checkReady();
  });
}

/** Spawn `pyric bridge` and resolve once it logs the "ready" banner. */
async function spawnBridge(): Promise<{ child: ChildProcess; out: string[]; port: number }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= BRIDGE_START_ATTEMPTS; attempt += 1) {
    const port = await getAvailablePort();
    const child = spawn('node', [CLI, 'bridge'], {
      env: { ...process.env, PYRIC_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    const capture = (b: Buffer) => out.push(b.toString('utf-8'));
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    try {
      await waitForReady(child, out);
      return { child, out, port };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await killChild(child);
      if (out.join('').trim().length > 0) break;
    }
  }

  throw lastError ?? new Error('bridge failed to start');
}

/** Wait for the child to exit and return its exit code + elapsed ms. */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; elapsedMs: number }> {
  const start = performance.now();
  return new Promise((resolve) => {
    child.once('exit', (code) => {
      resolve({ code, elapsedMs: performance.now() - start });
    });
  });
}

describe('pyric bridge SIGINT shutdown', () => {
  test('single SIGINT exits promptly with code 130', async () => {
    const { child, out } = await spawnBridge();
    child.kill('SIGINT');
    const { code, elapsedMs } = await waitForExit(child);
    const log = out.join('');
    expect(code).toBe(130);
    expect(elapsedMs).toBeLessThan(CLEAN_SHUTDOWN_BUDGET_MS);
    expect(log.match(/received SIGINT/g)?.length).toBe(1);
    expect(log.match(/bridge stopped/g)?.length).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('double SIGINT (npx duplication) prints "received" once', async () => {
    const { child, out } = await spawnBridge();
    child.kill('SIGINT');
    child.kill('SIGINT');
    const { code, elapsedMs } = await waitForExit(child);
    const log = out.join('');
    expect(code).toBe(130);
    expect(elapsedMs).toBeLessThan(CLEAN_SHUTDOWN_BUDGET_MS);
    expect(log.match(/received SIGINT/g)?.length).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('SIGINT with held WebSocket peer still exits promptly', async () => {
    // Without `wss.clients.terminate()` + `http.closeAllConnections()`
    // in standalone.ts, this test would hang for the duration of the WS
    // peer's natural keep-alive (i.e. forever).
    const { child, port } = await spawnBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sandbox`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    child.kill('SIGINT');
    const { code, elapsedMs } = await waitForExit(child);
    expect(code).toBe(130);
    expect(elapsedMs).toBeLessThan(CLEAN_SHUTDOWN_BUDGET_MS);
    ws.close();
  }, TEST_TIMEOUT_MS);

  test('SIGTERM exits cleanly with code 0', async () => {
    const { child } = await spawnBridge();
    child.kill('SIGTERM');
    const { code, elapsedMs } = await waitForExit(child);
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(CLEAN_SHUTDOWN_BUDGET_MS);
  }, TEST_TIMEOUT_MS);
});
