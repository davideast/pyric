/**
 * Unit tests for `serve/hosted/capture-preservation.ts` through real
 * `createHostedRuntime` + live HTTP `/__pyric/capture` without manual
 * `store.write` calls.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { recordCheckpointBackend } from 'pyric/sandbox/checkpoints';
import { openStorageBackend } from '../../../../pyric/src/storage/persistence.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
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

async function openHosted(
  projectDir: string,
  baseUrl: string,
  capture: boolean,
  onMessage: (message: BridgeMessage) => void = () => {},
): Promise<HostedRuntime> {
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
    onMessage,
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

  it('preserves previous-session.json across hosted reset and restore while an active Firestore onSnapshot listener stays live', async () => {
    const dir = makeTempProject();
    const server = await startCaptureServer(dir);
    const frames: BridgeMessage[] = [];
    const runtime = await openHosted(dir, server.url, true, (frame) => frames.push(frame));
    const conn = {};
    const snapFramesFor = (subId: string) =>
      frames.filter(
        (frame) =>
          frame.type === 'worker-message-result' &&
          typeof frame.message === 'object' &&
          frame.message !== null &&
          (frame.message as { t?: string; subId?: string }).t === 'snap' &&
          (frame.message as { t?: string; subId?: string }).subId === subId,
      );
    const waitForSnapCount = async (subId: string, minCount: number) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (snapFramesFor(subId).length >= minCount) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${minCount} snapshots on ${subId}`);
    };
    try {
      await callHosted(runtime, dir, conn, 'auth.actAsAnonymous', {});
      await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'base' },
      });
      const cp = await callHosted(runtime, dir, conn, 'sandbox.checkpoint', { name: 'c1' });
      expect(cp.ok).toBe(true);

      // Attach an active Firestore doc onSnapshot listener over the worker bridge.
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'c-listener',
        message: {
          t: 'sub',
          subId: 'doc-items-a',
          target: { __ref: 'doc', path: 'items/a' },
        },
      } as unknown as BridgeMessage);
      await waitForSnapCount('doc-items-a', 1);

      const deniedBeforeRestore = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'refused' },
      });
      expect(deniedBeforeRestore.ok).toBe(false);

      const snapsBeforeRestore = snapFramesFor('doc-items-a').length;
      const restored = await callHosted(runtime, dir, conn, 'sandbox.restore', {
        name: 'c1',
        confirm: true,
      });
      expect(restored.ok).toBe(true);
      expect(restored.summary).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      const restorePrevPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(existsSync(restorePrevPath)).toBe(true);
      const afterRestorePrev = JSON.parse(readFileSync(restorePrevPath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountOf(afterRestorePrev)).toBeGreaterThanOrEqual(1);

      // Listener re-attached after restore and receives a subsequent live write.
      await waitForSnapCount('doc-items-a', snapsBeforeRestore + 1);
      const snapsAfterRestore = snapFramesFor('doc-items-a').length;
      const liveAfterRestore = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'after-restore' },
      });
      expect(liveAfterRestore.ok).toBe(true);
      await waitForSnapCount('doc-items-a', snapsAfterRestore + 1);

      // Now trigger a denied write and run hosted sandbox.reset while the listener is still open.
      unlinkSync(restorePrevPath);
      const deniedBeforeReset = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'refused' },
      });
      expect(deniedBeforeReset.ok).toBe(false);

      const snapsBeforeReset = snapFramesFor('doc-items-a').length;
      const resetResult = await callHosted(runtime, dir, conn, 'sandbox.reset', {
        scope: 'all',
        confirm: true,
      });
      expect(resetResult.ok).toBe(true);
      expect(resetResult.summary).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(existsSync(restorePrevPath)).toBe(true);
      const afterResetPrev = JSON.parse(readFileSync(restorePrevPath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountOf(afterResetPrev)).toBeGreaterThanOrEqual(1);

      // Listener stays live after reset and delivers post-reset writes.
      await waitForSnapCount('doc-items-a', snapsBeforeReset + 1);
      const snapsAfterReset = snapFramesFor('doc-items-a').length;
      const liveAfterReset = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/a',
        data: { state: 'after-reset' },
      });
      expect(liveAfterReset.ok).toBe(true);
      await waitForSnapCount('doc-items-a', snapsAfterReset + 1);
    } finally {
      await runtime.close();
      await server.close();
    }
  });

  it('rotates previous-session.json and returns previousCapture after hosted reset when a named RTDB instance was written', async () => {
    const dir = makeTempProject();
    const server = await startCaptureServer(dir);
    const runtime = await openHosted(dir, server.url, true);
    const conn = {};
    try {
      const setNamedRules = await callHosted(runtime, dir, conn, 'rules.set', {
        service: 'database',
        instance: 'alt-db',
        rules: JSON.stringify({ rules: { '.read': true, '.write': true } }),
      });
      expect(setNamedRules.ok).toBe(true);

      const fsWrite = await callHosted(runtime, dir, conn, 'firestore.setDoc', {
        path: 'items/before-reset',
        data: { state: 'kept' },
      });
      expect(fsWrite.ok).toBe(true);

      const rtdbWrite = await callHosted(runtime, dir, conn, 'database.set', {
        instance: 'alt-db',
        path: 'nodes/n1',
        value: { ok: true },
      });
      expect(rtdbWrite.ok).toBe(true);

      const resetResult = await callHosted(runtime, dir, conn, 'sandbox.reset', {
        scope: 'all',
        confirm: true,
      });
      expect(resetResult.ok).toBe(true);
      expect(resetResult.summary).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      const resetData = resetResult.data as {
        previousCapture?: { path: string; eventCount: number; denialCount: number };
      };
      const previousCapture = resetData.previousCapture;
      expect(previousCapture).toBeDefined();
      if (!previousCapture) throw new Error('expected previousCapture metadata');
      expect(previousCapture.path).toBe(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(previousCapture.eventCount).toBeGreaterThan(0);

      const previousPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      const activePath = join(dir, CAPTURE_RELATIVE_PATH);
      expect(existsSync(previousPath)).toBe(true);
      expect(existsSync(activePath)).toBe(true);

      const preserved = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      const active = JSON.parse(readFileSync(activePath, 'utf8')) as PyricVerifyFixture;
      expect(preserved.events.length).toBe(previousCapture.eventCount);
      expect(active.events).toHaveLength(0);

      const afterNamed = await callHosted(runtime, dir, conn, 'database.get', {
        instance: 'alt-db',
        path: 'nodes/n1',
      });
      expect(afterNamed.ok).toBe(true);
      expect((afterNamed.data as { exists: boolean }).exists).toBe(false);
    } finally {
      await runtime.close();
      await server.close();
    }
  });
});
