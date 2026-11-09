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
import { createMemoryBackend } from 'pyric/sandbox';
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
