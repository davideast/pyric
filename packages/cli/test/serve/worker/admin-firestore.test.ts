/**
 * Tests for the SharedWorker host's admin-lens Firestore surface
 * (host/admin-firestore.ts) — specifically `admin.readState` SCOPING.
 *
 * WHY THIS EXISTS
 * ---------------
 * `admin.readState` dumps the whole admin-plane store and then narrows it by
 * two caller-supplied scopes:
 *
 *   - `path`     — a PREFIX filter (only paths under it are returned)
 *   - `maxDepth` — a DEPTH filter (only paths with <= maxDepth segments)
 *
 * Both narrowings are pure filter lines in the handler's loop, and a filter
 * that silently stops narrowing is invisible to any test that only asserts
 * "the docs I asked for came back" — the over-broad result still CONTAINS
 * them. So every assertion here is written as an EXCLUSION: the scoped call
 * must NOT return the documents outside its scope.
 *
 * That framing is deliberate. Dropping the prefix filter turns a scoped
 * readState into a full-store dump — Pyric Studio's "read this subtree" and
 * the pyric-admin remote arm would both start handing back the ENTIRE
 * sandbox (every collection, every user's docs) to a caller that asked for
 * one subtree. The unscoped baseline test below pins the other direction:
 * with no scope, everything really is returned, so the exclusions above are
 * proving narrowing rather than an empty store.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

// ─── Helpers ──────────────────────────────────────────────────────────────

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
    },
  };
}

type FakePort = ReturnType<typeof fakePort>;

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if true; }
    }
  }
`;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `admin-firestore-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  const db = getFirestore(sandbox);
  return { db, sandbox, subs: new Map() };
}

let _seq = 0;
function id(): string {
  return `admin-op-${++_seq}`;
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  const opId = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
  if (!res) throw new Error(`No res message for ${opId}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

/** Call `admin.readState` with an optional prefix/depth scope; return its paths. */
async function readState(
  ctx: HostCtx,
  port: FakePort,
  scope: { path?: string; maxDepth?: number } = {},
): Promise<string[]> {
  const res = await sendOp(ctx, port, {
    t: 'op',
    id: id(),
    method: 'admin.readState',
    ...scope,
  } as InboundMessage);
  return Object.keys(okValue<Record<string, unknown>>(res)).sort();
}

// ─── The seeded store ─────────────────────────────────────────────────────
//
// Multiple ROOT collections (users, orders, notes) so a prefix scope has
// something to exclude, each with NESTED docs so a depth scope does too.
//
//   users/alice                (depth 2)
//   users/alice/posts/p1       (depth 4)
//   users/bob                  (depth 2)
//   orders/o1                  (depth 2)
//   orders/o1/items/i1         (depth 4)
//   notes/n1                   (depth 2)

const SEED: Array<[string, Record<string, unknown>]> = [
  ['users/alice', { name: 'alice' }],
  ['users/alice/posts/p1', { title: "alice's post" }],
  ['users/bob', { name: 'bob' }],
  ['orders/o1', { total: 42 }],
  ['orders/o1/items/i1', { sku: 'widget' }],
  ['notes/n1', { text: 'a note' }],
];

const ALL_PATHS = SEED.map(([p]) => p).sort();
const USER_PATHS = ['users/alice', 'users/alice/posts/p1', 'users/bob'];
const NON_USER_PATHS = ['orders/o1', 'orders/o1/items/i1', 'notes/n1'];

async function seed(ctx: HostCtx, port: FakePort): Promise<void> {
  for (const [path, data] of SEED) {
    const res = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'admin.setDocument', path, data,
    });
    expect(res.ok).toBe(true);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('admin.readState — scoping', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
    await seed(ctx, port);
  });

  it('UNSCOPED returns the whole store (baseline for the exclusions below)', async () => {
    expect(await readState(ctx, port)).toEqual(ALL_PATHS);
  });

  it('a PATH prefix returns only the scoped subtree — never the other collections', async () => {
    const paths = await readState(ctx, port, { path: 'users' });

    // Everything under the prefix is present…
    expect(paths).toEqual([...USER_PATHS].sort());
    // …and nothing outside it leaks. This is the assertion that dies if the
    // prefix filter stops narrowing: an unfiltered readState still contains
    // all of USER_PATHS, so only the exclusion can catch it.
    for (const outside of NON_USER_PATHS) {
      expect(paths).not.toContain(outside);
    }
  });

  it('a deeper PATH prefix scopes to a single document subtree', async () => {
    const paths = await readState(ctx, port, { path: 'users/alice' });
    expect(paths).toEqual(['users/alice', 'users/alice/posts/p1']);
    expect(paths).not.toContain('users/bob');
    for (const outside of NON_USER_PATHS) {
      expect(paths).not.toContain(outside);
    }
  });

  it('a prefix matching nothing returns an empty snapshot (not the whole store)', async () => {
    expect(await readState(ctx, port, { path: 'does-not-exist' })).toEqual([]);
  });

  it('maxDepth drops paths deeper than the limit', async () => {
    // Depth is segment count: `users/alice` = 2, `users/alice/posts/p1` = 4.
    const shallow = await readState(ctx, port, { maxDepth: 2 });
    expect(shallow).toEqual(['notes/n1', 'orders/o1', 'users/alice', 'users/bob']);
    expect(shallow).not.toContain('users/alice/posts/p1');
    expect(shallow).not.toContain('orders/o1/items/i1');

    // Raising the limit past the deepest doc lets the nested docs back in.
    expect(await readState(ctx, port, { maxDepth: 4 })).toEqual(ALL_PATHS);
  });

  it('path and maxDepth compose — both narrowings apply together', async () => {
    const paths = await readState(ctx, port, { path: 'users', maxDepth: 2 });
    expect(paths).toEqual(['users/alice', 'users/bob']);
    // The depth scope dropped alice's nested post…
    expect(paths).not.toContain('users/alice/posts/p1');
    // …and the prefix scope dropped the other collections.
    for (const outside of NON_USER_PATHS) {
      expect(paths).not.toContain(outside);
    }
  });
});
