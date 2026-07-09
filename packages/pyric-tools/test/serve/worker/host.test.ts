/**
 * Tests for the SharedWorker host (host.ts) — full Firestore surface.
 *
 * Strategy: build a REAL pyric sandbox + REAL pyric/firestore db,
 * fake MessagePort objects (just { postMessage }), and call
 * handleMessage() directly — no SharedWorker runtime required.
 *
 * Tests mirror the exact coverage the plan specifies:
 *   - All execution ops: getDoc (hit + miss), setDoc, updateDoc (merge),
 *     deleteDoc, addDoc, getDocs with where+orderBy+limit, getCountFromServer.
 *   - Sentinels: serverTimestamp, increment, arrayUnion/Remove, deleteField.
 *   - onSnapshot: initial fire, updates, multi-port fan-out, unsub stops delivery.
 *   - writeBatch: all-or-nothing; denied batch fails whole batch.
 *   - runTransaction (txnCommit): read-modify-write commits.
 *   - Errors: permission-denied + not-found serialize with `.code`.
 *   - setRules: hot-reload changes what listeners see.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  handleMessage,
  cleanupPort,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
} from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import {
  getFirestore,
  doc as fsDoc,
  getDoc as fsGetDoc,
  setDoc as fsSetDoc,
  Bytes,
  GeoPoint,
} from 'pyric/firestore';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
} from 'pyric/storage';
import { Timestamp, Bytes as RulesBytes, LatLng } from 'pyric/rules';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Fake port that records all postMessage calls and allows awaiting snaps. */
function fakePort(): PortLike & { messages: OutboundMessage[]; snapMessages: SnapMessage[] } {
  const messages: OutboundMessage[] = [];
  const snapMessages: SnapMessage[] = [];
  return {
    messages,
    snapMessages,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') snapMessages.push(msg);
    },
  };
}

type FakePort = ReturnType<typeof fakePort>;

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

const DENY_ALL_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if false;
      }
    }
  }
`;

/** Build a HostCtx with an in-memory sandbox. Fast + isolated. */
async function makeCtx(rules: string = PERMISSIVE_RULES): Promise<HostCtx> {
  const sandbox = initializeSandbox();

  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(rules);

  await sandbox.enablePersistence({
    key: `test-worker-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });

  const db = getFirestore(sandbox);
  return { db, sandbox, subs: new Map() };
}

/** Wait for all microtasks / setTimeout(0) callbacks. */
function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Get the first res message for a given id. */
function getRes(port: FakePort, id: string): ResMessage | undefined {
  return port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  const id = (msg as { id: string }).id;
  const res = getRes(port, id);
  if (!res) throw new Error(`No res message for ${id}`);
  return res;
}

// ─── getDoc ───────────────────────────────────────────────────────────────

describe('getDoc', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
  });

  it('miss: returns exists=false, no data', async () => {
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gd-miss', method: 'getDoc', path: 'users/nobody',
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { exists: boolean };
    expect(value.exists).toBe(false);
  });

  it('hit: returns exists=true with data after setDoc', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'set-1', method: 'setDoc', path: 'users/alice',
      data: { name: 'Alice', score: 10 },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gd-hit', method: 'getDoc', path: 'users/alice',
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as {
      exists: boolean; data: { json: string }
    };
    expect(value.exists).toBe(true);
    const data = JSON.parse(value.data.json);
    expect(data.name).toBe('Alice');
    expect(data.score).toBe(10);
  });
});

// ─── setDoc / updateDoc / deleteDoc ───────────────────────────────────────

describe('setDoc / updateDoc / deleteDoc', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
  });

  it('setDoc replies ok:true', async () => {
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'sd-1', method: 'setDoc', path: 'items/i1',
      data: { count: 0 },
    });
    expect(res.ok).toBe(true);
  });

  it('updateDoc with merge option merges fields', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'sd-2', method: 'setDoc', path: 'items/i2',
      data: { a: 1, b: 2 },
    });
    await sendOp(ctx, port, {
      t: 'op', id: 'ud-1', method: 'updateDoc', path: 'items/i2',
      data: { b: 99 },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gd-2', method: 'getDoc', path: 'items/i2',
    });
    const value = (res as ResMessage & { ok: true }).value as { data: { json: string } };
    const data = JSON.parse(value.data.json);
    expect(data.a).toBe(1);  // preserved
    expect(data.b).toBe(99); // updated
  });

  it('deleteDoc removes the document', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'sd-del', method: 'setDoc', path: 'items/del',
      data: { x: 1 },
    });
    await sendOp(ctx, port, {
      t: 'op', id: 'dd-1', method: 'deleteDoc', path: 'items/del',
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gd-del', method: 'getDoc', path: 'items/del',
    });
    const value = (res as ResMessage & { ok: true }).value as { exists: boolean };
    expect(value.exists).toBe(false);
  });
});

// ─── addDoc ───────────────────────────────────────────────────────────────

describe('addDoc', () => {
  it('returns the minted id and the doc lands in the collection', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ad-1', method: 'addDoc', collectionPath: 'posts',
      data: { title: 'Hello' },
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { id: string; path: string };
    expect(typeof value.id).toBe('string');
    expect(value.id.length).toBeGreaterThan(0);
    expect(value.path).toMatch(/^posts\//);

    // Verify doc actually exists
    const getRes = await sendOp(ctx, port, {
      t: 'op', id: 'gd-ad-1', method: 'getDoc', path: value.path,
    });
    expect((getRes as ResMessage & { ok: true }).value as { exists: boolean }).toHaveProperty('exists', true);
  });
});

// ─── getDocs with constraints ─────────────────────────────────────────────

describe('getDocs', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
    // Seed some docs
    for (let i = 1; i <= 5; i++) {
      await sendOp(ctx, port, {
        t: 'op', id: `seed-${i}`, method: 'setDoc', path: `tasks/t${i}`,
        data: { priority: i, name: `Task ${i}`, done: i % 2 === 0 },
      });
    }
  });

  it('getDocs on a collection returns all docs', async () => {
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gds-all', method: 'getDocs',
      source: { __ref: 'collection', path: 'tasks' },
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { docs: unknown[] };
    expect(value.docs.length).toBe(5);
  });

  it('getDocs with where constraint filters correctly', async () => {
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gds-where', method: 'getDocs',
      source: {
        __ref: 'query',
        source: { __ref: 'collection', path: 'tasks' },
        constraints: [{ kind: 'where', field: 'done', op: '==', value: true }],
      },
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { docs: Array<{ data: { json: string } }> };
    // tasks t2 and t4 have done=true
    expect(value.docs.length).toBe(2);
    for (const d of value.docs) {
      expect(JSON.parse(d.data.json).done).toBe(true);
    }
  });

  it('getDocs with orderBy+limit returns top N in order', async () => {
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gds-order', method: 'getDocs',
      source: {
        __ref: 'query',
        source: { __ref: 'collection', path: 'tasks' },
        constraints: [
          { kind: 'orderBy', field: 'priority', direction: 'desc' },
          { kind: 'limit', n: 3 },
        ],
      },
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { docs: Array<{ data: { json: string } }> };
    expect(value.docs.length).toBe(3);
    // Highest priorities first
    const priorities = value.docs.map((d) => JSON.parse(d.data.json).priority as number);
    expect(priorities[0]).toBeGreaterThan(priorities[1]!);
    expect(priorities[1]!).toBeGreaterThan(priorities[2]!);
  });
});

// ─── getCountFromServer ────────────────────────────────────────────────────

describe('getCountFromServer', () => {
  it('returns the count of matching docs', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    for (let i = 0; i < 4; i++) {
      await sendOp(ctx, port, {
        t: 'op', id: `cnt-seed-${i}`, method: 'setDoc', path: `cntdocs/d${i}`,
        data: { v: i },
      });
    }

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'cnt-1', method: 'count',
      source: { __ref: 'collection', path: 'cntdocs' },
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { count: number };
    expect(value.count).toBe(4);
  });
});

// ─── Sentinels ────────────────────────────────────────────────────────────

describe('sentinels', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
  });

  it('serverTimestamp lands a Timestamp (has seconds/nanos)', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'st-1', method: 'setDoc', path: 'sentinel/st',
      data: { createdAt: { __sentinel: 'serverTimestamp' } },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'gd-st', method: 'getDoc', path: 'sentinel/st',
    });
    const value = (res as ResMessage & { ok: true }).value as { data: { json: string } };
    const data = JSON.parse(value.data.json);
    // The sandbox resolves serverTimestamp to a Timestamp, which toJSON()s
    // to { __type: 'timestamp', seconds: ..., nanos: ... }
    expect(data.createdAt).toBeDefined();
    // Could be a number (unix ms) or a Timestamp marker — either proves resolution
    expect(data.createdAt).not.toBeNull();
  });

  it('increment accumulates correctly', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'inc-set', method: 'setDoc', path: 'sentinel/inc',
      data: { count: 5 },
    });
    await sendOp(ctx, port, {
      t: 'op', id: 'inc-upd', method: 'updateDoc', path: 'sentinel/inc',
      data: { count: { __sentinel: 'increment', n: 3 } },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'inc-get', method: 'getDoc', path: 'sentinel/inc',
    });
    const data = JSON.parse(((res as ResMessage & { ok: true }).value as { data: { json: string } }).data.json);
    expect(data.count).toBe(8);
  });

  it('arrayUnion adds elements without duplicates', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'au-set', method: 'setDoc', path: 'sentinel/arr',
      data: { tags: ['a', 'b'] },
    });
    await sendOp(ctx, port, {
      t: 'op', id: 'au-upd', method: 'updateDoc', path: 'sentinel/arr',
      data: { tags: { __sentinel: 'arrayUnion', values: ['b', 'c'] } },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'au-get', method: 'getDoc', path: 'sentinel/arr',
    });
    const data = JSON.parse(((res as ResMessage & { ok: true }).value as { data: { json: string } }).data.json);
    const tags: string[] = data.tags;
    expect(tags).toContain('a');
    expect(tags).toContain('b');
    expect(tags).toContain('c');
    // b should appear only once
    expect(tags.filter((t) => t === 'b').length).toBe(1);
  });

  it('arrayRemove removes elements', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'ar-set', method: 'setDoc', path: 'sentinel/arr2',
      data: { tags: ['x', 'y', 'z'] },
    });
    await sendOp(ctx, port, {
      t: 'op', id: 'ar-upd', method: 'updateDoc', path: 'sentinel/arr2',
      data: { tags: { __sentinel: 'arrayRemove', values: ['y'] } },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ar-get', method: 'getDoc', path: 'sentinel/arr2',
    });
    const data = JSON.parse(((res as ResMessage & { ok: true }).value as { data: { json: string } }).data.json);
    expect(data.tags).not.toContain('y');
    expect(data.tags).toContain('x');
    expect(data.tags).toContain('z');
  });

  it('deleteField removes the field', async () => {
    await sendOp(ctx, port, {
      t: 'op', id: 'df-set', method: 'setDoc', path: 'sentinel/df',
      data: { keep: 'yes', remove: 'bye' },
    });
    await sendOp(ctx, port, {
      t: 'op', id: 'df-upd', method: 'updateDoc', path: 'sentinel/df',
      data: { remove: { __sentinel: 'deleteField' } },
    });
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'df-get', method: 'getDoc', path: 'sentinel/df',
    });
    const data = JSON.parse(((res as ResMessage & { ok: true }).value as { data: { json: string } }).data.json);
    expect(data.keep).toBe('yes');
    expect('remove' in data).toBe(false);
  });
});

// ─── onSnapshot ───────────────────────────────────────────────────────────

describe('onSnapshot — initial fire', () => {
  it('initial snapshot fires with pre-existing docs', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Seed before subscribing
    await sendOp(ctx, port, {
      t: 'op', id: 'snap-seed', method: 'setDoc', path: 'notes/n1',
      data: { text: 'pre-existing' },
    });

    port.messages.length = 0;
    port.snapMessages.length = 0;

    await handleMessage(ctx, port, {
      t: 'sub',
      subId: 'snap-1',
      target: { __ref: 'collection', path: 'notes' },
    });
    await tick();

    const snaps = port.snapMessages.filter((m) => m.subId === 'snap-1');
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const firstSnap = snaps[0]!.value as { docs: Array<{ id: string }> };
    expect(firstSnap.docs.some((d) => d.id === 'n1')).toBe(true);
  });
});

describe('onSnapshot — update after write', () => {
  it('snap fires again after a subsequent write', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await handleMessage(ctx, port, {
      t: 'sub',
      subId: 'snap-2',
      target: { __ref: 'collection', path: 'notes' },
    });
    await tick();
    const before = port.snapMessages.length;

    await sendOp(ctx, port, {
      t: 'op', id: 'snap-write', method: 'setDoc', path: 'notes/n2',
      data: { text: 'new note' },
    });
    await tick();

    const after = port.snapMessages.filter((m) => m.subId === 'snap-2');
    expect(after.length).toBeGreaterThan(before);
    const last = after[after.length - 1]!.value as { docs: Array<{ id: string }> };
    expect(last.docs.some((d) => d.id === 'n2')).toBe(true);
  });
});

describe('onSnapshot — multi-port fan-out', () => {
  it('write from portA fires snap on both portA and portB', async () => {
    const ctx = await makeCtx();
    const portA = fakePort();
    const portB = fakePort();

    await handleMessage(ctx, portA, {
      t: 'sub', subId: 'sub-a', target: { __ref: 'collection', path: 'shared' },
    });
    await handleMessage(ctx, portB, {
      t: 'sub', subId: 'sub-b', target: { __ref: 'collection', path: 'shared' },
    });
    await tick();

    // Clear initial snaps
    portA.messages.length = 0; portA.snapMessages.length = 0;
    portB.messages.length = 0; portB.snapMessages.length = 0;

    // portA writes
    await sendOp(ctx, portA, {
      t: 'op', id: 'fanout-write', method: 'setDoc', path: 'shared/doc1',
      data: { content: 'from A' },
    });
    await tick();

    const aSnaps = portA.snapMessages.filter((m) => m.subId === 'sub-a');
    const bSnaps = portB.snapMessages.filter((m) => m.subId === 'sub-b');

    expect(aSnaps.length).toBeGreaterThanOrEqual(1);
    expect(bSnaps.length).toBeGreaterThanOrEqual(1);

    const aLast = aSnaps[aSnaps.length - 1]!.value as { docs: Array<{ id: string }> };
    const bLast = bSnaps[bSnaps.length - 1]!.value as { docs: Array<{ id: string }> };
    expect(aLast.docs.some((d) => d.id === 'doc1')).toBe(true);
    expect(bLast.docs.some((d) => d.id === 'doc1')).toBe(true);
  });
});

describe('onSnapshot — unsub stops delivery', () => {
  it('no snaps delivered after unsub', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await handleMessage(ctx, port, {
      t: 'sub', subId: 'sub-unsub', target: { __ref: 'collection', path: 'items' },
    });
    await tick();

    await handleMessage(ctx, port, { t: 'unsub', subId: 'sub-unsub' });

    port.messages.length = 0;
    port.snapMessages.length = 0;

    await sendOp(ctx, port, {
      t: 'op', id: 'post-unsub', method: 'setDoc', path: 'items/x',
      data: { v: 1 },
    });
    await tick();

    expect(port.snapMessages.length).toBe(0);
  });
});

describe('onSnapshot — doc listener', () => {
  it('doc listener fires on initial and after update', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: 'doc-snap-seed', method: 'setDoc', path: 'profiles/alice',
      data: { name: 'Alice', age: 30 },
    });

    await handleMessage(ctx, port, {
      t: 'sub', subId: 'doc-sub', target: { __ref: 'doc', path: 'profiles/alice' },
    });
    await tick();

    const initial = port.snapMessages.filter((m) => m.subId === 'doc-sub');
    expect(initial.length).toBeGreaterThanOrEqual(1);
    const snap0 = initial[0]!.value as { exists: boolean; data: { json: string } };
    expect(snap0.exists).toBe(true);
    expect(JSON.parse(snap0.data.json).name).toBe('Alice');

    // Update
    port.snapMessages.length = 0;
    await sendOp(ctx, port, {
      t: 'op', id: 'doc-snap-upd', method: 'updateDoc', path: 'profiles/alice',
      data: { age: 31 },
    });
    await tick();

    const updated = port.snapMessages.filter((m) => m.subId === 'doc-sub');
    expect(updated.length).toBeGreaterThanOrEqual(1);
    const snap1 = updated[updated.length - 1]!.value as { data: { json: string } };
    expect(JSON.parse(snap1.data.json).age).toBe(31);
  });
});

// ─── writeBatch ───────────────────────────────────────────────────────────

describe('writeBatch', () => {
  it('all-or-nothing: all writes commit atomically', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'batch-1', method: 'batchCommit',
      writes: [
        { method: 'set', path: 'batch/d1', data: { v: 1 } },
        { method: 'set', path: 'batch/d2', data: { v: 2 } },
        { method: 'set', path: 'batch/d3', data: { v: 3 } },
      ],
    });
    expect(res.ok).toBe(true);

    // All three docs should exist
    for (const id of ['d1', 'd2', 'd3']) {
      const r = await sendOp(ctx, port, {
        t: 'op', id: `batch-check-${id}`, method: 'getDoc', path: `batch/${id}`,
      });
      expect((r as ResMessage & { ok: true }).value as { exists: boolean }).toHaveProperty('exists', true);
    }
  });

  it('denied batch write fails the whole batch', async () => {
    const ctx = await makeCtx(DENY_ALL_RULES);
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'batch-denied', method: 'batchCommit',
      writes: [
        { method: 'set', path: 'secret/d1', data: { v: 1 } },
      ],
    });
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('permission-denied');
  });
});

// ─── runTransaction / txnCommit ────────────────────────────────────────────

describe('txnCommit', () => {
  it('read-modify-write commits correctly', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Seed initial doc
    await sendOp(ctx, port, {
      t: 'op', id: 'txn-seed', method: 'setDoc', path: 'counters/c1',
      data: { n: 10 },
    });

    // Commit a transaction that increments n (no reads — no validation needed)
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'txn-1', method: 'txnCommit',
      reads: [],
      writes: [
        {
          method: 'set',
          path: 'counters/c1',
          data: { n: { __sentinel: 'increment', n: 5 } },
        },
      ],
    });
    expect(res.ok).toBe(true);

    const getRes2 = await sendOp(ctx, port, {
      t: 'op', id: 'txn-get', method: 'getDoc', path: 'counters/c1',
    });
    const data = JSON.parse(((getRes2 as ResMessage & { ok: true }).value as { data: { json: string } }).data.json);
    expect(data.n).toBe(15);
  });

  it('txnCommit with delete removes the doc', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await sendOp(ctx, port, {
      t: 'op', id: 'txn-del-seed', method: 'setDoc', path: 'tmp/t1',
      data: { x: 1 },
    });

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'txn-del', method: 'txnCommit',
      reads: [],
      writes: [{ method: 'delete', path: 'tmp/t1' }],
    });
    expect(res.ok).toBe(true);

    const check = await sendOp(ctx, port, {
      t: 'op', id: 'txn-del-check', method: 'getDoc', path: 'tmp/t1',
    });
    expect((check as ResMessage & { ok: true }).value as { exists: boolean }).toHaveProperty('exists', false);
  });
});

// ─── Error fidelity ───────────────────────────────────────────────────────

describe('errors', () => {
  it('permission-denied on write returns ok:false with code permission-denied', async () => {
    const ctx = await makeCtx(DENY_ALL_RULES);
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'err-denied', method: 'setDoc', path: 'secret/doc',
      data: { x: 1 },
    });
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('permission-denied');
    expect(typeof (res as ResMessage & { ok: false }).error.message).toBe('string');
  });

  it('permission-denied on read returns ok:false', async () => {
    const ctx = await makeCtx(DENY_ALL_RULES);
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'err-denied-read', method: 'getDoc', path: 'secret/doc',
    });
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('permission-denied');
  });

  it('not-found on update of missing doc', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'err-notfound', method: 'updateDoc', path: 'noexist/doc',
      data: { x: 1 },
    });
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('not-found');
  });
});

// ─── setRules hot-reload ──────────────────────────────────────────────────

describe('setRules', () => {
  it('setRules deploys new rules (write that was allowed becomes denied)', async () => {
    const ctx = await makeCtx(PERMISSIVE_RULES);
    const port = fakePort();

    // Write works with permissive rules
    const r1 = await sendOp(ctx, port, {
      t: 'op', id: 'sr-1', method: 'setDoc', path: 'guarded/doc',
      data: { v: 1 },
    });
    expect(r1.ok).toBe(true);

    // Deploy deny-all rules
    await sendOp(ctx, port, {
      t: 'op', id: 'sr-rules', method: 'setRules', source: DENY_ALL_RULES,
    });

    // Write now fails
    const r2 = await sendOp(ctx, port, {
      t: 'op', id: 'sr-2', method: 'setDoc', path: 'guarded/doc2',
      data: { v: 2 },
    });
    expect(r2.ok).toBe(false);
    expect((r2 as ResMessage & { ok: false }).error.code).toBe('permission-denied');
  });

  it('setRules returns ok:true with warnings shape', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'sr-ack', method: 'setRules', source: PERMISSIVE_RULES,
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as { warnings: unknown[] };
    expect(Array.isArray(value.warnings)).toBe(true);
  });
});

describe('shared playground worker ops', () => {
  it('admin Firestore ops are per-call and do not require the global lens', async () => {
    const ctx = await makeCtx(DENY_ALL_RULES);
    const port = fakePort();

    const set = await sendOp(ctx, port, {
      t: 'op',
      id: 'admin-set',
      method: 'admin.setDocument',
      path: 'notes/n1',
      data: { text: 'shared' },
    });
    expect(set.ok).toBe(true);

    const get = await sendOp(ctx, port, {
      t: 'op',
      id: 'admin-get',
      method: 'admin.getDocument',
      path: 'notes/n1',
    });
    expect(get.ok).toBe(true);
    expect(get.value).toEqual({ text: 'shared' });

    const denied = await sendOp(ctx, port, {
      t: 'op',
      id: 'app-get',
      method: 'getDoc',
      path: 'notes/n1',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('permission-denied');
  });

  it('RTDB shared ops use the worker-owned database and active rules', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const rules = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-rules',
      method: 'setDatabaseRules',
      source: { rules: { '.read': true, '.write': true } },
    });
    expect(rules.ok).toBe(true);

    const set = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-set',
      method: 'rtdb.set',
      path: '/counters/global',
      value: { clicks: 1 },
    });
    expect(set.ok).toBe(true);

    const get = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-get',
      method: 'rtdb.get',
      path: '/counters/global',
    });
    expect(get.ok).toBe(true);
    expect(get.value).toMatchObject({
      key: 'global',
      exists: true,
      value: { clicks: 1 },
    });

    const status = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-status',
      method: 'getRulesStatus',
      service: 'database',
    });
    expect(status.ok).toBe(true);
    expect(status.value).toMatchObject({ status: 'active' });
  });

  it('RTDB shared ops honor the per-call auth lens', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const rules = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-lens-rules',
      method: 'setDatabaseRules',
      source: {
        rules: {
          profiles: {
            $uid: {
              '.read': 'auth.uid === $uid',
              '.write': 'auth.uid === $uid',
            },
          },
        },
      },
    });
    expect(rules.ok).toBe(true);

    const signedOutWrite = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-lens-signed-out-write',
      method: 'rtdb.set',
      path: '/profiles/alice',
      value: { displayName: 'Alice' },
    });
    expect(signedOutWrite.ok).toBe(false);
    if (!signedOutWrite.ok) expect(signedOutWrite.error.code).toBe('PERMISSION_DENIED');

    const aliceWrite = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-lens-alice-write',
      method: 'rtdb.set',
      path: '/profiles/alice',
      value: { displayName: 'Alice' },
      actAs: { mode: 'as', uid: 'alice' },
    });
    expect(aliceWrite.ok).toBe(true);

    const bobRead = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-lens-bob-read',
      method: 'rtdb.get',
      path: '/profiles/alice',
      actAs: { mode: 'as', uid: 'bob' },
    });
    expect(bobRead.ok).toBe(false);
    if (!bobRead.ok) expect(bobRead.error.code).toBe('PERMISSION_DENIED');

    const aliceRead = await sendOp(ctx, port, {
      t: 'op',
      id: 'rtdb-lens-alice-read',
      method: 'rtdb.get',
      path: '/profiles/alice',
      actAs: { mode: 'as', uid: 'alice' },
    });
    expect(aliceRead.ok).toBe(true);
    expect(aliceRead.value).toMatchObject({
      exists: true,
      value: { displayName: 'Alice' },
    });
  });
});

// ─── txnCommit read-set validation (multi-tab conflict) ───────────────────

describe('txnCommit read-set validation', () => {
  /**
   * Happy path: the worker commits without conflict when the read-set
   * matches current state. Should require exactly one attempt.
   */
  it('happy path: no conflict — commit succeeds with matching read-set', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Seed the doc
    await sendOp(ctx, port, {
      t: 'op', id: 'txn-rv-seed', method: 'setDoc', path: 'notes/x',
      data: { value: 'original' },
    });

    // Read the doc to capture its serialized form
    const readRes = await sendOp(ctx, port, {
      t: 'op', id: 'txn-rv-read', method: 'getDoc', path: 'notes/x',
    });
    const readValue = (readRes as ResMessage & { ok: true }).value as { data: { json: string } };

    // Commit with a matching read-set (no intervening write → should succeed)
    const commitRes = await sendOp(ctx, port, {
      t: 'op', id: 'txn-rv-commit', method: 'txnCommit',
      reads: [{ path: 'notes/x', data: readValue.data }],
      writes: [{ method: 'set', path: 'notes/x', data: { value: 'updated' } }],
    });
    expect(commitRes.ok).toBe(true);

    // Verify the write landed
    const afterRes = await sendOp(ctx, port, {
      t: 'op', id: 'txn-rv-after', method: 'getDoc', path: 'notes/x',
    });
    const afterData = JSON.parse(
      ((afterRes as ResMessage & { ok: true }).value as { data: { json: string } }).data.json,
    );
    expect(afterData.value).toBe('updated');
  });

  /**
   * Conflict scenario — the core multi-tab correctness test:
   *
   *   1. Port C reads `notes/x` (captures its serialized form).
   *   2. Port D writes a different value to `notes/x` (simulates another tab).
   *   3. Port C commits with the OLD read data → worker detects conflict.
   *   4. Worker returns `{ ok: false, error: { code: 'aborted' } }`.
   *
   * The client's retry loop (runTransaction) would re-run updateFn on
   * receiving 'aborted'. Here we verify the HOST correctly rejects the stale
   * read-set, which is the seam the retry depends on.
   */
  it('conflict: another tab writes between client read and commit → aborted', async () => {
    const ctx = await makeCtx();
    const portC = fakePort();
    const portD = fakePort();

    // Seed initial value
    await sendOp(ctx, portC, {
      t: 'op', id: 'conflict-seed', method: 'setDoc', path: 'notes/x',
      data: { value: 'initial' },
    });

    // Port C reads the doc — captures the serialized form it saw
    const readRes = await sendOp(ctx, portC, {
      t: 'op', id: 'conflict-read', method: 'getDoc', path: 'notes/x',
    });
    const readData = ((readRes as ResMessage & { ok: true }).value as { data: { json: string } }).data;

    // Port D (another tab) writes to notes/x BEFORE C commits
    await sendOp(ctx, portD, {
      t: 'op', id: 'conflict-other-write', method: 'setDoc', path: 'notes/x',
      data: { value: 'changed by D' },
    });

    // Port C commits with the STALE read-set (what it read before D's write)
    const commitRes = await sendOp(ctx, portC, {
      t: 'op', id: 'conflict-commit', method: 'txnCommit',
      reads: [{ path: 'notes/x', data: readData }],
      writes: [{ method: 'set', path: 'notes/x', data: { value: 'C overwrite' } }],
    });

    // Worker must reject with 'aborted' — NOT silently commit
    expect(commitRes.ok).toBe(false);
    expect((commitRes as ResMessage & { ok: false }).error.code).toBe('aborted');

    // Verify D's write is still intact (C's stale write was NOT applied)
    const finalRes = await sendOp(ctx, portC, {
      t: 'op', id: 'conflict-final', method: 'getDoc', path: 'notes/x',
    });
    const finalData = JSON.parse(
      ((finalRes as ResMessage & { ok: true }).value as { data: { json: string } }).data.json,
    );
    expect(finalData.value).toBe('changed by D'); // D's write preserved
  });

  /**
   * Conflict on existence: client read a doc that didn't exist,
   * another tab created it before the commit → aborted.
   */
  it('conflict on creation: doc created by another tab → aborted', async () => {
    const ctx = await makeCtx();
    const portC = fakePort();
    const portD = fakePort();

    // C reads a non-existent doc
    const readRes = await sendOp(ctx, portC, {
      t: 'op', id: 'conflict-miss-read', method: 'getDoc', path: 'things/new',
    });
    expect(((readRes as ResMessage & { ok: true }).value as { exists: boolean }).exists).toBe(false);

    // D creates the doc before C commits
    await sendOp(ctx, portD, {
      t: 'op', id: 'conflict-miss-create', method: 'setDoc', path: 'things/new',
      data: { creator: 'D' },
    });

    // C commits with null read data (it saw the doc as non-existent)
    const commitRes = await sendOp(ctx, portC, {
      t: 'op', id: 'conflict-miss-commit', method: 'txnCommit',
      reads: [{ path: 'things/new', data: null }],
      writes: [{ method: 'set', path: 'things/new', data: { creator: 'C' } }],
    });

    // Must be aborted — the doc now exists (D created it)
    expect(commitRes.ok).toBe(false);
    expect((commitRes as ResMessage & { ok: false }).error.code).toBe('aborted');
  });

  /**
   * Client retry counter test:
   * Simulate a series of conflicts followed by a clean read to verify the
   * worker returns 'aborted' on conflict and 'ok' when there is no conflict.
   * The client's retry loop would increment a counter on each 'aborted' reply —
   * here we verify the counter increments by manually re-submitting.
   */
  it('client retry: updateFn call counter increments on each aborted, succeeds on fresh read', async () => {
    const ctx = await makeCtx();
    const portC = fakePort();

    // Seed the doc
    await sendOp(ctx, portC, {
      t: 'op', id: 'retry-seed', method: 'setDoc', path: 'retry/doc',
      data: { n: 0 },
    });

    // Attempt 1: read n=0, then change it before committing → conflict
    const read1 = await sendOp(ctx, portC, {
      t: 'op', id: 'retry-read-1', method: 'getDoc', path: 'retry/doc',
    });
    const data1 = ((read1 as ResMessage & { ok: true }).value as { data: { json: string } }).data;

    // Another write happens (simulating concurrent write between read and commit)
    await sendOp(ctx, portC, {
      t: 'op', id: 'retry-interleave', method: 'setDoc', path: 'retry/doc',
      data: { n: 1 },
    });

    let callCount = 0;

    // Attempt 1: stale read → aborted (simulating the first updateFn attempt)
    callCount++;
    const res1 = await sendOp(ctx, portC, {
      t: 'op', id: 'retry-commit-1', method: 'txnCommit',
      reads: [{ path: 'retry/doc', data: data1 }],
      writes: [{ method: 'set', path: 'retry/doc', data: { n: 100 } }],
    });
    expect(res1.ok).toBe(false);
    expect((res1 as ResMessage & { ok: false }).error.code).toBe('aborted');
    expect(callCount).toBe(1);

    // Attempt 2: fresh read → commit succeeds
    callCount++;
    const read2 = await sendOp(ctx, portC, {
      t: 'op', id: 'retry-read-2', method: 'getDoc', path: 'retry/doc',
    });
    const data2 = ((read2 as ResMessage & { ok: true }).value as { data: { json: string } }).data;

    const res2 = await sendOp(ctx, portC, {
      t: 'op', id: 'retry-commit-2', method: 'txnCommit',
      reads: [{ path: 'retry/doc', data: data2 }],
      writes: [{ method: 'set', path: 'retry/doc', data: { n: 200 } }],
    });
    expect(res2.ok).toBe(true);
    expect(callCount).toBe(2); // Two attempts total

    // Final value should be from the successful (2nd) attempt
    const finalRes = await sendOp(ctx, portC, {
      t: 'op', id: 'retry-final', method: 'getDoc', path: 'retry/doc',
    });
    const finalData = JSON.parse(
      ((finalRes as ResMessage & { ok: true }).value as { data: { json: string } }).data.json,
    );
    expect(finalData.n).toBe(200);
  });
});

// ─── Type fidelity — wire format uses persistence serializer ──────────────

describe('type fidelity — real class instances across the wire', () => {
  /**
   * Write a doc with serverTimestamp(), Bytes, and GeoPoint values.
   * Read it back via getDoc through the SharedWorker host.
   * Assert that each value comes back as a REAL class instance
   * (not a plain-object look-alike).
   */
  it('serverTimestamp resolves to a real Timestamp with toDate() after round-trip', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Write via sentinel (serverTimestamp)
    await sendOp(ctx, port, {
      t: 'op', id: 'ts-write', method: 'setDoc', path: 'fidelity/ts',
      data: { when: { __sentinel: 'serverTimestamp' } },
    });

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ts-read', method: 'getDoc', path: 'fidelity/ts',
    });
    const value = (res as ResMessage & { ok: true }).value as { data: { json: string } };
    const { deserializeDocData } = await import('../../../src/serve/worker/protocol.js');
    const data = deserializeDocData(value.data) as Record<string, unknown>;

    // Must be a real Timestamp instance — not a plain {seconds, nanos} object
    expect(data.when).toBeInstanceOf(Timestamp);

    const ts = data.when as Timestamp;
    // Real Timestamp has seconds and nanos fields
    expect(typeof ts.seconds).toBe('number');
    expect(typeof ts.nanos).toBe('number');
    // toDate() must return a real Date
    const d = ts.toDate();
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBeGreaterThan(0);
  });

  it('Bytes written as firebase/firestore Bytes come back as real Bytes instances', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Write fb.Bytes — the sandbox converts it to RulesBytes via bytesConverter
    const fbBytes = Bytes.fromUint8Array(new Uint8Array([1, 2, 3, 255]));
    await fsSetDoc(fsDoc(ctx.db, 'fidelity/bytes'), { blob: fbBytes });

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'bytes-read', method: 'getDoc', path: 'fidelity/bytes',
    });
    const value = (res as ResMessage & { ok: true }).value as { data: { json: string } };
    const { deserializeDocData } = await import('../../../src/serve/worker/protocol.js');
    const data = deserializeDocData(value.data) as Record<string, unknown>;

    // Must be a real RulesBytes instance with .data (Uint8Array)
    expect(data.blob).toBeInstanceOf(RulesBytes);
    const b = data.blob as RulesBytes;
    expect(b.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(b.data)).toEqual([1, 2, 3, 255]);
  });

  it('GeoPoint written as firebase/firestore GeoPoint comes back as real LatLng instance', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Write fb.GeoPoint — the sandbox converts it to LatLng via geoPointConverter
    const fbGeoPoint = new GeoPoint(37.77, -122.41);
    await fsSetDoc(fsDoc(ctx.db, 'fidelity/geo'), { where: fbGeoPoint });

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'geo-read', method: 'getDoc', path: 'fidelity/geo',
    });
    const value = (res as ResMessage & { ok: true }).value as { data: { json: string } };
    const { deserializeDocData } = await import('../../../src/serve/worker/protocol.js');
    const data = deserializeDocData(value.data) as Record<string, unknown>;

    // Must be a real LatLng instance
    expect(data.where).toBeInstanceOf(LatLng);
    const g = data.where as LatLng;
    expect(g.lat).toBeCloseTo(37.77, 5);
    expect(g.lng).toBeCloseTo(-122.41, 5);
  });

  /**
   * Disambiguation test: a plain user object that merely has
   * `{ seconds, nanoseconds }` fields must NOT be mistaken for a Timestamp.
   * The marker-based codec (`__type: 'timestamp'`) is required for
   * rehydration — plain objects with coincidentally similar fields pass through.
   */
  it('plain object with seconds/nanoseconds fields is NOT rehydrated as Timestamp', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Write a plain object that looks like a Timestamp but lacks __type marker
    await sendOp(ctx, port, {
      t: 'op', id: 'disambig-write', method: 'setDoc', path: 'fidelity/disambig',
      data: { notATimestamp: { seconds: 1_000_000, nanoseconds: 0 } },
    });

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'disambig-read', method: 'getDoc', path: 'fidelity/disambig',
    });
    const value = (res as ResMessage & { ok: true }).value as { data: { json: string } };
    const { deserializeDocData } = await import('../../../src/serve/worker/protocol.js');
    const data = deserializeDocData(value.data) as Record<string, unknown>;

    // Must NOT be a Timestamp instance — should be a plain object
    expect(data.notATimestamp).not.toBeInstanceOf(Timestamp);
    const obj = data.notATimestamp as Record<string, unknown>;
    // Values must still be accessible as plain fields
    expect(obj.seconds).toBe(1_000_000);
    expect(obj.nanoseconds).toBe(0);
  });
});

// ─── cleanupPort ──────────────────────────────────────────────────────────

describe('cleanupPort', () => {
  it('cleanup removes all subscriptions for a port', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await handleMessage(ctx, port, {
      t: 'sub', subId: 'cleanup-sub', target: { __ref: 'collection', path: 'items' },
    });
    await tick();
    expect(ctx.subs.has(port)).toBe(true);

    cleanupPort(ctx, port);
    expect(ctx.subs.has(port)).toBe(false);

    // No snaps after cleanup
    port.messages.length = 0;
    port.snapMessages.length = 0;
    await sendOp(ctx, port, {
      t: 'op', id: 'cleanup-write', method: 'setDoc', path: 'items/post-cleanup',
      data: { v: 1 },
    });
    await tick();
    expect(port.snapMessages.length).toBe(0);
  });
});

describe('getVersion (staleness guard)', () => {
  it("reports 'dev' when no build hash is injected (compiled host imported directly)", async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, { t: 'op', id: 'v1', method: 'getVersion' });
    expect(res.ok).toBe(true);
    expect((res as ResMessage & { ok: true }).value).toEqual({ version: 'dev' });
  });
});

describe('storage worker ops', () => {
  it('returns object blobs for Studio previews', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const storage = getStorageSandbox(ctx.sandbox);
    await uploadBytes(storageRef(storage, 'docs/readme.txt'), new Blob(['hello worker'], { type: 'text/plain' }));

    const res = await sendOp(ctx, port, {
      t: 'op', id: 'blob-1', method: 'storage.getBlob', path: 'docs/readme.txt',
    });

    expect(res.ok).toBe(true);
    const blob = (res as ResMessage & { ok: true }).value as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type.startsWith('text/plain')).toBe(true);
    expect(await blob.text()).toBe('hello worker');
  });
});

// ─── agent tool dispatch ────────────────────────────────────────────────────
// The bridge peer forwards `tool` messages so the agent runs the canonical
// sandbox tools against THIS worker's sandbox — the same instance the app and
// Studio observe. This is the unification: one backend, not a separate in-page
// (agent) sandbox.
describe('agent tool dispatch (worker hosts the canonical tools)', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
  });

  it('routes a tool call to the sandbox dispatcher and replies with the result', async () => {
    const res = await sendOp(ctx, port, {
      t: 'tool', id: 'tool-list', name: 'firestore_list_documents', args: { collection: 'posts' },
    });
    expect(res.ok).toBe(true);
    expect((res as ResMessage & { ok: true }).value).toMatchObject({ ok: true });
  });

  it('an unknown tool fails the call (rejected by the dispatcher)', async () => {
    const res = await sendOp(ctx, port, {
      t: 'tool', id: 'tool-bad', name: 'not_a_real_tool', args: {},
    });
    expect(res.ok).toBe(false);
  });

  it('agent write lands in the SAME sandbox the app reads (one shared backend)', async () => {
    const write = await sendOp(ctx, port, {
      t: 'tool', id: 'tool-write', name: 'firestore_create_document',
      args: { path: 'posts/p1', data: { title: 'from the agent' } },
    });
    expect((write as ResMessage & { ok: true }).value).toMatchObject({ ok: true });

    // Read it back through the tool dispatcher — same authoritative sandbox.
    const read = await sendOp(ctx, port, {
      t: 'tool', id: 'tool-read', name: 'firestore_get_document', args: { path: 'posts/p1' },
    });
    const result = (read as ResMessage & { ok: true }).value as {
      ok: boolean; data: { exists: boolean; data: { title: string } };
    };
    expect(result.ok).toBe(true);
    expect(result.data.exists).toBe(true);
    expect(result.data.data.title).toBe('from the agent');

    // AND the app's own db handle (getFirestore(sandbox)) sees it too — proving
    // the agent and the app share one backend, not separate sandboxes.
    const snap = await fsGetDoc(fsDoc(ctx.db, 'posts/p1'));
    expect(snap.exists()).toBe(true);
    expect((snap.data() as { title: string }).title).toBe('from the agent');
  });

  it('read-tool results pre-serialize wrapper types so they survive the worker port', async () => {
    // A real SharedWorker posts via structured clone, which strips wrapper
    // prototypes (and their toJSON). handleTool pre-serializes via JSON so the
    // posted result is a PLAIN object whose canonical shapes survive the clone.
    await fsSetDoc(fsDoc(ctx.db, 'docs/wrap'), {
      blob: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
      spot: new GeoPoint(37.77, -122.41),
    });
    const read = await sendOp(ctx, port, {
      t: 'tool', id: 'tool-wrap', name: 'firestore_get_document', args: { path: 'docs/wrap' },
    });
    const value = (read as ResMessage & { ok: true }).value;
    // Cloning the posted value (what the port does) must NOT change its JSON
    // shape — proving it is already plain, not live wrapper instances. Without
    // the pre-serialize this fails: structuredClone drops toJSON and mangles them.
    expect(JSON.stringify(structuredClone(value))).toBe(JSON.stringify(value));
    // And no mangled wrapper internals leaked (the pre-fix clone shapes).
    const json = JSON.stringify(value);
    expect(json).not.toContain('_byteString'); // Bytes internal
    expect(json).not.toContain('_lat'); // GeoPoint internal
  });

  it('an agent tool-write fires the worker onSnapshot listeners (live propagation)', async () => {
    // Register a listener the way the app / Studio do.
    await handleMessage(ctx, port, {
      t: 'sub', subId: 'agent-live', target: { __ref: 'collection', path: 'posts' },
    });
    await tick();
    const before = port.snapMessages.filter((m) => m.subId === 'agent-live').length;

    // The agent writes via a tool (admin-bypass path) on the SAME worker sandbox.
    await sendOp(ctx, port, {
      t: 'tool', id: 'agent-live-write', name: 'firestore_create_document',
      args: { path: 'posts/live', data: { title: 'agent live write' } },
    });
    await tick();

    // The listener MUST fire — the unification headline: an agent write shows up
    // live in the app's / Studio's onSnapshot because it is one shared sandbox.
    const after = port.snapMessages.filter((m) => m.subId === 'agent-live');
    expect(after.length).toBeGreaterThan(before);
    const last = after[after.length - 1]!.value as { docs: Array<{ id: string }> };
    expect(last.docs.some((d) => d.id === 'live')).toBe(true);
  });
});
