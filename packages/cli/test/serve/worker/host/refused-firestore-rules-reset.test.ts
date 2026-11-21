/**
 * Issue #1947: a Firestore ruleset production would refuse never becomes the
 * enforced ruleset after a reset. Both `setupWorkerHotReload` (`rules-changed`)
 * and `setRules` / `setFirestoreRules` op frames call `deployFirestoreRulesToHost`,
 * which answers `ok: false` and leaves the sandbox's active rules in force; a
 * later `resetAll` on the worker or `sandbox.reset` (`scope: 'all'` or
 * `'firestore'`) on the Node host must keep those rules in force instead of
 * installing the refused source.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';

import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { openStorageBackend } from '../../../../../pyric/src/storage/persistence.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../../../src/serve/namespace.js';
import { handleMessage, type PortLike } from '../../../../src/serve/worker/host.js';
import type { HostCtx } from '../../../../src/serve/worker/host-context.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../../src/serve/worker/protocol.js';
import { applyServeInit, setupWorkerHotReload, type EventSourceLike } from '../../../../src/serve/worker/serve-init.js';

/** Fails to parse on line 2 ("Firestore rules did not parse at line 2..."). */
const UNPARSEABLE_LINE_2 = `rules_version = '2';
service cloud.firestore {`;

const PAST_COMPILE_LIMIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if ${'('.repeat(98)}request.auth.uid == 'a'${')'.repeat(98)}; }
  }
}`;

const DUPLICATE_SERVICE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

const PUBLIC_ALLOW_PRIVATE_DENY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{id} { allow read, write: if true; }
    match /private/{id} { allow read, write: if false; }
  }
}`;

/** Open match paired with unparseable syntax so production refuses the whole file. */
const REFUSED_OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
    match /broken/{id} { allow read: if ; }
  }
}`;

/** Locked match paired with unparseable syntax so production refuses the whole file. */
const REFUSED_LOCKED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /broken/{id} { allow write: if ; }
  }
}`;

const ACCEPTED_LOCKED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

const ACCEPTED_OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

type OpPayload = Record<string, unknown>;

let workerSeq = 0;
function workerOp(ctx: HostCtx, payload: OpPayload): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    const opId = `refused-fs-${++workerSeq}`;
    void handleMessage(ctx, port, { ...payload, t: 'op', id: opId } as InboundMessage);
  });
}

async function createServedWorker(initialRules: string | null = null): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `refused-fs-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'refused-firestore-rules',
    subs: new Map(),
  };
  const payload = {
    rules: initialRules,
    rulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    permissive: true,
  } as unknown as InitPayload;
  await applyServeInit(ctx, payload);
  return ctx;
}

describe('a refused Firestore ruleset on the worker (#1947)', () => {
  it('keeps default rules in force after hot-reload refusal and resetAll when no earlier rules were deployed', async () => {
    const ctx = await createServedWorker(null);
    const listeners = new Map<string, (ev: { data: string }) => void>();
    const eventSource: EventSourceLike = {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      close() {},
    };
    const stopHotReload = setupWorkerHotReload(ctx, () => eventSource);

    try {
      expect((await workerOp(ctx, { method: 'setDoc', path: 'notes/before', data: { ok: true } })).ok).toBe(true);

      const onRulesChanged = listeners.get('rules-changed');
      expect(typeof onRulesChanged).toBe('function');
      if (onRulesChanged) {
        onRulesChanged({ data: JSON.stringify({ rules: UNPARSEABLE_LINE_2 }) });
      }

      // Refused hot reload leaves writes working immediately.
      expect((await workerOp(ctx, { method: 'setDoc', path: 'notes/during', data: { ok: true } })).ok).toBe(true);

      const status = await workerOp(ctx, { method: 'getRulesStatus', service: 'firestore' });
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.value).toMatchObject({ status: 'error' });
        expect((status.value as { source?: unknown }).source).toBeUndefined();
      }

      // After resetAll, the refused source must NOT be installed.
      expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
      const afterReset = await workerOp(ctx, { method: 'setDoc', path: 'notes/after', data: { ok: true } });
      expect(afterReset.ok).toBe(true);
    } finally {
      stopHotReload();
    }
  });

  it('keeps default rules in force after consecutive parse, compile-limit, and duplicate-service refusals and resetAll when no earlier rules were deployed', async () => {
    const ctx = await createServedWorker(null);
    for (const [method, source] of [
      ['setRules', UNPARSEABLE_LINE_2],
      ['setFirestoreRules', PAST_COMPILE_LIMIT],
      ['setRules', DUPLICATE_SERVICE_RULES],
    ] as const) {
      const refused = await workerOp(ctx, { method, source });
      expect(refused.ok).toBe(true);
      if (refused.ok) {
        expect((refused.value as { ok: boolean }).ok).toBe(false);
      }
      const status = await workerOp(ctx, { method: 'getRulesStatus', service: 'firestore' });
      expect(status.ok).toBe(true);
      if (status.ok) {
        const record = status.value as { status?: unknown; source?: unknown; lastKnownGood?: unknown };
        expect(record.status).toBe('error');
        expect(record.source).toBeUndefined();
        expect(record.lastKnownGood).toBeUndefined();
      }
    }

    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    const write = await workerOp(ctx, { method: 'setDoc', path: 'notes/n1', data: { v: 1 } });
    expect(write.ok).toBe(true);
  });

  it('keeps the last accepted ruleset across consecutive refusals and resetAll', async () => {
    const ctx = await createServedWorker(null);
    const selective = await workerOp(ctx, { method: 'setFirestoreRules', source: PUBLIC_ALLOW_PRIVATE_DENY_RULES });
    expect(selective.ok && (selective.value as { ok: boolean }).ok).toBe(true);

    await workerOp(ctx, { method: 'setFirestoreRules', source: REFUSED_OPEN_RULES });
    await workerOp(ctx, { method: 'setFirestoreRules', source: PAST_COMPILE_LIMIT });

    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    expect((await workerOp(ctx, { method: 'setDoc', path: 'public/1', data: { v: 1 } })).ok).toBe(true);
    const privateDenied = await workerOp(ctx, { method: 'setDoc', path: 'private/1', data: { v: 1 } });
    expect(privateDenied.ok).toBe(false);
    if (!privateDenied.ok) {
      expect(privateDenied.error.code).toBe('permission-denied');
    }

    const accepted = await workerOp(ctx, { method: 'setFirestoreRules', source: ACCEPTED_LOCKED_RULES });
    expect(accepted.ok && (accepted.value as { ok: boolean }).ok).toBe(true);

    await workerOp(ctx, { method: 'setFirestoreRules', source: REFUSED_OPEN_RULES });
    await workerOp(ctx, { method: 'setFirestoreRules', source: UNPARSEABLE_LINE_2 });

    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    const denied = await workerOp(ctx, { method: 'setDoc', path: 'secrets/s1', data: { v: 1 } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('permission-denied');
    }

    const status = await workerOp(ctx, { method: 'getRulesStatus', service: 'firestore' });
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value).toMatchObject({
        status: 'error',
        source: ACCEPTED_LOCKED_RULES,
        lastKnownGood: ACCEPTED_LOCKED_RULES,
      });
    }

    const openAccepted = await workerOp(ctx, { method: 'setFirestoreRules', source: ACCEPTED_OPEN_RULES });
    expect(openAccepted.ok && (openAccepted.value as { ok: boolean }).ok).toBe(true);
    await workerOp(ctx, { method: 'setFirestoreRules', source: REFUSED_LOCKED_RULES });
    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    expect((await workerOp(ctx, { method: 'setDoc', path: 'public/p1', data: { v: 2 } })).ok).toBe(true);
  });
});

describe('a refused Firestore ruleset on the Node host (#1947)', () => {
  interface WorkerRes {
    type: 'worker-res';
    id: string;
    ok: boolean;
    value?: unknown;
    error?: { code?: string; message?: string };
  }

  async function withNodeHost(
    initialRules: string | null,
    run: (helpers: {
      hostOp: (op: OpPayload) => Promise<WorkerRes>;
      reset: (scope?: 'all' | 'firestore') => Promise<boolean>;
    }) => Promise<void>,
  ): Promise<void> {
    const projectDir = import.meta.dir;
    const sent: WorkerRes[] = [];
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-refused-fs-${Math.random()}`),
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
        rules: initialRules,
        rulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: true,
        projectKey: 'refused-firestore',
        sessionToken: 'tok-refused-fs',
      },
      'http://127.0.0.1:4400',
      (msg) => {
        if ((msg as { type?: string }).type === 'worker-res') {
          sent.push(msg as WorkerRes);
        }
      },
      projectDir,
      { persistence: persistence as never, record: false },
    );

    let seq = 0;
    async function hostOp(op: OpPayload): Promise<WorkerRes> {
      const id = `node-fs-${++seq}`;
      runtime.receive({
        type: 'worker-op',
        id,
        clientSessionId: 'app',
        op: { ...op, t: 'op', id },
      });
      for (let i = 0; i < 100; i++) {
        const reply = sent.find((message) => message.id === id);
        if (reply !== undefined) return reply;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no reply to ${String(op.method)}`);
    }

    async function reset(scope?: 'all' | 'firestore'): Promise<boolean> {
      const args: Record<string, unknown> = { confirm: true };
      if (scope !== undefined) {
        args.scope = scope;
      }
      const res = await runtime.runMethod(
        {
          instanceId: runtime.instanceId,
          key: 'sandbox.reset',
          args,
          projectDir,
          allowProduction: true,
        },
        {},
      );
      return res.ok;
    }

    try {
      await run({ hostOp, reset });
    } finally {
      await runtime.close();
    }
  }

  it('stays unenforced after a setRules op frame and sandbox.reset (all and firestore scopes) when no rules were deployed', async () => {
    await withNodeHost(null, async ({ hostOp, reset }) => {
      expect((await hostOp({ method: 'setDoc', path: 'notes/n0', data: { v: 0 } })).ok).toBe(true);

      const refused = await hostOp({ method: 'setRules', source: UNPARSEABLE_LINE_2 });
      expect(refused.ok).toBe(true);
      if (refused.ok) {
        expect((refused.value as { ok: boolean }).ok).toBe(false);
      }
      expect((await hostOp({ method: 'setDoc', path: 'notes/n1', data: { v: 1 } })).ok).toBe(true);

      expect(await reset('all')).toBe(true);
      const afterAllReset = await hostOp({ method: 'setDoc', path: 'notes/n2', data: { v: 2 } });
      expect(afterAllReset.ok).toBe(true);

      await hostOp({ method: 'setFirestoreRules', source: UNPARSEABLE_LINE_2 });
      expect(await reset('firestore')).toBe(true);
      const afterFirestoreReset = await hostOp({ method: 'setDoc', path: 'notes/n3', data: { v: 3 } });
      expect(afterFirestoreReset.ok).toBe(true);
    });
  });

  it('keeps the last accepted ruleset after a refused setRules op frame and sandbox.reset', async () => {
    await withNodeHost(null, async ({ hostOp, reset }) => {
      const accepted = await hostOp({ method: 'setRules', source: ACCEPTED_LOCKED_RULES });
      expect(accepted.ok && (accepted.value as { ok: boolean }).ok).toBe(true);

      const refused = await hostOp({ method: 'setRules', source: REFUSED_OPEN_RULES });
      expect(refused.ok && (refused.value as { ok: boolean }).ok).toBe(false);

      expect(await reset('all')).toBe(true);
      const denied = await hostOp({ method: 'setDoc', path: 'secrets/s1', data: { v: 1 } });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe('permission-denied');
    });
  });
});
