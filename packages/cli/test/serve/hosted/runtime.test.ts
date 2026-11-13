/**
 * 1:1 unit tests for `serve/hosted/runtime.ts` (`observedSession` wiring, #2540):
 * verifies that `createHostedRuntime` threads `runtimeOptions.observedSession`
 * onto the worker `HostCtx` so observed live calls evaluate local Firestore and
 * Realtime Database rules against session-observed state.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleRecords, createMemoryBackend, serializeToBuckets, type PersistenceBackend } from 'pyric/sandbox';
import { recordCheckpointBackend } from 'pyric/sandbox/checkpoints';
import { openStorageBackend } from '../../../../pyric/src/storage/persistence.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { createObservedSessionDataStore } from '../../../src/serve/observed-session/store.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /groups/{g}/posts/{p} {
      allow create: if request.auth != null
        && request.auth.uid in get(/databases/$(database)/documents/groups/$(g)).data.members;
    }
  }
}`;

const RTDB_RULES = {
  rules: {
    groups: {
      $g: {
        posts: {
          $p: {
            '.write': "auth != null && root.child('groups/' + $g + '/members/' + auth.uid).val() === true",
          },
        },
      },
    },
  },
};

describe('createHostedRuntime observedSession wiring (#2540)', () => {
  it('evaluates observed live Firestore and RTDB calls against runtimeOptions.observedSession', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-runtime-obs-'));
    const frames: BridgeMessage[] = [];
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-hosted-obs-${Math.random()}`),
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
        rules: FIRESTORE_RULES,
        rulesHash: null,
        databaseRules: RTDB_RULES,
        databaseRulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: false,
        projectKey: 'hosted-runtime-obs',
        sessionToken: 'tok-hosted-obs',
        appOptions: { projectId: 'demo-project' },
      },
      'http://127.0.0.1:4400',
      (msg) => frames.push(msg),
      dir,
      { persistence: persistence as never, record: false, observedSession },
    );

    try {
      await runtime.deployRules('database', JSON.stringify(RTDB_RULES), 'demo-project-default-rtdb');

      observedSession.apply(
        {
          firestore: [
            { kind: 'set', path: 'groups/g-1', data: { members: ['u-1'] } },
            { kind: 'delete', path: 'groups/g-1/posts/p-1' },
          ],
          rtdb: [
            {
              kind: 'set',
              instance: 'demo-project-default-rtdb',
              path: '/groups/g-1/members/u-1',
              value: true,
            },
          ],
        },
        'demo-project',
        'client',
      );

      const waitForReply = async (id: string) => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const hit = frames.find(
            (f) =>
              f.type === 'worker-message-result' &&
              (f.message as { id?: string }).id === id,
          );
          if (hit !== undefined) return hit;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for worker reply ${id}`);
      };

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'c-1',
        message: {
          t: 'observe',
          id: 'obs-fs-1',
          call: {
            service: 'firestore',
            method: 'setDoc',
            path: 'groups/g-1/posts/p-1',
            writeData: { title: 'Hello' },
            at: 10,
            outcome: { status: 'ok' },
            account: { uid: 'u-1' },
          },
        },
      } as unknown as BridgeMessage);
      await waitForReply('obs-fs-1');

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'c-1',
        message: {
          t: 'observe',
          id: 'obs-rtdb-1',
          call: {
            service: 'rtdb',
            method: 'set',
            instance: 'demo-project-default-rtdb',
            projectId: 'demo-project',
            path: '/groups/g-1/posts/p-1',
            writeData: { title: 'Hello' },
            at: 20,
            outcome: { status: 'ok' },
            account: { uid: 'u-1' },
          },
        },
      } as unknown as BridgeMessage);
      await waitForReply('obs-rtdb-1');

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'c-1',
        message: {
          t: 'sub',
          subId: 'sub-events-1',
          target: 'events',
        },
      } as unknown as BridgeMessage);

      const deadline = Date.now() + 3_000;
      let eventFrame: BridgeMessage | undefined;
      while (Date.now() < deadline && eventFrame === undefined) {
        eventFrame = frames.find(
          (f) =>
            f.type === 'worker-message-result' &&
            (f.message as { t?: string; subId?: string }).t === 'event' &&
            (f.message as { subId?: string }).subId === 'sub-events-1',
        );
        if (eventFrame === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const events = (
        eventFrame?.message as {
          events?: Array<{ service: string; production?: { local?: { result: string } } }>;
        }
      )?.events ?? [];

      expect(events.find((e) => e.service === 'firestore')?.production?.local?.result).toBe('allow');
      expect(events.find((e) => e.service === 'rtdb')?.production?.local?.result).toBe('allow');
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createHostedRuntime RTDB active rules sync', () => {
  it('synchronizes default RTDB active rules on sandbox.promote and sandbox.restore and preserves them across sandbox.reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-runtime-rtdb-sync-'));
    const frames: BridgeMessage[] = [];
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-hosted-rtdb-sync-${Math.random()}`),
      checkpoints: recordCheckpointBackend(createMemoryBackend()),
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    };

    const initialRtdbRules = {
      rules: {
        items: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    };

    const runtime = await createHostedRuntime(
      {
        rules: FIRESTORE_RULES,
        rulesHash: null,
        databaseRules: initialRtdbRules,
        databaseRulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: false,
        projectKey: 'hosted-runtime-rtdb-sync',
        sessionToken: 'tok-hosted-rtdb-sync',
        appOptions: { projectId: 'demo-project' },
      },
      'http://127.0.0.1:4400',
      (msg) => frames.push(msg),
      dir,
      { persistence: persistence as never, record: false },
    );

    const conn = {};
    const queryActiveRtdbRules = async (id: string) => {
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'c-rtdb-1',
        message: {
          t: 'op',
          id,
          method: 'getActiveRules',
          service: 'database',
        },
      } as unknown as BridgeMessage);
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const hit = frames.find(
          (f) =>
            f.type === 'worker-message-result' &&
            (f.message as { id?: string }).id === id,
        );
        if (hit !== undefined) {
          return (hit.message as { value?: { source?: { rules?: Record<string, unknown> } } }).value;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${id}`);
    };

    try {
      await runtime.runMethod({ key: 'auth.impersonate', args: { uid: 'u1' }, projectDir: dir }, conn);

      const forkRes = await runtime.runMethod(
        {
          key: 'sandbox.fork',
          args: {
            branch: 'lock-rtdb',
            candidateRules: { database: { rules: { '.read': false, '.write': false } } },
          },
          projectDir: dir,
        },
        conn,
      );
      expect(forkRes.ok).toBe(true);

      const promoteRes = await runtime.runMethod(
        {
          key: 'sandbox.promote',
          args: { branch: 'lock-rtdb', confirm: true },
          projectDir: dir,
        },
        conn,
      );
      expect(promoteRes.ok).toBe(true);

      const activeAfterPromote = await queryActiveRtdbRules('active-after-promote');
      expect(activeAfterPromote?.source?.rules?.['.write']).toBe(false);

      await runtime.runMethod(
        { key: 'sandbox.checkpoint', args: { name: 'locked-cp' }, projectDir: dir },
        conn,
      );

      await runtime.runMethod(
        { key: 'sandbox.reset', args: { scope: 'all', confirm: true }, projectDir: dir },
        conn,
      );
      await runtime.runMethod({ key: 'auth.impersonate', args: { uid: 'u1' }, projectDir: dir }, conn);
      const afterResetWrite = await runtime.runMethod(
        { key: 'database.set', args: { path: 'items/afterReset', value: { count: 1 } }, projectDir: dir },
        conn,
      );
      expect(afterResetWrite.ok).toBe(false);

      await runtime.runMethod(
        {
          key: 'rules.set',
          args: { service: 'database', rules: JSON.stringify(initialRtdbRules) },
          projectDir: dir,
        },
        conn,
      );
      const restoreRes = await runtime.runMethod(
        { key: 'sandbox.restore', args: { name: 'locked-cp', confirm: true }, projectDir: dir },
        conn,
      );
      expect(restoreRes.ok).toBe(true);

      const activeAfterRestore = await queryActiveRtdbRules('active-after-restore');
      expect(activeAfterRestore?.source?.rules?.['.write']).toBe(false);

      await runtime.runMethod(
        { key: 'sandbox.reset', args: { scope: 'all', confirm: true }, projectDir: dir },
        conn,
      );
      await runtime.runMethod({ key: 'auth.impersonate', args: { uid: 'u1' }, projectDir: dir }, conn);
      const afterRestoreResetWrite = await runtime.runMethod(
        { key: 'database.set', args: { path: 'items/afterRestoreReset', value: { count: 2 } }, projectDir: dir },
        conn,
      );
      expect(afterRestoreResetWrite.ok).toBe(false);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createHostedRuntime group commit', () => {
  it('coalesces concurrent RTDB writes into at most one in-flight and one queued commit without early acks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-group-commit-'));
    const frames: BridgeMessage[] = [];
    const storage = createMemoryBackend();
    const gates: Array<{ release: () => void }> = [];
    let holdCommits = false;
    let commitCount = 0;

    const backend: PersistenceBackend = {
      ...storage,
      retryFailedFlush: false,
      async applyChanges(key, changed, removed) {
        commitCount += 1;
        if (holdCommits) {
          const gate = Promise.withResolvers<void>();
          gates.push({ release: gate.resolve });
          await gate.promise;
        }
        await storage.putRecords(key, changed);
        await storage.deleteRecords(key, removed);
      },
    };

    const makePersistence = () => ({
      backend,
      storage: undefined as never,
      checkpoints: recordCheckpointBackend(createMemoryBackend()),
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    });

    const storageBackend = await openStorageBackend(`mem-hosted-gc-${Math.random()}`);
    const initPayload = {
      rules: null,
      rulesHash: null,
      databaseRules: { rules: { '.read': true, '.write': true } },
      databaseRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      permissive: true,
      projectKey: 'hosted-group-commit',
      sessionToken: 'tok-hosted-gc',
      appOptions: { projectId: 'demo-project' },
    };

    const runtime = await createHostedRuntime(
      initPayload,
      'http://127.0.0.1:4400',
      (msg) => frames.push(msg),
      dir,
      { persistence: { ...makePersistence(), storage: storageBackend } as never, record: false },
    );

    const findReply = (id: string) =>
      frames.find(
        (f) =>
          f.type === 'worker-message-result' &&
          (f.message as { t?: string; id?: string }).t === 'res' &&
          (f.message as { id?: string }).id === id,
      ) as { message: { ok: boolean; value?: unknown; error?: { code?: string } } } | undefined;

    const waitForReply = async (id: string) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const hit = findReply(id);
        if (hit !== undefined) return hit.message;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${id}`);
    };

    const waitUntil = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('Timed out waiting for condition');
    };

    try {
      // 1. Same-turn burst of 4 writes across 4 sessions coalesces into fewer than 4 commits.
      for (let i = 1; i <= 4; i++) {
        runtime.receive({
          type: 'worker-message',
          clientSessionId: `burst-${i}`,
          message: { t: 'op', id: `b-${i}`, method: 'rtdb.set', path: `/burst/k${i}`, value: i },
        } as unknown as BridgeMessage);
      }
      for (let i = 1; i <= 4; i++) {
        expect((await waitForReply(`b-${i}`)).ok).toBe(true);
      }
      expect(commitCount).toBeLessThan(4);

      // 2. While 1 commit is held in flight, 4 concurrent writes queue into a single 2nd commit.
      commitCount = 0;
      holdCommits = true;

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 's-1',
        message: { t: 'op', id: 'w-1', method: 'rtdb.set', path: '/items/one', value: { v: 1 } },
      } as unknown as BridgeMessage);

      await waitUntil(() => gates.length === 1);
      expect(findReply('w-1')).toBeUndefined();

      for (let i = 2; i <= 5; i++) {
        runtime.receive({
          type: 'worker-message',
          clientSessionId: `s-${i}`,
          message: { t: 'op', id: `w-${i}`, method: 'rtdb.set', path: `/items/k${i}`, value: { v: i } },
        } as unknown as BridgeMessage);
      }
      for (let turn = 0; turn < 5; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Only 1 commit in flight; none of w-1..w-5 acknowledged yet.
      expect(gates.length).toBe(1);
      for (let i = 1; i <= 5; i++) {
        expect(findReply(`w-${i}`)).toBeUndefined();
      }

      // Release commit #1: w-1 acks; w-2..w-5 wait on single queued commit #2.
      gates[0]!.release();
      expect((await waitForReply('w-1')).ok).toBe(true);
      await waitUntil(() => gates.length === 2);
      for (let i = 2; i <= 5; i++) {
        expect(findReply(`w-${i}`)).toBeUndefined();
      }

      // Release commit #2: all of w-2..w-5 ack; total commits === 2 (not 5).
      gates[1]!.release();
      for (let i = 2; i <= 5; i++) {
        expect((await waitForReply(`w-${i}`)).ok).toBe(true);
      }
      for (let turn = 0; turn < 5; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(commitCount).toBe(2);
      holdCommits = false;
    } finally {
      holdCommits = false;
      for (const gate of gates) gate.release();
      await runtime.close();
    }

    // 3. Cold reload reproduces all acknowledged writes.
    const reloadFrames: BridgeMessage[] = [];
    const reloaded = await createHostedRuntime(
      initPayload,
      'http://127.0.0.1:4400',
      (msg) => reloadFrames.push(msg),
      dir,
      {
        persistence: {
          ...makePersistence(),
          backend: storage,
          storage: await openStorageBackend(`mem-hosted-gc-reload-${Math.random()}`),
        } as never,
        record: false,
      },
    );
    try {
      reloaded.receive({
        type: 'worker-message',
        clientSessionId: 'reader',
        message: { t: 'op', id: 'read-items', method: 'rtdb.get', path: '/items' },
      } as unknown as BridgeMessage);
      const deadline = Date.now() + 3_000;
      let reply: { ok: boolean; value?: { value?: unknown } } | undefined;
      while (Date.now() < deadline && reply === undefined) {
        const hit = reloadFrames.find(
          (f) =>
            f.type === 'worker-message-result' &&
            (f.message as { id?: string }).id === 'read-items',
        );
        if (hit !== undefined) reply = (hit as { message: typeof reply }).message;
        else await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reply?.ok).toBe(true);
      expect(reply?.value?.value).toEqual({
        one: { v: 1 },
        k2: { v: 2 },
        k3: { v: 3 },
        k4: { v: 4 },
        k5: { v: 5 },
      });
    } finally {
      await reloaded.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a failed shared flush to every caller it covered and latches persistence unhealthy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-gc-fail-'));
    const frames: BridgeMessage[] = [];
    const storage = createMemoryBackend();
    const gates: Array<{ release: () => void }> = [];
    let holdFirst = true;
    let failSecond = false;
    let healthy = true;
    let markedUnhealthyCount = 0;

    const backend: PersistenceBackend = {
      ...storage,
      retryFailedFlush: false,
      async applyChanges(key, changed, removed) {
        if (holdFirst) {
          holdFirst = false;
          const gate = Promise.withResolvers<void>();
          gates.push({ release: gate.resolve });
          await gate.promise;
        } else if (failSecond) {
          throw new Error('simulated sqlite ioerr');
        }
        await storage.putRecords(key, changed);
        await storage.deleteRecords(key, removed);
      },
    };

    const persistence = {
      backend,
      storage: await openStorageBackend(`mem-hosted-gc-fail-${Math.random()}`),
      checkpoints: recordCheckpointBackend(createMemoryBackend()),
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: (healthy ? 'healthy' : 'unhealthy') as 'healthy' | 'unhealthy' }),
      onFailure: () => () => {},
      markUnhealthy() {
        healthy = false;
        markedUnhealthyCount += 1;
      },
    };

    const runtime = await createHostedRuntime(
      {
        rules: null,
        rulesHash: null,
        databaseRules: { rules: { '.read': true, '.write': true } },
        databaseRulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: true,
        projectKey: 'hosted-gc-fail',
        sessionToken: 'tok-hosted-gc-fail',
        appOptions: { projectId: 'demo-project' },
      },
      'http://127.0.0.1:4400',
      (msg) => frames.push(msg),
      dir,
      { persistence: persistence as never, record: false },
    );

    const waitForReply = async (id: string) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const reply = frames.find(
          (f) =>
            f.type === 'worker-message-result' &&
            (f.message as { t?: string; id?: string }).t === 'res' &&
            (f.message as { id?: string }).id === id,
        ) as { message: { ok: boolean; error?: { code?: string } } } | undefined;
        if (reply !== undefined) return reply.message;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${id}`);
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 's-1',
        message: { t: 'op', id: 'ok-1', method: 'rtdb.set', path: '/items/a', value: 1 },
      } as unknown as BridgeMessage);

      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && gates.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(gates.length).toBe(1);

      failSecond = true;
      for (const idx of [2, 3, 4]) {
        runtime.receive({
          type: 'worker-message',
          clientSessionId: `s-${idx}`,
          message: { t: 'op', id: `fail-${idx}`, method: 'rtdb.set', path: `/items/k${idx}`, value: idx },
        } as unknown as BridgeMessage);
      }
      for (let turn = 0; turn < 5; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      gates[0]!.release();
      expect((await waitForReply('ok-1')).ok).toBe(true);

      for (const idx of [2, 3, 4]) {
        const res = await waitForReply(`fail-${idx}`);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('committed-but-not-durable');
      }
      expect(markedUnhealthyCount).toBe(1);
      expect(healthy).toBe(false);

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 's-5',
        message: { t: 'op', id: 'after-unhealthy', method: 'rtdb.set', path: '/items/k5', value: 5 },
      } as unknown as BridgeMessage);
      const blocked = await waitForReply('after-unhealthy');
      expect(blocked.ok).toBe(false);
      expect(blocked.error?.code).toBe('persistence-unhealthy');
    } finally {
      console.error = originalConsoleError;
      for (const gate of gates) gate.release();
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createHostedRuntime state import and checkpoint rule preservation', () => {
  it('applies imported v4 record-bundle RTDB rules across default and named instances and preserves named-instance rules across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-v4-import-'));
    const frames: BridgeMessage[] = [];
    const backend = createMemoryBackend();
    const makePersistence = async () => ({
      backend,
      storage: await openStorageBackend(`mem-hosted-v4-imp-${Math.random()}`),
      checkpoints: recordCheckpointBackend(createMemoryBackend()),
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    });

    const runtime = await createHostedRuntime(
      {
        rules: FIRESTORE_RULES,
        rulesHash: null,
        databaseRules: { rules: { '.read': false, '.write': false } },
        databaseRulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: false,
        projectKey: 'hosted-v4-import',
        sessionToken: 'tok-hosted-v4-import',
        appOptions: { projectId: 'demo-project' },
      },
      'http://127.0.0.1:4400',
      (msg) => frames.push(msg),
      dir,
      { persistence: (await makePersistence()) as never, record: false },
    );

    const sendWorkerOp = async (
      targetRuntime: Awaited<ReturnType<typeof createHostedRuntime>>,
      targetFrames: BridgeMessage[],
      opId: string,
      op: Record<string, unknown>,
    ) => {
      targetRuntime.receive({
        type: 'worker-message',
        clientSessionId: 'c-v4-imp',
        message: { t: 'op', id: opId, ...op },
      } as unknown as BridgeMessage);
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const hit = targetFrames.find(
          (f) =>
            f.type === 'worker-message-result' &&
            (f.message as { t?: string; id?: string }).t === 'res' &&
            (f.message as { id?: string }).id === opId,
        ) as { message: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } } } | undefined;
        if (hit !== undefined) return hit.message;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${opId}`);
    };

    const v4Bundle = bundleRecords(
      serializeToBuckets(
        {},
        {
          rtdb: {
            '.pyricRtdbPersistence': 1,
            data: { items: { item1: { label: 'Alpha', qty: 7 } } },
            priorities: { '/items': 3, '/items/item1': 'p-item1' },
            rules: {
              rules: {
                items: {
                  '.read': "auth != null && auth.uid === 'alice'",
                  '.write': "auth != null && auth.uid === 'alice'",
                },
              },
            },
            instances: {
              'secondary-db': {
                '.pyricRtdbPersistence': 1,
                data: { logs: { e1: { ok: true } } },
                priorities: { '/logs/e1': 42 },
                rules: {
                  rules: {
                    logs: {
                      '.read': "auth != null && auth.uid === 'alice'",
                      '.write': false,
                    },
                  },
                },
              },
            },
          },
        },
        1700000000000,
      ),
    );

    try {
      await sendWorkerOp(runtime, frames, 'pre-touch-sec', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: '/logs/e1',
        actAs: { mode: 'admin' },
      });

      const imported = await sendWorkerOp(runtime, frames, 'imp-v4-1', {
        method: 'importState',
        bundle: v4Bundle,
      });
      expect(imported.ok).toBe(true);

      const aliceReadDefault = await sendWorkerOp(runtime, frames, 'read-def-alice', {
        method: 'rtdb.get',
        path: '/items/item1',
        actAs: { mode: 'as', uid: 'alice' },
      });
      expect(aliceReadDefault.ok).toBe(true);
      expect(aliceReadDefault.value).toMatchObject({
        value: { label: 'Alpha', qty: 7 },
        priority: 'p-item1',
      });

      const bobReadDefault = await sendWorkerOp(runtime, frames, 'read-def-bob', {
        method: 'rtdb.get',
        path: '/items/item1',
        actAs: { mode: 'as', uid: 'bob' },
      });
      expect(bobReadDefault.ok).toBe(false);

      const aliceReadSec = await sendWorkerOp(runtime, frames, 'read-sec-alice', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: '/logs/e1',
        actAs: { mode: 'as', uid: 'alice' },
      });
      expect(aliceReadSec.ok).toBe(true);
      expect(aliceReadSec.value).toMatchObject({
        value: { ok: true },
        priority: 42,
      });

      const bobReadSec = await sendWorkerOp(runtime, frames, 'read-sec-bob', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: '/logs/e1',
        actAs: { mode: 'as', uid: 'bob' },
      });
      expect(bobReadSec.ok).toBe(false);

      await runtime.close();

      // Reopening from persisted v4 records adopts secondary-db's persisted rules on first client access.
      const frames2: BridgeMessage[] = [];
      const reopened = await createHostedRuntime(
        {
          rules: FIRESTORE_RULES,
          rulesHash: null,
          bridgeUrl: null,
          seed: null,
          capture: false,
          hosted: true,
          permissive: false,
          projectKey: 'hosted-v4-import',
          sessionToken: 'tok-hosted-v4-import',
          appOptions: { projectId: 'demo-project' },
        },
        'http://127.0.0.1:4400',
        (msg) => frames2.push(msg),
        dir,
        { persistence: (await makePersistence()) as never, record: false },
      );
      try {
        const reopenedSec = await sendWorkerOp(reopened, frames2, 'reopen-sec-alice', {
          method: 'rtdb.get',
          instance: 'secondary-db',
          path: '/logs/e1',
          actAs: { mode: 'as', uid: 'alice' },
        });
        expect(reopenedSec.ok).toBe(true);
        expect(reopenedSec.value).toMatchObject({ value: { ok: true }, priority: 42 });

        const reopenedSecBob = await sendWorkerOp(reopened, frames2, 'reopen-sec-bob', {
          method: 'rtdb.get',
          instance: 'secondary-db',
          path: '/logs/e1',
          actAs: { mode: 'as', uid: 'bob' },
        });
        expect(reopenedSecBob.ok).toBe(false);
      } finally {
        await reopened.close();
      }
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores multi-instance and raw-tree checkpoints in the hosted store with named-instance rules synchronized', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-hosted-cp-rules-'));
    const frames: BridgeMessage[] = [];
    const backend = createMemoryBackend();
    const checkpoints = recordCheckpointBackend(createMemoryBackend());
    const persistence = {
      backend,
      storage: await openStorageBackend(`mem-hosted-cp-rules-${Math.random()}`),
      checkpoints,
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    };

    await checkpoints.write('multi-instance-cp', {
      format: 'pyric-checkpoint-v1',
      at: 1700000001000,
      counts: { firestore: 1, database: 2, storage: 0, auth: 0 },
      state: {
        firestore: { 'notes/n1': { title: 'Saved note' } },
        database: {
          '.pyricRtdbPersistence': 1,
          data: { items: { k1: { name: 'Saved item' } } },
          priorities: { '/items/k1': 'prio-k1' },
          instances: {
            'secondary-db': {
              '.pyricRtdbPersistence': 1,
              data: { events: { ev1: { seq: 11 } } },
              priorities: { '/events/ev1': 77 },
            },
          },
        },
        storage: [],
        auth: { users: [], providers: { password: true, anonymous: true } },
        rules: {
          firestore: FIRESTORE_RULES,
          database: {
            rules: {
              items: {
                '.read': "auth != null && auth.uid === 'alice'",
                '.write': "auth != null && auth.uid === 'alice'",
              },
            },
          },
          databaseInstances: {
            'secondary-db': {
              rules: {
                events: {
                  '.read': "auth != null && auth.uid === 'alice'",
                  '.write': false,
                },
              },
            },
          },
          storage: null,
        },
      },
    });

    await checkpoints.write('raw-tree-cp', {
      format: 'pyric-checkpoint-v1',
      at: 1700000002000,
      counts: { firestore: 0, database: 1, storage: 0, auth: 0 },
      state: {
        firestore: {},
        database: { items: { raw1: { count: 9 } } },
        storage: [],
        auth: { users: [], providers: { password: true } },
        rules: {
          firestore: '',
          database: {
            rules: {
              items: {
                '.read': "auth != null && auth.uid === 'alice'",
                '.write': false,
              },
            },
          },
          storage: null,
        },
      },
    });

    const runtime = await createHostedRuntime(
      {
        rules: FIRESTORE_RULES,
        rulesHash: null,
        databaseRules: { rules: { '.read': false, '.write': false } },
        databaseRulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: false,
        projectKey: 'hosted-cp-rules',
        sessionToken: 'tok-hosted-cp-rules',
        appOptions: { projectId: 'demo-project' },
      },
      'http://127.0.0.1:4400',
      (msg) => frames.push(msg),
      dir,
      { persistence: persistence as never, record: false },
    );

    const sendWorkerOp = async (opId: string, op: Record<string, unknown>) => {
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'c-cp-rules',
        message: { t: 'op', id: opId, ...op },
      } as unknown as BridgeMessage);
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const hit = frames.find(
          (f) =>
            f.type === 'worker-message-result' &&
            (f.message as { t?: string; id?: string }).t === 'res' &&
            (f.message as { id?: string }).id === opId,
        ) as { message: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } } } | undefined;
        if (hit !== undefined) return hit.message;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${opId}`);
    };

    try {
      await sendWorkerOp('cp-pre-touch-sec', {
        method: 'rtdb.set',
        instance: 'secondary-db',
        path: '/events/diverged',
        value: 1,
        actAs: { mode: 'admin' },
      });

      const restoreRes = await runtime.runMethod(
        { key: 'sandbox.restore', args: { name: 'multi-instance-cp', confirm: true }, projectDir: dir },
        {},
      );
      expect(restoreRes.ok, restoreRes.summary).toBe(true);

      const aliceDef = await sendWorkerOp('cp-def-alice', {
        method: 'rtdb.get',
        path: '/items/k1',
        actAs: { mode: 'as', uid: 'alice' },
      });
      expect(aliceDef.ok).toBe(true);
      expect(aliceDef.value).toMatchObject({ value: { name: 'Saved item' }, priority: 'prio-k1' });

      const aliceSec = await sendWorkerOp('cp-sec-alice', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: '/events/ev1',
        actAs: { mode: 'as', uid: 'alice' },
      });
      expect(aliceSec.ok).toBe(true);
      expect(aliceSec.value).toMatchObject({ value: { seq: 11 }, priority: 77 });

      const bobSec = await sendWorkerOp('cp-sec-bob', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: '/events/ev1',
        actAs: { mode: 'as', uid: 'bob' },
      });
      expect(bobSec.ok).toBe(false);

      const workerRestore = await sendWorkerOp('cp-worker-restore-raw', {
        method: 'restore',
        name: 'raw-tree-cp',
      });
      expect(workerRestore.ok).toBe(true);

      const secLockedAfterRaw = await sendWorkerOp('cp-raw-sec-alice', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: '/events/ev1',
        actAs: { mode: 'as', uid: 'alice' },
      });
      expect(secLockedAfterRaw.ok).toBe(false);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
