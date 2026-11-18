/**
 * Multi-field `aggregate` op — count / sum / average (remote sandbox slice 2;
 * spike gap 2).
 *
 * The pyric-admin surface (`admin-compat/types.ts` `Query.aggregate` with
 * `{ kind: 'count' | 'sum' | 'average' }` fields) needs more than the
 * count-only op, so the protocol gains `{ method: 'aggregate', source, spec }`
 * where `spec` is structurally `pyric/firestore`'s `AggregateSpec` (plain
 * JSON). Frames are JSON-round-tripped (the WS legs). Covers aliased
 * multi-field specs, aggregates over constrained + composite-filtered
 * queries, and empty-input semantics (count 0 / sum 0 / average null).
 */

import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import {
  decodeAggregateData,
  type InboundMessage,
  type OutboundMessage,
  type ResMessage,
  type TargetDescriptor,
  type AggregateSpecDescriptor,
} from '../../../src/serve/worker/protocol.js';
import { count, sum, average } from '../../../src/serve/worker/client.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const PERMISSIVE_RULES = `rules_version = '2';
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
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'aggregates-test', subs: new Map() };
}

function tick(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }

let _seq = 0;
function id(): string { return `agg-op-${++_seq}`; }

function overWire<T>(frame: T): T { return JSON.parse(JSON.stringify(frame)) as T; }

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, overWire(msg));
  await tick();
  const opId = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
  if (!res) throw new Error(`No res for ${opId}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

async function seedItems(ctx: HostCtx, port: FakePort): Promise<void> {
  const docs: Array<[string, Record<string, unknown>]> = [
    ['a', { cat: 'x', n: 1 }],
    ['b', { cat: 'x', n: 5 }],
    ['c', { cat: 'y', n: 5 }],
    ['d', { cat: 'z', n: 9 }],
  ];
  for (const [docId, data] of docs) {
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: `items/${docId}`, data,
    }));
  }
}

async function aggregate(
  ctx: HostCtx,
  port: FakePort,
  source: TargetDescriptor,
  spec: AggregateSpecDescriptor,
): Promise<Record<string, number | null>> {
  const res = okValue<{ data: Record<string, number | null> }>(await sendOp(ctx, port, {
    t: 'op', id: id(), method: 'aggregate', source, spec,
  }));
  return res.data;
}

const ITEMS: TargetDescriptor = { __ref: 'collection', path: 'items' };

describe('aggregate op (count / sum / average)', () => {
  it('multi-field aliased spec over a collection', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    // The client factories emit exactly the wire descriptors.
    const data = await aggregate(ctx, port, ITEMS, {
      rows: count(),
      total: sum('n'),
      avg: average('n'),
    });
    expect(data).toEqual({ rows: 4, total: 20, avg: 5 });
  });

  it('aggregates respect query constraints, including composite filters', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    const filtered: TargetDescriptor = {
      __ref: 'query',
      source: ITEMS,
      constraints: [{
        kind: 'or',
        filters: [
          { kind: 'where', field: 'cat', op: '==', value: 'x' },
          { kind: 'where', field: 'cat', op: '==', value: 'z' },
        ],
      }],
    };
    const data = await aggregate(ctx, port, filtered, {
      rows: count(), total: sum('n'), avg: average('n'),
    });
    expect(data).toEqual({ rows: 3, total: 15, avg: 5 });
  });

  it('empty input: count 0, sum 0, average null', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    const none: TargetDescriptor = {
      __ref: 'query',
      source: ITEMS,
      constraints: [{ kind: 'where', field: 'cat', op: '==', value: 'nope' }],
    };
    const data = await aggregate(ctx, port, none, {
      rows: count(), total: sum('n'), avg: average('n'),
    });
    expect(data).toEqual({ rows: 0, total: 0, avg: null });
  });

  it('pairs count() with sum(y) over only docs that carry y (FL-27)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const docs: Array<[string, Record<string, unknown>]> = [
      ['a', { x: 1, y: 10 }],
      ['b', { x: 2 }],
      ['c', { y: 5 }],
      ['d', { x: 3, y: 1 }],
    ];
    for (const [docId, data] of docs) {
      okValue(await sendOp(ctx, port, {
        t: 'op', id: id(), method: 'setDoc', path: `sparse/${docId}`, data,
      }));
    }

    const sparse: TargetDescriptor = { __ref: 'collection', path: 'sparse' };
    const countOnly = await aggregate(ctx, port, sparse, { n: count() });
    expect(countOnly).toEqual({ n: 4 });

    const paired = await aggregate(ctx, port, sparse, { n: count(), sy: sum('y') });
    expect(paired).toEqual({ n: 3, sy: 16 });
  });

  it('preserves NaN, Infinity, -Infinity, and -0 across JSON wire replies (FL-28)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await ctx.sandbox.withAuth(null);
    const { setDoc, doc } = await import('pyric/firestore');
    await setDoc(doc(ctx.db, 'agnan/1'), { v: 1 });
    await setDoc(doc(ctx.db, 'agnan/2'), { v: Number.NaN });
    await setDoc(doc(ctx.db, 'agnan/3'), { v: 2 });
    await setDoc(doc(ctx.db, 'aginf/1'), { v: 1 });
    await setDoc(doc(ctx.db, 'aginf/2'), { v: Infinity });
    await setDoc(doc(ctx.db, 'agneginf/1'), { v: 1 });
    await setDoc(doc(ctx.db, 'agneginf/2'), { v: -Infinity });

    const nanRes = overWire(await sendOp(ctx, port, {
      t: 'op',
      id: id(),
      method: 'aggregate',
      source: { __ref: 'collection', path: 'agnan' },
      spec: { s: sum('v'), a: average('v'), n: count() },
    }));
    const nanWire = okValue<{ data: Record<string, number | null>; encodedData?: Record<string, unknown> }>(nanRes);
    expect(nanWire.data).toEqual({ s: null, a: null, n: 3 });
    const nanDecoded = decodeAggregateData(nanWire.data, nanWire.encodedData);
    expect(nanDecoded.n).toBe(3);
    expect(Number.isNaN(nanDecoded.s)).toBe(true);
    expect(Number.isNaN(nanDecoded.a)).toBe(true);

    const infRes = overWire(await sendOp(ctx, port, {
      t: 'op',
      id: id(),
      method: 'aggregate',
      source: { __ref: 'collection', path: 'aginf' },
      spec: { s: sum('v'), a: average('v'), n: count() },
    }));
    const infWire = okValue<{ data: Record<string, number | null>; encodedData?: Record<string, unknown> }>(infRes);
    expect(decodeAggregateData(infWire.data, infWire.encodedData)).toEqual({
      s: Infinity,
      a: Infinity,
      n: 2,
    });

    const negInfRes = overWire(await sendOp(ctx, port, {
      t: 'op',
      id: id(),
      method: 'aggregate',
      source: { __ref: 'collection', path: 'agneginf' },
      spec: { s: sum('v'), a: average('v'), n: count() },
    }));
    const negInfWire = okValue<{ data: Record<string, number | null>; encodedData?: Record<string, unknown> }>(negInfRes);
    expect(decodeAggregateData(negInfWire.data, negInfWire.encodedData)).toEqual({
      s: -Infinity,
      a: -Infinity,
      n: 2,
    });
  });
});
