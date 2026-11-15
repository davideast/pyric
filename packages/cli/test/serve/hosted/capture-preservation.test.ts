/**
 * Unit tests for `serve/hosted/capture-preservation.ts` through real
 * `createHostedRuntime` + live HTTP `/__pyric/capture` without manual
 * `store.write` calls.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { recordCheckpointBackend } from 'pyric/sandbox/checkpoints';
import { openStorageBackend } from '../../../../pyric/src/storage/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import {
  CAPTURE_RELATIVE_PATH,
  createCaptureStore,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
} from '../../../src/serve/capture-store.js';
import { handleCapture } from '../../../src/serve/state-capture-route.js';
import type { PyricVerifyFixture } from '../../../src/verify/fixture.js';

const STRICT_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} {',
  '      allow read: if true;',
  "      allow write: if request.resource.data.state != 'refused';",
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-capture-preserve-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function startCaptureServer(projectDir: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const store = createCaptureStore(projectDir);
  const server: Server = createServer((req, res) => {
    if (req.url === '/__pyric/capture') {
      void handleCapture(store, req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function makeInMemoryPersistence() {
  return {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-hosted-capture-${Math.random()}`),
    checkpoints: recordCheckpointBackend(createMemoryBackend()),
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

type HostedRuntime = Awaited<ReturnType<typeof createHostedRuntime>>;

async function openHosted(projectDir: string, baseUrl: string, capture: boolean): Promise<HostedRuntime> {
  const persistence = await makeInMemoryPersistence();
  return createHostedRuntime(
    {
      rules: STRICT_FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture,
      hosted: true,
      permissive: false,
      projectKey: 'hosted-capture-preserve',
      sessionToken: 'tok-hosted-preserve',
    },
    baseUrl,
    () => {},
    projectDir,
    { persistence: persistence as never, record: false },
  );
}

function deniedCountOf(fixture: PyricVerifyFixture): number {
  return fixture.events.filter((event) => 'result' in event && event.result === 'deny').length;
}

function callHosted(
  runtime: HostedRuntime,
  projectDir: string,
  conn: object,
  key: string,
  args: Record<string, unknown>,
) {
  return runtime.runMethod(
    { key, instanceId: 'hosted-capture-test', args, projectDir, allowProduction: false },
    conn,
  );
}

describe('hosted capture preservation across fast sandbox.reset and sandbox.restore', () => {
  it('flushes un-debounced events before fast sandbox.reset, rotates immediately, and keeps previous-session across empty reset', async () => {
    const dir = makeTempProject();
    const server = await startCaptureServer(dir);
    const runtime = await openHosted(dir, server.url, true);
    const conn = {};
    try {
      await callHosted(runtime, dir, conn, 'auth.actAsAnonymous', {});
      const allowed = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'kept' },
      });
      expect(allowed.ok).toBe(true);
      const denied = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'refused' },
      });
      expect(denied.ok).toBe(false);

      // Immediately reset inside the 400ms capture debounce window without sleeping.
      const resetResult = await callHosted(runtime, dir, conn, 'sandbox.reset', {
        scope: 'all',
        confirm: true,
      });
      expect(resetResult.ok).toBe(true);
      expect(resetResult.summary).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      const resetData = resetResult.data as {
        previousCapture?: { path: string; eventCount: number; denialCount: number };
      };
      expect(resetData.previousCapture?.path).toBe(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(resetData.previousCapture?.denialCount).toBeGreaterThanOrEqual(1);

      const previousPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      const activePath = join(dir, CAPTURE_RELATIVE_PATH);
      expect(existsSync(previousPath)).toBe(true);
      expect(existsSync(activePath)).toBe(true);

      const preserved = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      const active = JSON.parse(readFileSync(activePath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountOf(preserved)).toBeGreaterThanOrEqual(1);
      const preservedMeta = resetData.previousCapture;
      expect(preservedMeta).toBeDefined();
      if (preservedMeta !== undefined) {
        expect(preserved.events.length).toBe(preservedMeta.eventCount);
      }
      expect(active.events).toHaveLength(0);

      // A second empty reset must not overwrite previous-session.json or claim preservation.
      const secondReset = await callHosted(runtime, dir, conn, 'sandbox.reset', {
        scope: 'all',
        confirm: true,
      });
      expect(secondReset.ok).toBe(true);
      expect(secondReset.summary).not.toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      const afterSecond = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(afterSecond.events.length).toBe(preserved.events.length);
      expect(deniedCountOf(afterSecond)).toBe(deniedCountOf(preserved));
    } finally {
      await runtime.close();
      await server.close();
    }
  });

  it('flushes un-debounced events before fast sandbox.restore and rotates immediately on success', async () => {
    const dir = makeTempProject();
    const server = await startCaptureServer(dir);
    const runtime = await openHosted(dir, server.url, true);
    const conn = {};
    try {
      await callHosted(runtime, dir, conn, 'auth.actAsAnonymous', {});
      await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/base',
        data: { state: 'kept' },
      });
      const cp = await callHosted(runtime, dir, conn, 'sandbox.checkpoint', { name: 'c1' });
      expect(cp.ok).toBe(true);

      const denied = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/b',
        data: { state: 'refused' },
      });
      expect(denied.ok).toBe(false);

      // Missing checkpoint fails without creating previous-session.json.
      const missing = await callHosted(runtime, dir, conn, 'sandbox.restore', {
        name: 'does-not-exist',
        confirm: true,
      });
      expect(missing.ok).toBe(false);
      expect(existsSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH))).toBe(false);

      // Immediate restore rotates the live capture synchronously before returning.
      const restored = await callHosted(runtime, dir, conn, 'sandbox.restore', {
        name: 'c1',
        confirm: true,
      });
      expect(restored.ok).toBe(true);
      expect(restored.summary).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      const restoreData = restored.data as {
        previousCapture?: { path: string; eventCount: number; denialCount: number };
      };
      expect(restoreData.previousCapture?.denialCount).toBeGreaterThanOrEqual(1);

      const preserved = JSON.parse(
        readFileSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      const active = JSON.parse(
        readFileSync(join(dir, CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      expect(deniedCountOf(preserved)).toBeGreaterThanOrEqual(1);
      expect(active.events).toHaveLength(0);
    } finally {
      await runtime.close();
      await server.close();
    }
  });

  it('omits preservation claims and writes no previous-session.json when hosted capture is disabled', async () => {
    const dir = makeTempProject();
    const server = await startCaptureServer(dir);
    const runtime = await openHosted(dir, server.url, false);
    const conn = {};
    try {
      await callHosted(runtime, dir, conn, 'auth.actAsAnonymous', {});
      await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'kept' },
      });
      await callHosted(runtime, dir, conn, 'sandbox.checkpoint', { name: 'c1' });
      await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'refused' },
      });

      const restored = await callHosted(runtime, dir, conn, 'sandbox.restore', {
        name: 'c1',
        confirm: true,
      });
      expect(restored.ok).toBe(true);
      expect(restored.summary).not.toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect((restored.data as { previousCapture?: unknown }).previousCapture).toBeUndefined();
      expect(existsSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH))).toBe(false);

      await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/b',
        data: { state: 'refused' },
      });
      const resetResult = await callHosted(runtime, dir, conn, 'sandbox.reset', {
        scope: 'all',
        confirm: true,
      });
      expect(resetResult.ok).toBe(true);
      expect(resetResult.summary).not.toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect((resetResult.data as { previousCapture?: unknown }).previousCapture).toBeUndefined();
      expect(existsSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH))).toBe(false);
    } finally {
      await runtime.close();
      await server.close();
    }
  });

  it('omits preservation claims when the capture endpoint rejects flush writes', async () => {
    const dir = makeTempProject();
    const failingServer: Server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('capture unavailable');
    });
    await new Promise<void>((resolveReady) => failingServer.listen(0, '127.0.0.1', resolveReady));
    const address = failingServer.address() as AddressInfo;
    const runtime = await openHosted(dir, `http://127.0.0.1:${address.port}`, true);
    const conn = {};
    try {
      await callHosted(runtime, dir, conn, 'auth.actAsAnonymous', {});
      await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/bad',
        data: { state: 'refused' },
      });
      const resetResult = await callHosted(runtime, dir, conn, 'sandbox.reset', {
        scope: 'all',
        confirm: true,
      });
      expect(resetResult.ok).toBe(true);
      expect(resetResult.summary).not.toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect((resetResult.data as { previousCapture?: unknown }).previousCapture).toBeUndefined();
      expect(existsSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH))).toBe(false);
    } finally {
      await runtime.close();
      await new Promise<void>((resolveClose) => failingServer.close(() => resolveClose()));
    }
  });
});
