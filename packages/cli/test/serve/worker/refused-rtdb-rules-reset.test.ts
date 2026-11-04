/**
 * Issue #1946: a Realtime Database ruleset production would refuse never
 * becomes the enforced ruleset. `setDatabaseRules` answers `ok: false` and
 * leaves the instance's rules in force; a later reset re-applies those rules,
 * not the refused ones. Driven through the worker's op frames and the Node
 * host's `deployRules` and `sandbox.reset`, with `permissive: false`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryBackend } from 'pyric/sandbox';
import { openStorageBackend } from '../../../../pyric/src/storage/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { applyServeInit } from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';
import type { HostCtx } from '../../../src/serve/worker/host-context.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

/** Open at the root, with an expression that does not compile: production refuses the whole ruleset. */
const REFUSED_OPEN_RULES = JSON.stringify({
  rules: { '.read': true, '.write': true, secrets: { '.read': 'auth.uid ==' } },
});
/** Locked at the root, refused the same way. */
const REFUSED_LOCKED_RULES = JSON.stringify({
  rules: { '.read': false, '.write': false, secrets: { '.write': 'auth.uid ==' } },
});
const ACCEPTED_LOCKED_RULES = JSON.stringify({ rules: { '.read': false, '.write': false } });

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }`;

type Op = Record<string, unknown>;

let opSeq = 0;
function workerOp(ctx: HostCtx, payload: Op): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `refused-${++opSeq}` } as InboundMessage);
  });
}

async function servedWorker(permissive: boolean): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({ key: `refused-${Math.random()}`, injectedBackend: createMemoryBackend() });
  const ctx: HostCtx = { db: getFirestore(sandbox), sandbox, instanceId: 'refused-rtdb-rules', subs: new Map() };
  const payload = {
    rules: FIRESTORE_RULES,
    rulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    permissive,
  } as unknown as InitPayload;
  await applyServeInit(ctx, payload);
  return ctx;
}

const write = { method: 'rtdb.set', instance: undefined, path: 'secrets/a', value: 'leaked' };
const read = { method: 'rtdb.get', instance: undefined, path: 'secrets/a' };

describe('a refused RTDB ruleset on the worker (#1946)', () => {
  it('stays unenforced after resetAll when no rules were deployed', async () => {
    const ctx = await servedWorker(false);
    expect((await workerOp(ctx, write)).ok).toBe(false);

    const deployed = await workerOp(ctx, { method: 'setDatabaseRules', source: REFUSED_OPEN_RULES });
    expect(deployed.ok && (deployed.value as { ok: boolean }).ok).toBe(false);
    expect((await workerOp(ctx, write)).ok).toBe(false);

    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    expect((await workerOp(ctx, write)).ok).toBe(false);
    expect((await workerOp(ctx, read)).ok).toBe(false);
  });

  it('keeps the last accepted ruleset after a second refusal and a reset', async () => {
    const ctx = await servedWorker(false);
    const accepted = await workerOp(ctx, { method: 'setDatabaseRules', source: ACCEPTED_LOCKED_RULES });
    expect(accepted.ok && (accepted.value as { ok: boolean }).ok).toBe(true);
    await workerOp(ctx, { method: 'setDatabaseRules', source: REFUSED_OPEN_RULES });
    await workerOp(ctx, { method: 'setDatabaseRules', source: REFUSED_OPEN_RULES });

    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    expect((await workerOp(ctx, write)).ok).toBe(false);

    const status = await workerOp(ctx, { method: 'getRulesStatus', service: 'database' });
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value).toMatchObject({ status: 'error', source: JSON.parse(ACCEPTED_LOCKED_RULES) });
    }
  });

  it('leaves a permissive instance open after resetAll', async () => {
    const ctx = await servedWorker(true);
    expect((await workerOp(ctx, write)).ok).toBe(true);
    await workerOp(ctx, { method: 'setDatabaseRules', source: REFUSED_LOCKED_RULES });

    expect((await workerOp(ctx, { method: 'resetAll' })).ok).toBe(true);
    expect((await workerOp(ctx, write)).ok).toBe(true);
  });
});

describe('a refused RTDB ruleset on the Node host (#1946)', () => {
  it('stays unenforced after sandbox.reset when no rules were deployed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-refused-rtdb-'));
    const sent: Array<{ id?: string; ok?: boolean }> = [];
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-refused-rtdb-${Math.random()}`),
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
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        permissive: false,
        projectKey: 'refused-rtdb',
        sessionToken: 'tok-refused',
      },
      'http://127.0.0.1:4400',
      (msg) => sent.push(msg as { id?: string; ok?: boolean }),
      dir,
      { persistence: persistence as never, record: false },
    );

    let seq = 0;
    async function hostOp(op: Op): Promise<boolean | undefined> {
      const id = `host-${++seq}`;
      runtime.receive({ type: 'worker-op', id, clientSessionId: 'app', op: { ...op, t: 'op', id } });
      for (let i = 0; i < 100; i++) {
        const reply = sent.find((message) => message.id === id);
        if (reply !== undefined) return reply.ok;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no reply to ${String(op.method)}`);
    }

    try {
      expect(await hostOp(write)).toBe(false);
      await expect(runtime.deployRules('database', REFUSED_OPEN_RULES)).rejects.toThrow('did not compile');
      expect(await hostOp(write)).toBe(false);

      const reset = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.reset', args: { confirm: true }, projectDir: dir, allowProduction: true },
        {},
      );
      expect(reset.ok).toBe(true);
      expect(await hostOp(write)).toBe(false);
      expect(await hostOp(read)).toBe(false);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
