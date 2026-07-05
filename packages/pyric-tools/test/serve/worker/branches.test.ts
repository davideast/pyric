/**
 * Phase 3 (named branches): drive the worker host's saveBranch / listBranches /
 * switchBranch / deleteBranch ops directly (no SharedWorker runtime), mirroring
 * the auth-lens / security-per-user host tests.
 */
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';

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
  // Branches live in the RAW session backend (local-only), separate from the
  // sandbox's data persistence above.
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

describe('worker named branches (Phase 3)', () => {
  it('save -> list -> switch (clobber) -> delete round-trips', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    ctx.sandbox.admin.setDocument('todos/a', { title: 'first' });
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'saveBranch', name: 'v1' });

    const list1 = value<{ branches: string[] }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'listBranches' }),
    );
    expect(list1.branches).toEqual(['v1']);

    // Diverge, then switch back to v1 -> clobber (b gone, a restored).
    ctx.sandbox.admin.setDocument('todos/b', { title: 'diverged' });
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'switchBranch', name: 'v1' });
    expect(ctx.sandbox.admin.getDocument('todos/a')).toEqual({ title: 'first' });
    expect(ctx.sandbox.admin.getDocument('todos/b') ?? null).toBeNull();

    // Delete -> list empty.
    await sendOp(ctx, port, { t: 'op', id: id(), method: 'deleteBranch', name: 'v1' });
    const list2 = value<{ branches: string[] }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'listBranches' }),
    );
    expect(list2.branches).toEqual([]);
  });

  it('switching to an unknown branch reports failure and does NOT clobber', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    ctx.sandbox.admin.setDocument('x/1', { v: 1 });

    const res = value<{ ok: boolean; error?: string }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'switchBranch', name: 'nope' }),
    );
    expect(res.ok).toBe(false);
    expect(ctx.sandbox.admin.getDocument('x/1')).toEqual({ v: 1 });
  });
});
