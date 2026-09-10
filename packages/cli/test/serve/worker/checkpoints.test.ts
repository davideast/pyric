/**
 * Named saved states: drive the worker host's checkpoint / listCheckpoints /
 * restore / deleteCheckpoint ops directly (no SharedWorker runtime), mirroring
 * the auth-lens and security-per-user host tests.
 *
 * The checkpoints themselves are the `pyric/sandbox/checkpoints` module's, and
 * are pinned there. What these pin is the wire: that each op reaches the module
 * with the sandbox and the store this worker owns, and reports what it did.
 */
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

const PERMISSIVE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(msg: OutboundMessage) { messages.push(msg); } };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE);
  await sandbox.enablePersistence({ key: `branch-${Math.random()}`, injectedBackend: createMemoryBackend() });
  getAuth(sandbox);
  const db = getFirestore(sandbox);
  // Checkpoints live in the RAW session backend (local-only), separate from
  // the sandbox's data persistence above.
  return {
    db,
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
    instanceId: 'test-instance',
  };
}

let _seq = 0;
const id = (): string => `branch-op-${++_seq}`;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function getRes(port: FakePort, opId: string): ResMessage | undefined {
  return port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
}
async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  await tick();
  const res = getRes(port, (msg as { id: string }).id);
  if (!res) throw new Error(`No res for ${(msg as { id: string }).id}`);
  return res;
}
function value<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected RPC ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

interface CheckpointListing {
  name: string;
  at: number;
  counts: { firestore: number; database: number; storage: number; auth: number };
}

describe('worker saved states', () => {
  it('save, list, restore (clobber), and delete round-trip', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    ctx.sandbox.admin.setDocument('todos/a', { title: 'first' });
    const saved = value<{ ok: boolean; counts: { firestore: number } }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'checkpoint', name: 'v1' }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.counts.firestore).toBe(1);

    const list1 = value<{ checkpoints: CheckpointListing[] }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'listCheckpoints' }),
    );
    expect(list1.checkpoints.map((entry) => entry.name)).toEqual(['v1']);

    // Diverge, then restore v1 -> clobber (b gone, a restored).
    ctx.sandbox.admin.setDocument('todos/b', { title: 'diverged' });
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'restore', name: 'v1' });
    expect(ctx.sandbox.admin.getDocument('todos/a')).toEqual({ title: 'first' });
    expect(ctx.sandbox.admin.getDocument('todos/b') ?? null).toBeNull();

    // Delete -> list empty.
    const removed = value<{ ok: boolean }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'deleteCheckpoint', name: 'v1' }),
    );
    expect(removed.ok).toBe(true);
    const list2 = value<{ checkpoints: CheckpointListing[] }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'listCheckpoints' }),
    );
    expect(list2.checkpoints).toEqual([]);
  });

  it('restoring an unknown checkpoint reports failure and does NOT clobber', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    ctx.sandbox.admin.setDocument('x/1', { v: 1 });

    const res = value<{ ok: boolean; error?: string }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'restore', name: 'nope' }),
    );
    expect(res.ok).toBe(false);
    expect(ctx.sandbox.admin.getDocument('x/1')).toEqual({ v: 1 });
  });

  it('deleting a checkpoint the worker never held reports that there was none', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const res = value<{ ok: boolean }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'deleteCheckpoint', name: 'nope' }),
    );
    expect(res.ok).toBe(false);
  });

  it('carries every service through a save and a restore', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const auth = getAuth(ctx.sandbox);
    authSandbox.seedUsers(auth, [{ uid: 'alice', email: 'alice@example.com' }]);

    await sendOp(ctx, port, { t: 'op', id: id(), method: 'checkpoint', name: 'peopled' });
    ctx.sandbox.admin.setDocument('todos/after', { title: 'after the save' });
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'restore', name: 'peopled' });

    expect(authSandbox.exportUsers(getAuth(ctx.sandbox)).map((user) => user.uid)).toContain('alice');
    expect(ctx.sandbox.admin.getDocument('todos/after') ?? null).toBeNull();
  });
});
